#!/usr/bin/env node

"use strict";

require("dotenv").config();

const crypto = require("crypto");
const { chromium } = require("playwright-core");
const pool = require("./db/db");
const normalizeCity = require("./normalizeCity");

const TABLE_NAME = "unfiltered_general_contracting";

const SEARCH_RUNS_TABLE = "gc_search_runs";
const SEARCH_RESULTS_TABLE = "gc_search_results";

const ENRICHMENT_ENDPOINT_PATH = "/run";

const CRM_API_BASE_URL =
    process.env.CRM_API_BASE_URL ||
    "http://ftn-enrichment.railway.internal:8080";

const MAX_POSTS_PER_TERM = Number(
    process.env.GENERAL_CONTRACTING_MAX_POSTS || 50,
);

const FALLBACK_STATE =
    process.env.GENERAL_CONTRACTING_FALLBACK_STATE || "TX";

const SEARCH_HISTORY_DAYS = Math.max(
    7,
    Number(process.env.GC_SEARCH_HISTORY_DAYS || 30),
);

const SONAR_COOLDOWN_DAYS = Math.max(
    1,
    Number(process.env.GC_SONAR_COOLDOWN_DAYS || 5),
);

const WINNER_TERM_COUNT = Math.max(
    0,
    Number(process.env.GC_WINNER_TERM_COUNT || 4),
);

const SONAR_TERM_COUNT = Math.max(
    0,
    Number(process.env.GC_SONAR_TERM_COUNT || 6),
);

const PPLX_API_KEY =
    process.env.PPLX_API_KEY ||
    process.env.PERPLEXITY_API_KEY ||
    "";

const PPLX_API_URL =
    process.env.PPLX_API_URL ||
    "https://api.perplexity.ai/chat/completions";

const PPLX_MODEL =
    process.env.PPLX_MODEL ||
    "sonar";

const DEFAULT_ANCHOR_TERMS = [
    "general contractor",
    "contractor recommendation",
    "remodeling contractor",
    "foundation repair",
    "home remodel",
];

const DEFAULT_EXPLORATION_TERMS = [
    "foundation contractor",
    "structural repair",
    "concrete contractor",
    "home addition",
    "room addition",
    "kitchen remodel",
    "bathroom remodel",
    "whole house remodel",
    "garage conversion",
    "load bearing wall",
    "patio cover contractor",
    "deck builder",
    "deck contractor",
    "fence contractor",
    "siding contractor",
    "exterior renovation",
    "interior remodeling",
    "drywall contractor",
    "framing contractor",
    "home renovation",
    "contractor recommendations",
    "renovation contractor",
    "porch builder",
    "pergola contractor",
    "masonry contractor",
    "retaining wall contractor",
    "custom carpentry",
    "water damage repair",
    "storm damage contractor",
    "fire damage repair",
];

function parseConfiguredTerms(value, fallback) {
    if (!value) return [...fallback];

    const terms = String(value)
        .split(/[\n,|]/)
        .map((term) => cleanText(term))
        .filter(Boolean);

    return terms.length ? terms : [...fallback];
}

const ANCHOR_TERMS = parseConfiguredTerms(
    process.env.GC_ANCHOR_TERMS,
    DEFAULT_ANCHOR_TERMS,
);

const SEARCH_PAGE_MAX_ATTEMPTS = Math.max(
    1,
    Number(process.env.SEARCH_PAGE_MAX_ATTEMPTS || 3),
);

const DETAIL_PAGE_MAX_ATTEMPTS = Math.max(
    1,
    Number(process.env.DETAIL_PAGE_MAX_ATTEMPTS || 2),
);

const SEARCH_READY_TIMEOUT_MS = Math.max(
    10_000,
    Number(process.env.SEARCH_READY_TIMEOUT_MS || 25_000),
);

const PAGE_DEFAULT_TIMEOUT_MS = Math.max(
    10_000,
    Number(process.env.PAGE_DEFAULT_TIMEOUT_MS || 30_000),
);

const PAGE_NAVIGATION_TIMEOUT_MS = Math.max(
    20_000,
    Number(process.env.PAGE_NAVIGATION_TIMEOUT_MS || 60_000),
);

const BLOCKED_RESOURCE_TYPES = new Set([
    "image",
    "media",
    "font",
]);

const BLOCKED_REQUEST_URL_PATTERN =
    /(?:doubleclick\.net|googlesyndication\.com|googleadservices\.com|2mdn\.net|amazon-adsystem\.com|adnxs\.com|adsystem\.com|simgad)/i;

const IGNORED_PAGE_ERROR_PATTERN =
    /(?:A network error occurred|Failed to load:|Failed to fetch|buildAdSlot is not defined|buildGlaurungAds is not defined|adSlot is not defined|Class extends value undefined|_\.t is not a function)/i;

const TARGET_CRASH_PATTERN =
    /page crashed|target crashed|renderer process crashed/i;

const BROWSER_DISCONNECTED_PATTERN =
    /browser.*disconnected|browser has been closed|connection closed|websocket.*closed/i;

let browserDisconnected = false;
let asynchronousTargetCrashCount = 0;

const sleep = (ms) =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

function getErrorMessage(error) {
    return error?.message || String(error || "Unknown error");
}

function isTargetCrashError(error) {
    return TARGET_CRASH_PATTERN.test(getErrorMessage(error));
}

function isBrowserDisconnectedError(error) {
    return BROWSER_DISCONNECTED_PATTERN.test(
        getErrorMessage(error),
    );
}

function isRetryablePageError(error) {
    const message = getErrorMessage(error);

    return (
        isTargetCrashError(error) ||
        /target page, context or browser has been closed/i.test(message) ||
        /navigation failed|net::err_|timeout/i.test(message)
    );
}

async function configurePage(page, label) {
    page.setDefaultTimeout(PAGE_DEFAULT_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(
        PAGE_NAVIGATION_TIMEOUT_MS,
    );

    let suppressedPageErrors = 0;

    page.on("crash", () => {
        console.error(
            `💥 Chromium page crashed (${label}).`,
        );
    });

    page.on("pageerror", (error) => {
        const message = getErrorMessage(error);

        // Nextdoor's ad code emits large bursts of harmless errors when ad
        // images/scripts are blocked. Suppress those so Railway logs remain
        // useful and do not hit the 500-lines-per-second rate limit.
        if (IGNORED_PAGE_ERROR_PATTERN.test(message)) {
            suppressedPageErrors += 1;
            return;
        }

        console.warn(
            `⚠️ Page JavaScript error (${label}): ${message}`,
        );
    });

    page.on("close", () => {
        if (suppressedPageErrors > 0) {
            console.log(
                `ℹ️ Suppressed ${suppressedPageErrors} harmless ` +
                `network/ad page error(s) for ${label}.`,
            );
        }
    });

    await page.route("**/*", async (route) => {
        const request = route.request();
        const resourceType = request.resourceType();
        const requestUrl = request.url();

        if (
            BLOCKED_RESOURCE_TYPES.has(resourceType) ||
            BLOCKED_REQUEST_URL_PATTERN.test(requestUrl)
        ) {
            await route.abort().catch(() => {});
            return;
        }

        await route.continue().catch(() => {});
    });

    return page;
}

async function createConfiguredPage(context, label) {
    const page = await context.newPage();
    return configurePage(page, label);
}

async function closePageSafely(page, label) {
    if (!page || page.isClosed()) {
        return;
    }

    await page.close().catch((error) => {
        console.warn(
            `⚠️ Could not close ${label}: ` +
            getErrorMessage(error),
        );
    });

    // Chromium renderer processes and threads can outlive page.close() for a
    // short time. A slightly longer pause prevents rapid page churn from
    // exhausting Railway's PID/thread allowance.
    await sleep(750);
}

async function closeStaleContextPages(context, keepPage) {
    const stalePages = context
        .pages()
        .filter((page) => page !== keepPage && !page.isClosed());

    if (!stalePages.length) {
        console.log("✅ No stale browser pages needed cleanup.");
        return;
    }

    console.log(
        `🧹 Closing ${stalePages.length} stale page(s) left in the ` +
        `Multilogin profile...`,
    );

    for (let index = 0; index < stalePages.length; index += 1) {
        const stalePage = stalePages[index];

        await stalePage.close().catch((error) => {
            console.warn(
                `⚠️ Could not close stale page ${index + 1}/` +
                `${stalePages.length}: ${getErrorMessage(error)}`,
            );
        });
    }

    // Let Chrome reap the old renderers before disposable pages are created.
    await sleep(2_000);

    console.log(
        `✅ Stale-page cleanup complete. ` +
        `${context.pages().filter((page) => !page.isClosed()).length} ` +
        `page(s) remain open.`,
    );
}

async function parkBootstrapPage(page) {
    if (!page || page.isClosed()) {
        return;
    }

    console.log(
        "🅿️ Parking the bootstrap page on about:blank to release Nextdoor page memory...",
    );

    await page
        .goto("about:blank", {
            waitUntil: "commit",
            timeout: 15_000,
        })
        .catch((error) => {
            console.warn(
                "⚠️ Could not park bootstrap page: " +
                getErrorMessage(error),
            );
        });
}

// Playwright can occasionally surface a renderer crash through an asynchronous
// CDP callback after page.goto() has already rejected. Because every search and
// detail operation below uses a disposable page, it is safe to suppress only
// this exact target-crash exception and continue with a fresh page.
process.on("uncaughtException", (error) => {
    if (isTargetCrashError(error)) {
        asynchronousTargetCrashCount += 1;

        console.error(
            "🧯 Captured asynchronous Playwright Target crashed error. " +
            "The current disposable page will be replaced.",
        );
        return;
    }

    console.error(
        "❌ Uncaught exception:",
        error?.stack || getErrorMessage(error),
    );
    process.exit(1);
});

function cleanText(value = "") {
    return String(value).replace(/\s+/g, " ").trim();
}

function normalizePostUrl(url) {
    try {
        const parsed = new URL(url);
        const postId =
            parsed.pathname.match(/\/(?:p|posting)\/([^/?#]+)/i)?.[1];

        return postId
            ? `https://nextdoor.com/p/${postId}`
            : `${parsed.origin}${parsed.pathname}`;
    } catch {
        return url;
    }
}

function parseExplicitLocation(location = "") {
    const clean = cleanText(location);
    const match = clean.match(/^(.+?),\s*([A-Z]{2})$/);

    return match
        ? {
            city: match[1].trim(),
            state: match[2].trim(),
        }
        : {
            city: clean || null,
            state: null,
        };
}

function guessCity(location = "") {
    const lower = location.toLowerCase();

    const knownCities = [
        "allen",
        "mckinney",
        "plano",
        "frisco",
        "dallas",
        "prosper",
        "little elm",
        "richardson",
        "garland",
        "carrollton",
        "mesquite",
        "arlington",
        "grapevine",
        "sachse",
        "celina",
        "lewisville",
        "desoto",
        "north richland hills",
        "lowry crossing",
        "melissa",
    ];

    const direct = knownCities.find((city) => lower.includes(city));

    if (direct) return direct;
    if (lower.includes("craig ranch")) return "mckinney";
    if (lower.includes("eldorado")) return "mckinney";
    if (lower.includes("trinity falls")) return "mckinney";
    if (lower.includes("stonebridge ranch")) return "mckinney";
    if (lower.includes("westridge")) return "mckinney";
    if (lower.includes("mckinney north")) return "mckinney";

    return null;
}

async function resolveCityState({ location, description }) {
    const explicit = parseExplicitLocation(location);

    let city = explicit.city;
    let state = explicit.state || FALLBACK_STATE;

    const guessed = guessCity(location);
    if (guessed) city = guessed;

    try {
        const normalized = await normalizeCity({
            city,
            state,
            location,
            description,
        });

        return {
            city: normalized?.city || city || null,
            state: normalized?.state || state || null,
        };
    } catch (error) {
        console.warn(
            `⚠️ normalizeCity failed for "${location}": ${error.message}`,
        );

        return {
            city: city || null,
            state: state || null,
        };
    }
}

async function getCurrentNextdoorPage(context) {
    const pages = context.pages().filter((page) => !page.isClosed());

    return (
        pages.find((page) => /nextdoor\.com/i.test(page.url())) ||
        pages[0] ||
        context.newPage()
    );
}

async function findVisibleSearchBox(page) {
    const selectors = [
        'input[aria-label="Search Nextdoor"]',
        'input[placeholder*="Search Nextdoor" i]',
        'input[type="search"]',
        '[data-testid="search-input"] input',
    ];

    for (const selector of selectors) {
        const candidate = page.locator(selector).first();

        if (
            (await candidate.count().catch(() => 0)) &&
            (await candidate.isVisible().catch(() => false))
        ) {
            return candidate;
        }
    }

    return null;
}

async function waitForNextdoorReady(
    context,
    totalMs = 180_000,
) {
    console.log(
        "⏳ Waiting for the Multilogin profile and Nextdoor feed to finish loading...",
    );
    console.log(
        `   Context has ${context.pages().length} page(s) open`,
    );

    const deadline = Date.now() + totalMs;

    let page = null;
    let hydratingStartedAt = null;
    let forcedFeedNavigation = false;
    let forcedReload = false;

    console.log(
        "   Sleeping 7s for Multilogin to stabilize...",
    );

    await sleep(7_000);

    console.log(
        "   Initial sleep done, entering wait loop...",
    );

    while (Date.now() < deadline) {
        const remaining = Math.max(
            0,
            Math.round((deadline - Date.now()) / 1_000),
        );

        console.log(
            `   ⏱ Polling... ${remaining}s remaining`,
        );

        page = await getCurrentNextdoorPage(context);

        if (!page || page.isClosed()) {
            console.log(
                "   No open page found in context yet...",
            );

            await sleep(2_500);
            continue;
        }

        const url = page.url();

        console.log(`   Current page URL: ${url}`);

        const isNextdoor =
            /(^https?:\/\/)?([^/]+\.)?nextdoor\.com/i.test(url);

        if (!isNextdoor) {
            if (!forcedFeedNavigation) {
                forcedFeedNavigation = true;

                console.log(
                    "🧭 Current page is not Nextdoor. Opening a clean Nextdoor feed...",
                );

                await page
                    .goto("https://nextdoor.com/news_feed/", {
                        waitUntil: "domcontentloaded",
                        timeout: 60_000,
                    })
                    .catch((error) => {
                        console.log(
                            `ℹ️ Feed navigation is still settling: ${error.message}`,
                        );
                    });

                await sleep(5_000);
                continue;
            }

            console.log(
                `   Non-Nextdoor page still open: ${url}`,
            );

            await sleep(2_500);
            continue;
        }

        const searchBox = await findVisibleSearchBox(page);

        if (searchBox) {
            console.log(`✅ Nextdoor is ready: ${url}`);
            return page;
        }

        const isLoginOrInterstitial =
            /\/(login|verify|choose_address|checkpoint)/i.test(
                url,
            );

        if (isLoginOrInterstitial) {
            console.log(
                `ℹ️ Waiting for Nextdoor login/interstitial: ${url}`,
            );

            // Do not redirect away from a login or verification screen.
            hydratingStartedAt = null;

            await sleep(2_500);
            continue;
        }

        if (!hydratingStartedAt) {
            hydratingStartedAt = Date.now();
        }

        const hydratingForMs =
            Date.now() - hydratingStartedAt;

        console.log(
            `   Nextdoor page is open but still hydrating: ${url}`,
        );

        // A stale search page can remain open without ever rendering
        // the global search box. Force a clean feed after 15 seconds.
        if (
            !forcedFeedNavigation &&
            hydratingForMs >= 15_000
        ) {
            forcedFeedNavigation = true;

            console.log(
                "🧭 Nextdoor is stuck on a stale page. Opening a clean news feed...",
            );

            await page
                .goto("https://nextdoor.com/news_feed/", {
                    waitUntil: "domcontentloaded",
                    timeout: 60_000,
                })
                .catch((error) => {
                    console.log(
                        `ℹ️ Forced feed navigation is still settling: ${error.message}`,
                    );
                });

            await sleep(7_000);
            continue;
        }

        // If the clean feed also fails to hydrate, reload it once.
        if (
            forcedFeedNavigation &&
            !forcedReload &&
            hydratingForMs >= 45_000
        ) {
            forcedReload = true;

            console.log(
                "🔄 Nextdoor feed still has not hydrated. Reloading once...",
            );

            await page
                .reload({
                    waitUntil: "domcontentloaded",
                    timeout: 60_000,
                })
                .catch((error) => {
                    console.log(
                        `ℹ️ Feed reload is still settling: ${error.message}`,
                    );
                });

            await sleep(7_000);
            continue;
        }

        await sleep(2_500);
    }

    throw new Error(
        "Nextdoor did not become ready after clean-feed navigation and one reload.",
    );
}

async function goToPostsTab(page, query) {
    const candidates = [
        page.getByRole("tab", { name: /^Posts$/i }).first(),
        page.locator('[data-testid="tab-posts"]').first(),
        page.locator("a,button").filter({ hasText: /^Posts$/i }).first(),
    ];

    for (const candidate of candidates) {
        try {
            if (
                (await candidate.count()) &&
                (await candidate.isVisible())
            ) {
                await candidate.click();
                await sleep(1_600);
                console.log("✅ Opened Posts results.");
                return;
            }
        } catch {}
    }

    await page.goto(
        `https://nextdoor.com/search/posts/?query=${encodeURIComponent(query)}`,
        {
            waitUntil: "domcontentloaded",
            timeout: 60_000,
        },
    );

    await sleep(2_000);
    console.log("✅ Opened Posts results directly.");
}

async function applyMostRecentFilter(page) {
    console.log("🔃 Applying Most Recent sort...");

    const triggerCandidates = [
        page.locator('[aria-label="Sort By"]').first(),
        page.locator('div[role="button"][aria-label="Sort By"]').first(),
        page
            .locator("button, [role=button]")
            .filter({ hasText: /^(Most Relevant|Most Recent)$/i })
            .first(),
    ];

    let trigger = null;

    for (const candidate of triggerCandidates) {
        if (
            (await candidate.count().catch(() => 0)) &&
            (await candidate.isVisible().catch(() => false))
        ) {
            trigger = candidate;
            break;
        }
    }

    if (!trigger) {
        console.log("ℹ️ Could not find the sort control.");
        return false;
    }

    const currentText = cleanText(await trigger.innerText().catch(() => ""));

    if (/most recent/i.test(currentText)) {
        console.log("✅ Most Recent was already selected.");
        return true;
    }

    await trigger.click();
    await sleep(500);

    const optionCandidates = [
        page.getByRole("menuitem", { name: /^Most Recent$/i }).first(),
        page.getByRole("option", { name: /^Most Recent$/i }).first(),
        page.getByText(/^Most Recent$/i).last(),
    ];

    for (const option of optionCandidates) {
        if (
            (await option.count().catch(() => 0)) &&
            (await option.isVisible().catch(() => false))
        ) {
            await option.click();
            await sleep(1_000);
            console.log("✅ Applied Most Recent.");
            return true;
        }
    }

    console.log("ℹ️ Most Recent option was not found.");
    return false;
}

async function applyDistanceFilter(page, targetMiles = 15) {
    console.log(`📍 Applying ${targetMiles}-mile distance filter...`);

    const triggerCandidates = [
        page
            .getByRole("button", {
                name: /(?:\d+\s*miles?|distance)/i,
            })
            .first(),
        page
            .locator("button, [role=button]")
            .filter({ hasText: /\d+\s*miles?/i })
            .first(),
    ];

    let trigger = null;

    for (const candidate of triggerCandidates) {
        if (
            (await candidate.count().catch(() => 0)) &&
            (await candidate.isVisible().catch(() => false))
        ) {
            trigger = candidate;
            break;
        }
    }

    if (!trigger) {
        console.log("ℹ️ Could not find the distance control.");
        return false;
    }

    const currentText = cleanText(await trigger.innerText().catch(() => ""));

    if (new RegExp(`^${targetMiles}\\s*miles?$`, "i").test(currentText)) {
        console.log(`✅ Distance was already ${targetMiles} miles.`);
        return true;
    }

    await trigger.click();
    await sleep(500);

    const exactLabel = new RegExp(`^${targetMiles}\\s*miles?$`, "i");

    const optionCandidates = [
        page.getByRole("menuitem", { name: exactLabel }).first(),
        page.getByRole("option", { name: exactLabel }).first(),
        page.getByText(exactLabel).last(),
    ];

    for (const option of optionCandidates) {
        if (
            (await option.count().catch(() => 0)) &&
            (await option.isVisible().catch(() => false))
        ) {
            await option.click();
            await sleep(1_000);
            console.log(`✅ Applied ${targetMiles} miles.`);
            return true;
        }
    }

    const slider = page.locator('.rc-slider-handle[role="slider"]').first();

    if (
        (await slider.count().catch(() => 0)) &&
        (await slider.isVisible().catch(() => false))
    ) {
        await slider.focus();

        let current = Number(await slider.getAttribute("aria-valuenow"));

        if (!Number.isFinite(current)) current = 1;

        while (current > 1) {
            await page.keyboard.press("ArrowLeft");
            current -= 1;
        }

        for (let value = 1; value < targetMiles; value += 1) {
            await page.keyboard.press("ArrowRight");
        }

        await sleep(800);

        const finalValue = await slider.getAttribute("aria-valuenow");

        console.log(
            `✅ Distance slider set to ${finalValue || targetMiles} miles.`,
        );

        await page.keyboard.press("Escape").catch(() => {});
        return true;
    }

    console.log(
        `ℹ️ Could not find the ${targetMiles}-mile option or slider.`,
    );
    return false;
}

async function applyTodayFilter(page) {
    console.log('🗓️ Applying "Today" date filter...');

    const triggerCandidates = [
        page
            .getByRole("button", {
                name: /^(All Time|Today|This Week|This Month|This Year)$/i,
            })
            .first(),
        page
            .locator("button, [role=button]")
            .filter({
                hasText:
                    /^(All Time|Today|This Week|This Month|This Year)$/i,
            })
            .first(),
    ];

    let trigger = null;

    for (const candidate of triggerCandidates) {
        if (
            (await candidate.count().catch(() => 0)) &&
            (await candidate.isVisible().catch(() => false))
        ) {
            trigger = candidate;
            break;
        }
    }

    if (!trigger) {
        console.log("ℹ️ Could not find the date filter.");
        return false;
    }

    const currentText = cleanText(await trigger.innerText().catch(() => ""));

    if (/^today$/i.test(currentText)) {
        console.log('✅ Date was already set to "Today".');
        return true;
    }

    await trigger.click();
    await sleep(500);

    const optionCandidates = [
        page.getByRole("menuitem", { name: /^Today$/i }).first(),
        page.getByRole("option", { name: /^Today$/i }).first(),
        page.getByText(/^Today$/i).last(),
    ];

    for (const option of optionCandidates) {
        if (
            (await option.count().catch(() => 0)) &&
            (await option.isVisible().catch(() => false))
        ) {
            await option.click();
            await sleep(1_000);
            console.log('✅ Applied "Today".');
            return true;
        }
    }

    console.log('ℹ️ Could not find the "Today" option.');
    return false;
}

async function applySearchFiltersByUrl(page, query) {
    const currentUrl = new URL(page.url());

    if (!/(^|\.)nextdoor\.com$/i.test(currentUrl.hostname)) {
        throw new Error(
            `Unexpected search URL before applying filters: ${page.url()}`,
        );
    }

    console.log("🔗 Nextdoor-generated search URL:");
    console.log(`   ${currentUrl.toString()}`);

    // Preserve Nextdoor-generated values such as ssid/search IDs, but force
    // the Posts screen and the exact filters needed for this scraper.
    currentUrl.searchParams.set("navigationScreen", "POST");
    currentUrl.searchParams.set("query", query);
    currentUrl.searchParams.set(
        "postSortOrder",
        "SORT_BY_RECENCY",
    );
    currentUrl.searchParams.set("postDistance", "15");
    currentUrl.searchParams.set(
        "postDistanceUnit",
        "MILES",
    );
    currentUrl.searchParams.set(
        "postDateFilter",
        "TODAY",
    );

    const targetUrl = currentUrl.toString();

    console.log("🔗 Applying search filters through the URL:");
    console.log("   Posts + Most Recent + 15 miles + Today");
    console.log(`   ${targetUrl}`);

    await page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
    });

    await sleep(3_500);

    const appliedUrl = new URL(page.url());

    const applied = {
        navigationScreen:
            appliedUrl.searchParams.get("navigationScreen"),
        query: appliedUrl.searchParams.get("query"),
        postSortOrder:
            appliedUrl.searchParams.get("postSortOrder"),
        postDistance:
            appliedUrl.searchParams.get("postDistance"),
        postDistanceUnit:
            appliedUrl.searchParams.get("postDistanceUnit"),
        postDateFilter:
            appliedUrl.searchParams.get("postDateFilter"),
    };

    console.log("✅ URL filter state:", applied);

    const filtersAreCorrect =
        applied.navigationScreen === "POST" &&
        applied.query === query &&
        applied.postSortOrder === "SORT_BY_RECENCY" &&
        applied.postDistance === "15" &&
        applied.postDistanceUnit === "MILES" &&
        applied.postDateFilter === "TODAY";

    if (!filtersAreCorrect) {
        throw new Error(
            "Nextdoor removed or changed one or more URL filter parameters.",
        );
    }
}

async function searchNextdoor(page, query) {
    console.log("");
    console.log("============================================================");
    console.log(`🔍 Searching Nextdoor for "${query}"...`);
    console.log("============================================================");

    if (!/nextdoor\.com/i.test(page.url())) {
        await page.goto("https://nextdoor.com/news_feed/", {
            waitUntil: "domcontentloaded",
            timeout: 60_000,
        });
    }

    let searchBox = await findVisibleSearchBox(page);

    if (!searchBox) {
        console.log(
            `⏳ Search bar is not visible yet; waiting up to ` +
            `${Math.round(SEARCH_READY_TIMEOUT_MS / 1_000)} more seconds...`,
        );

        const deadline = Date.now() + SEARCH_READY_TIMEOUT_MS;

        while (Date.now() < deadline && !searchBox) {
            await sleep(1_500);
            searchBox = await findVisibleSearchBox(page);
        }
    }

    if (!searchBox) {
        throw new Error(
            "Could not find the Nextdoor search bar after waiting for the feed.",
        );
    }

    await searchBox.click();
    await searchBox.fill(query);
    await page.keyboard.press("Enter");
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await sleep(3_000);

    // The normal search creates Nextdoor's current ssid/search parameters.
    // Reuse that URL and append the exact filters first. If Nextdoor changes
    // or strips those parameters, fall back to the visible Posts/filter controls.
    try {
        await applySearchFiltersByUrl(page, query);
    } catch (error) {
        console.warn(
            `⚠️ URL filters failed: ${error.message}`,
        );

        console.log(
            "♻️ Falling back to the visible Posts and filter controls...",
        );

        await goToPostsTab(page, query);
        await applyMostRecentFilter(page);
        await applyDistanceFilter(page, 15);
        await applyTodayFilter(page);
        await sleep(1_800);
    }
}

async function collectPostLinks(page, limit = MAX_POSTS_PER_TERM) {
    console.log("⬇️ Loading search results...");

    let previousCount = -1;
    let stablePasses = 0;

    for (let pass = 1; pass <= 20; pass += 1) {
        const count = await page
            .locator('a[href*="/p/"], a[href*="/posting/"]')
            .count();

        console.log(`   pass ${pass}: ${count} links loaded`);

        stablePasses =
            count === previousCount ? stablePasses + 1 : 0;

        previousCount = count;

        if (stablePasses >= 4) break;

        await page.mouse.wheel(0, 1_700);
        await sleep(900);
    }

    const raw = await page.evaluate((maxResults) => {
        const results = [];
        const seen = new Set();

        for (const anchor of document.querySelectorAll(
            'a[href*="/p/"], a[href*="/posting/"]',
        )) {
            const href = anchor.href;

            if (!href || seen.has(href)) continue;

            const root =
                anchor.closest("article, [role=article], li") ||
                anchor.parentElement;

            const preview = (
                root?.innerText ||
                anchor.innerText ||
                ""
            )
                .replace(/\s+/g, " ")
                .trim();

            if (preview.length < 15) continue;

            seen.add(href);

            results.push({
                url: href,
                preview: preview.slice(0, 1_500),
            });

            if (results.length >= maxResults) break;
        }

        return results;
    }, limit);

    const unique = new Map();

    for (const post of raw) {
        const normalizedUrl = normalizePostUrl(post.url);

        unique.set(normalizedUrl, {
            ...post,
            url: normalizedUrl,
        });
    }

    const posts = [...unique.values()];

    console.log(`🔗 Found ${posts.length} unique posts.`);
    return posts;
}

async function getExistingUrls(posts) {
    const urls = posts.map((post) => normalizePostUrl(post.url));

    if (!urls.length) return new Set();

    const { rows } = await pool.query(
        `
            SELECT post_url
            FROM ${TABLE_NAME}
            WHERE post_url = ANY($1::text[])
        `,
        [urls],
    );

    return new Set(
        rows.map((row) => normalizePostUrl(row.post_url)),
    );
}

async function expandSeeMore(page) {
    const buttons = page.locator(
        'button:has-text("See more"), [data-testid="see-more-text"]',
    );

    const count = Math.min(await buttons.count(), 4);

    for (let index = 0; index < count; index += 1) {
        try {
            if (await buttons.nth(index).isVisible()) {
                await buttons.nth(index).click({ timeout: 1_200 });
                await sleep(250);
            }
        } catch {}
    }
}

async function extractAuthor(page) {
    const selectors = [
        'a[href*="/profile/"][href*="detail_author"]',
        'a[href*="/profile/"][href*="is=detail_author"]',
        'main article a[href*="/profile/"]',
        'a[href*="/profile/"]',
    ];

    for (const selector of selectors) {
        const links = page.locator(selector);
        const count = Math.min(await links.count(), 15);

        for (let index = 0; index < count; index += 1) {
            try {
                const link = links.nth(index);
                const text = cleanText(await link.innerText());

                if (
                    /^[A-Z][A-Za-zÀ-ÖØ-öø-ÿ.'’\-]+(?:\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ.'’\-]+){1,5}$/.test(
                        text,
                    )
                ) {
                    return text;
                }

                const aria = await link
                    .locator('[aria-label*="Avatar for" i]')
                    .first()
                    .getAttribute("aria-label")
                    .catch(() => null);

                if (aria) {
                    return cleanText(
                        aria.replace(/^Avatar for\s*/i, ""),
                    );
                }
            } catch {}
        }
    }

    return null;
}

async function extractPostDetails(detailPage, post, searchTerm) {
    const url = normalizePostUrl(post.url);

    await detailPage.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
    });

    await detailPage
        .waitForURL(
            (current) =>
                normalizePostUrl(current.href) === url,
            { timeout: 12_000 },
        )
        .catch(() => {});

    await sleep(1_400);
    await expandSeeMore(detailPage);

    const author = await extractAuthor(detailPage);

    const extracted = await detailPage.evaluate(
        ({ preview }) => {
            const clean = (value) =>
                (value || "").replace(/\s+/g, " ").trim();

            const junk =
                /Home For Sale & Free Local News Ask Alerts Groups Events Post Settings Help Center/i;

            const tokens = clean(preview)
                .toLowerCase()
                .split(/[^a-z0-9]+/)
                .filter((word) => word.length >= 4);

            const tokenSet = new Set(tokens.slice(0, 80));
            const candidates = [];

            const selectors = [
                '[data-testid="post-body-text"]',
                '[data-testid="styled-text-wrapper"]',
                'span[data-testid="styled-text"]',
                ".postTextBodySpan",
                'main [dir="auto"]',
            ];

            for (const selector of selectors) {
                for (const element of document.querySelectorAll(selector)) {
                    const text = clean(
                        element.innerText ||
                        element.textContent,
                    );

                    if (
                        text.length < 20 ||
                        text.length > 7_000 ||
                        junk.test(text)
                    ) {
                        continue;
                    }

                    const words = text
                        .toLowerCase()
                        .split(/[^a-z0-9]+/);

                    const overlap = words.reduce(
                        (total, word) =>
                            total + (tokenSet.has(word) ? 1 : 0),
                        0,
                    );

                    candidates.push({
                        text,
                        score:
                            overlap * 100 +
                            Math.min(text.length, 1_500),
                    });
                }
            }

            candidates.sort((a, b) => b.score - a.score);

            const description =
                candidates[0]?.text ||
                clean(preview) ||
                null;

            let location = null;

            const neighborhoodLinks = [
                ...document.querySelectorAll(
                    'a[href*="/neighborhood/"]',
                ),
            ];

            for (const link of neighborhoodLinks) {
                const text = clean(link.innerText);

                if (text && text.length < 100) {
                    location = text;
                    break;
                }
            }

            if (!location) {
                const lines = document.body.innerText
                    .split("\n")
                    .map(clean)
                    .filter(Boolean);

                const explicit = lines.find((line) =>
                    /^[A-Za-z .'-]+,\s*[A-Z]{2}$/.test(line),
                );

                if (explicit) location = explicit;
            }

            return {
                description,
                location,
            };
        },
        { preview: post.preview },
    );

    const description = cleanText(
        extracted.description || post.preview,
    );

    const location = cleanText(
        extracted.location || "",
    );

    const cityState = await resolveCityState({
        location,
        description,
    });

    return {
        author,
        location: location || null,
        description,
        post_url: url,
        city: cityState.city,
        state: cityState.state,
        lead_type: ["general_contracting"],
        search_term: searchTerm,
    };
}

async function insertUnfilteredGeneralContracting(record) {
    const query = `
        INSERT INTO ${TABLE_NAME}
        (
            author,
            location,
            description,
            post_url,
            city,
            state,
            lead_type,
            timestamp
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::text[], NOW())
            ON CONFLICT (post_url) DO UPDATE SET
            author = COALESCE(
                                          EXCLUDED.author,
                                          ${TABLE_NAME}.author
                                          ),
                                          location = COALESCE(
                                          EXCLUDED.location,
                                          ${TABLE_NAME}.location
                                          ),
                                          description = COALESCE(
                                          EXCLUDED.description,
                                          ${TABLE_NAME}.description
                                          ),
                                          city = COALESCE(
                                          EXCLUDED.city,
                                          ${TABLE_NAME}.city
                                          ),
                                          state = COALESCE(
                                          EXCLUDED.state,
                                          ${TABLE_NAME}.state
                                          ),
                                          lead_type = ARRAY(
                                          SELECT DISTINCT value
                                          FROM unnest(
                                          COALESCE(
                                          ${TABLE_NAME}.lead_type,
                                          ARRAY[]::text[]
                                          ) ||
                                          COALESCE(
                                          EXCLUDED.lead_type,
                                          ARRAY[]::text[]
                                          )
                                          ) AS value
                                          WHERE value IS NOT NULL
                                          AND BTRIM(value) <> ''
                                          )
                                          RETURNING id
    `;

    const { rows } = await pool.query(query, [
        record.author,
        record.location,
        record.description,
        record.post_url,
        record.city,
        record.state,
        Array.isArray(record.lead_type)
            ? record.lead_type
            : [record.lead_type],
    ]);

    const insertedId = rows[0]?.id || null;

    console.log(
        `✅ Saved: ${record.author || "(unknown)"} → ` +
        `${record.city || "(unknown city)"}, ` +
        `${record.state || "(unknown state)"}` +
        `${insertedId ? ` (id=${insertedId})` : ""}`,
    );

    return insertedId;
}


function normalizeSearchTerm(term) {
    return cleanText(term)
        .toLowerCase()
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'");
}

function validSearchTerm(term) {
    const clean = cleanText(term);

    return (
        clean.length >= 3 &&
        clean.length <= 70 &&
        clean.split(/\s+/).length <= 9 &&
        /^[A-Za-z0-9&'’()./\-\s]+$/.test(clean)
    );
}

function dedupePlanEntries(entries) {
    const seen = new Set();
    const output = [];

    for (const entry of entries) {
        const query = cleanText(entry?.query || entry);
        const key = normalizeSearchTerm(query);

        if (!key || seen.has(key) || !validSearchTerm(query)) {
            continue;
        }

        seen.add(key);
        output.push({
            query,
            source: entry?.source || "unknown",
        });
    }

    return output;
}

function numeric(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function scoreHistoricalTerm(row) {
    const observations = Math.max(1, numeric(row.observations));
    const uniquePosts = numeric(row.unique_posts);
    const freshCandidates = numeric(row.fresh_candidates);
    const inserted = numeric(row.new_posts_inserted);
    const leads = numeric(row.actual_leads);
    const ftnMatches = numeric(row.ftn_matches);
    const existing = numeric(row.existing_observations);

    const leadRate = leads / Math.max(1, inserted);
    const freshRate = freshCandidates / observations;
    const staleRate = existing / observations;

    return (
        leads * 25 +
        ftnMatches * 12 +
        inserted * 5 +
        uniquePosts * 0.25 +
        leadRate * 20 +
        freshRate * 8 -
        staleRate * 5
    );
}

async function purgeExpiredSearchHistory() {
    const resultDelete = await pool.query(
        `
            DELETE FROM ${SEARCH_RESULTS_TABLE}
            WHERE expires_at < NOW()
        `,
    );

    const runDelete = await pool.query(
        `
            DELETE FROM ${SEARCH_RUNS_TABLE} r
            WHERE r.started_at < NOW() - INTERVAL '35 days'
              AND NOT EXISTS (
                SELECT 1
                FROM ${SEARCH_RESULTS_TABLE} s
                WHERE s.run_id = r.run_id
                )
        `,
    );

    console.log(
        `🧹 Search-history cleanup: ${resultDelete.rowCount} observation(s) ` +
        `and ${runDelete.rowCount} old run(s) removed.`,
    );
}

async function getHistoricalTermPerformance() {
    const { rows } = await pool.query(
        `
            SELECT
                r.search_term,
                COUNT(DISTINCT r.run_id)::int AS search_runs,
                COUNT(*)::int AS observations,
                COUNT(DISTINCT r.post_url)::int AS unique_posts,
                COUNT(*) FILTER (
                    WHERE r.was_existing = TRUE
                )::int AS existing_observations,
                COUNT(*) FILTER (
                    WHERE r.cross_term_duplicate = TRUE
                )::int AS cross_term_duplicates,
                COUNT(*) FILTER (
                    WHERE r.was_existing = FALSE
                      AND r.cross_term_duplicate = FALSE
                )::int AS fresh_candidates,
                COUNT(DISTINCT r.post_url) FILTER (
                    WHERE r.inserted_new = TRUE
                )::int AS new_posts_inserted,
                COUNT(DISTINCT g.id) FILTER (
                    WHERE g.is_lead = TRUE
                )::int AS actual_leads,
                COUNT(DISTINCT f.lead_id)::int AS ftn_matches,
                MAX(r.searched_at) AS last_searched_at
            FROM ${SEARCH_RESULTS_TABLE} r
                     LEFT JOIN ${TABLE_NAME} g
                               ON g.post_url = r.post_url
                     LEFT JOIN familytreenow f
                               ON f.lead_id = g.id
            WHERE r.searched_at >=
                  NOW() - ($1::text || ' days')::interval
            GROUP BY r.search_term
        `,
        [String(SEARCH_HISTORY_DAYS)],
    );

    return rows.map((row) => ({
        ...row,
        score: scoreHistoricalTerm(row),
    }));
}

async function getRecentlySearchedTerms(days = SONAR_COOLDOWN_DAYS) {
    const { rows } = await pool.query(
        `
            SELECT DISTINCT search_term
            FROM ${SEARCH_RESULTS_TABLE}
            WHERE searched_at >=
                  NOW() - ($1::text || ' days')::interval
        `,
        [String(days)],
    );

    return new Set(
        rows.map((row) => normalizeSearchTerm(row.search_term)),
    );
}

function extractJsonObject(text) {
    const raw = cleanText(text);

    try {
        return JSON.parse(raw);
    } catch {}

    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];

    if (fenced) {
        try {
            return JSON.parse(fenced);
        } catch {}
    }

    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");

    if (first >= 0 && last > first) {
        try {
            return JSON.parse(raw.slice(first, last + 1));
        } catch {}
    }

    throw new Error("Sonar response did not contain valid JSON.");
}

async function requestSonarExplorationTerms({
                                                performance,
                                                recentTerms,
                                                excludedTerms,
                                                count,
                                            }) {
    if (!PPLX_API_KEY || count <= 0) {
        return {
            terms: [],
            used: false,
            error: PPLX_API_KEY
                ? null
                : "No Perplexity/Sonar API key configured.",
        };
    }

    const ranked = [...performance]
        .sort((a, b) => b.score - a.score)
        .slice(0, 30)
        .map((row) => ({
            term: row.search_term,
            runs: numeric(row.search_runs),
            observations: numeric(row.observations),
            unique_posts: numeric(row.unique_posts),
            fresh_candidates: numeric(row.fresh_candidates),
            new_posts_inserted: numeric(row.new_posts_inserted),
            actual_leads: numeric(row.actual_leads),
            ftn_matches: numeric(row.ftn_matches),
            existing_observations: numeric(row.existing_observations),
        }));

    const recent = [...recentTerms].slice(0, 80);
    const excluded = [...excludedTerms].slice(0, 50);

    const systemPrompt = [
        "You generate short Nextdoor search queries for finding homeowners who are actively looking for residential general-contracting work.",
        "Focus on natural homeowner language, not SEO phrases.",
        "Relevant work includes general contractors, remodeling, additions, foundations, structural repairs, kitchens, bathrooms, decks, fences, framing, concrete, masonry, patios, porches, garages, and major home repairs.",
        "Avoid commercial construction, jobs/employment, contractor self-promotion, real-estate listings, DIY-only questions, and generic home-service categories that are not general contracting.",
        "Return JSON only with this exact shape: {\"terms\":[\"term 1\",\"term 2\"]}.",
    ].join(" ");

    const userPrompt = [
        `Generate exactly ${count} NEW search queries for the next scraper run.`,
        "Do not repeat the anchor/winner terms or terms searched during the cooldown window unless there is no reasonable alternative.",
        "Use the historical performance to explore adjacent homeowner wording around categories that have produced actual leads, while also testing genuinely new phrases.",
        "Keep each query concise (usually 2-5 words, never more than 9).",
        "",
        `ANCHOR/WINNER TERMS TO EXCLUDE: ${JSON.stringify(excluded)}`,
        `RECENTLY SEARCHED TERMS TO AVOID: ${JSON.stringify(recent)}`,
        `30-DAY PERFORMANCE: ${JSON.stringify(ranked)}`,
    ].join("\n");

    console.log(
        `🧠 Asking Sonar (${PPLX_MODEL}) for ${count} exploratory GC search term(s)...`,
    );

    const response = await fetch(PPLX_API_URL, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${PPLX_API_KEY}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: PPLX_MODEL,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt },
            ],
            temperature: 0.65,
            max_tokens: 700,
        }),
        signal: AbortSignal.timeout(
            Math.max(
                10_000,
                Number(process.env.GC_SONAR_TIMEOUT_MS || 45_000),
            ),
        ),
    });

    const bodyText = await response.text();

    if (!response.ok) {
        throw new Error(
            `Sonar HTTP ${response.status}: ${bodyText.slice(0, 500)}`,
        );
    }

    let body;

    try {
        body = JSON.parse(bodyText);
    } catch {
        throw new Error("Sonar returned a non-JSON API response.");
    }

    const content = body?.choices?.[0]?.message?.content;

    if (!content) {
        throw new Error("Sonar response did not include message content.");
    }

    const parsed = extractJsonObject(content);
    const rawTerms = Array.isArray(parsed?.terms) ? parsed.terms : [];

    const terms = [];
    const localSeen = new Set();

    for (const rawTerm of rawTerms) {
        const term = cleanText(rawTerm);
        const key = normalizeSearchTerm(term);

        if (
            !validSearchTerm(term) ||
            !key ||
            localSeen.has(key) ||
            excludedTerms.has(key) ||
            recentTerms.has(key)
        ) {
            continue;
        }

        localSeen.add(key);
        terms.push(term);

        if (terms.length >= count) break;
    }

    return {
        terms,
        used: true,
        error: null,
    };
}

async function buildAdaptiveSearchPlan() {
    console.log("");
    console.log("============================================================");
    console.log("🧠 Building adaptive general-contracting search strategy...");
    console.log("============================================================");

    const performance = await getHistoricalTermPerformance();
    const performanceByTerm = new Map(
        performance.map((row) => [
            normalizeSearchTerm(row.search_term),
            row,
        ]),
    );

    const anchors = dedupePlanEntries(
        ANCHOR_TERMS.map((query) => ({
            query,
            source: "anchor",
        })),
    );

    const anchorKeys = new Set(
        anchors.map((entry) => normalizeSearchTerm(entry.query)),
    );

    const winners = [...performance]
        .filter((row) => !anchorKeys.has(normalizeSearchTerm(row.search_term)))
        .sort((a, b) => b.score - a.score)
        .slice(0, WINNER_TERM_COUNT)
        .map((row) => ({
            query: row.search_term,
            source: "winner",
        }));

    const selectedBeforeSonar = dedupePlanEntries([
        ...anchors,
        ...winners,
    ]);

    const excludedTerms = new Set(
        selectedBeforeSonar.map((entry) =>
            normalizeSearchTerm(entry.query),
        ),
    );

    const recentTerms = await getRecentlySearchedTerms();

    let sonar = {
        terms: [],
        used: false,
        error: null,
    };

    try {
        sonar = await requestSonarExplorationTerms({
            performance,
            recentTerms,
            excludedTerms,
            count: SONAR_TERM_COUNT,
        });
    } catch (error) {
        sonar = {
            terms: [],
            used: true,
            error: getErrorMessage(error),
        };

        console.warn(
            `⚠️ Sonar search-term generation failed: ${sonar.error}`,
        );
    }

    const exploration = sonar.terms.map((query) => ({
        query,
        source: "sonar",
    }));

    const currentlySelected = new Set([
        ...excludedTerms,
        ...exploration.map((entry) => normalizeSearchTerm(entry.query)),
    ]);

    for (const candidate of DEFAULT_EXPLORATION_TERMS) {
        if (exploration.length >= SONAR_TERM_COUNT) break;

        const key = normalizeSearchTerm(candidate);

        if (
            !key ||
            currentlySelected.has(key) ||
            recentTerms.has(key)
        ) {
            continue;
        }

        currentlySelected.add(key);
        exploration.push({
            query: candidate,
            source: "fallback",
        });
    }

    // A cooldown can eventually cover the entire fallback list. In that case,
    // fill the remaining slots from the fallback pool anyway rather than run
    // too few searches.
    for (const candidate of DEFAULT_EXPLORATION_TERMS) {
        if (exploration.length >= SONAR_TERM_COUNT) break;

        const key = normalizeSearchTerm(candidate);

        if (!key || currentlySelected.has(key)) continue;

        currentlySelected.add(key);
        exploration.push({
            query: candidate,
            source: "fallback",
        });
    }

    const plan = dedupePlanEntries([
        ...selectedBeforeSonar,
        ...exploration,
    ]);

    console.log(
        `📌 Anchor terms (${anchors.length}): ` +
        anchors.map((entry) => `"${entry.query}"`).join(", "),
    );
    console.log(
        `🏆 Historical winners (${winners.length}): ` +
        (winners.length
            ? winners.map((entry) => `"${entry.query}"`).join(", ")
            : "none yet"),
    );
    console.log(
        `🧪 Exploration terms (${exploration.length}): ` +
        (exploration.length
            ? exploration
                .map((entry) => `"${entry.query}" [${entry.source}]`)
                .join(", ")
            : "none"),
    );
    console.log(`🔎 Total searches scheduled: ${plan.length}`);

    if (sonar.error) {
        console.log(`ℹ️ Sonar fallback reason: ${sonar.error}`);
    }

    return {
        plan,
        performance,
        performanceByTerm,
        sonarUsed: sonar.used && sonar.terms.length > 0,
        sonarError: sonar.error,
        anchorCount: anchors.length,
        winnerCount: winners.length,
        sonarCount: exploration.filter((entry) => entry.source === "sonar").length,
        fallbackCount: exploration.filter((entry) => entry.source === "fallback").length,
    };
}

async function createSearchRun(runId, strategy) {
    await pool.query(
        `
            INSERT INTO ${SEARCH_RUNS_TABLE}
            (
                run_id,
                status,
                planned_search_terms,
                anchor_terms_count,
                winner_terms_count,
                sonar_terms_count,
                fallback_terms_count,
                sonar_used,
                sonar_error
            )
            VALUES ($1, 'running', $2, $3, $4, $5, $6, $7, $8)
                ON CONFLICT (run_id) DO NOTHING
        `,
        [
            runId,
            strategy.plan.length,
            strategy.anchorCount,
            strategy.winnerCount,
            strategy.sonarCount,
            strategy.fallbackCount,
            strategy.sonarUsed,
            strategy.sonarError,
        ],
    );
}

async function finishSearchRun(runId, status, totals, error = null) {
    await pool.query(
        `
            UPDATE ${SEARCH_RUNS_TABLE}
            SET
                completed_at = NOW(),
                status = $2,
                total_result_observations = $3,
                total_unique_result_urls = $4,
                total_existing_posts = $5,
                total_cross_term_duplicates = $6,
                total_new_candidates = $7,
                total_inserted = $8,
                total_failed = $9,
                run_error = $10
            WHERE run_id = $1
        `,
        [
            runId,
            status,
            totals.resultObservations || 0,
            totals.uniqueResultUrls || 0,
            totals.existingSkipped || 0,
            totals.crossTermSkipped || 0,
            totals.newCandidates || 0,
            totals.inserted || 0,
            totals.failed || 0,
            error,
        ],
    );
}

async function logSearchObservations({
                                         runId,
                                         query,
                                         termSource,
                                         posts,
                                         existingUrls,
                                         crossTermUrls,
                                     }) {
    if (!posts.length) return 0;

    const values = [];
    const placeholders = [];

    posts.forEach((post, index) => {
        const base = values.length;
        const postUrl = normalizePostUrl(post.url);

        values.push(
            runId,
            query,
            termSource,
            index + 1,
            postUrl,
            cleanText(post.preview || "").slice(0, 1500) || null,
            existingUrls.has(postUrl),
            crossTermUrls.has(postUrl),
        );

        placeholders.push(
            `($${base + 1}, $${base + 2}, $${base + 3}, ` +
            `$${base + 4}, $${base + 5}, $${base + 6}, ` +
            `$${base + 7}, $${base + 8})`,
        );
    });

    await pool.query(
        `
            INSERT INTO ${SEARCH_RESULTS_TABLE}
            (
                run_id,
                search_term,
                term_source,
                result_position,
                post_url,
                preview,
                was_existing,
                cross_term_duplicate
            )
            VALUES ${placeholders.join(",\n")}
                ON CONFLICT (run_id, search_term, post_url)
            DO UPDATE SET
                result_position = EXCLUDED.result_position,
                                   preview = EXCLUDED.preview,
                                   was_existing = EXCLUDED.was_existing,
                                   cross_term_duplicate = EXCLUDED.cross_term_duplicate
        `,
        values,
    );

    console.log(
        `📝 Search audit: recorded all ${posts.length} result observation(s) ` +
        `before duplicate filtering.`,
    );

    return posts.length;
}

async function markAuditInserted(runId, query, postUrl, leadId) {
    await pool.query(
        `
            UPDATE ${SEARCH_RESULTS_TABLE}
            SET inserted_new = TRUE,
                inserted_lead_id = $4
            WHERE run_id = $1
              AND search_term = $2
              AND post_url = $3
        `,
        [runId, query, normalizePostUrl(postUrl), leadId],
    );
}

async function markAuditError(runId, query, postUrl, error) {
    await pool.query(
        `
            UPDATE ${SEARCH_RESULTS_TABLE}
            SET scraper_error = $4
            WHERE run_id = $1
              AND search_term = $2
              AND post_url = $3
        `,
        [
            runId,
            query,
            normalizePostUrl(postUrl),
            String(error || "unknown error").slice(0, 2000),
        ],
    );
}

function printTermHistory(query, performanceByTerm) {
    const row = performanceByTerm.get(normalizeSearchTerm(query));

    if (!row) {
        console.log("📈 30-day history: new/unmeasured search term.");
        return;
    }

    console.log(
        `📈 30-day history: runs=${numeric(row.search_runs)} | ` +
        `observations=${numeric(row.observations)} | ` +
        `unique=${numeric(row.unique_posts)} | ` +
        `fresh=${numeric(row.fresh_candidates)} | ` +
        `inserted=${numeric(row.new_posts_inserted)} | ` +
        `leads=${numeric(row.actual_leads)} | ` +
        `FTN=${numeric(row.ftn_matches)}`,
    );
}

async function collectPostsForSearchTerm(context, query) {
    let lastError = null;

    for (
        let attempt = 1;
        attempt <= SEARCH_PAGE_MAX_ATTEMPTS;
        attempt += 1
    ) {
        let searchPage = null;
        const crashCountAtStart =
            asynchronousTargetCrashCount;

        try {
            console.log(
                `🧼 Opening fresh search page ` +
                `(${attempt}/${SEARCH_PAGE_MAX_ATTEMPTS}) for "${query}"...`,
            );

            searchPage = await createConfiguredPage(
                context,
                `search:${query}:attempt:${attempt}`,
            );

            await searchNextdoor(searchPage, query);

            const posts = await collectPostLinks(
                searchPage,
                MAX_POSTS_PER_TERM,
            );

            if (
                asynchronousTargetCrashCount >
                crashCountAtStart
            ) {
                throw new Error(
                    `Target crashed while searching for "${query}".`,
                );
            }

            return posts;
        } catch (error) {
            lastError = error;

            if (
                browserDisconnected ||
                isBrowserDisconnectedError(error)
            ) {
                throw new Error(
                    `BROWSER_DISCONNECTED while searching for "${query}": ` +
                    getErrorMessage(error),
                );
            }

            console.error(
                `❌ Search attempt ${attempt}/` +
                `${SEARCH_PAGE_MAX_ATTEMPTS} failed for "${query}": ` +
                getErrorMessage(error),
            );

            if (attempt < SEARCH_PAGE_MAX_ATTEMPTS) {
                const delayMs = attempt * 2_000;

                console.log(
                    `♻️ Retrying "${query}" with a completely fresh ` +
                    `search page in ${delayMs / 1_000} seconds...`,
                );

                await sleep(delayMs);
            }
        } finally {
            await closePageSafely(
                searchPage,
                `search page for "${query}"`,
            );
        }
    }

    throw new Error(
        `Search failed after ${SEARCH_PAGE_MAX_ATTEMPTS} attempt(s) ` +
        `for "${query}": ${getErrorMessage(lastError)}`,
    );
}

async function extractPostDetailsWithFreshPage(
    context,
    post,
    searchTerm,
) {
    let lastError = null;

    for (
        let attempt = 1;
        attempt <= DETAIL_PAGE_MAX_ATTEMPTS;
        attempt += 1
    ) {
        let detailPage = null;
        const crashCountAtStart =
            asynchronousTargetCrashCount;

        try {
            console.log(
                `🧼 Opening fresh detail page ` +
                `(${attempt}/${DETAIL_PAGE_MAX_ATTEMPTS})...`,
            );

            detailPage = await createConfiguredPage(
                context,
                `detail:${searchTerm}:attempt:${attempt}`,
            );

            const record = await extractPostDetails(
                detailPage,
                post,
                searchTerm,
            );

            if (
                asynchronousTargetCrashCount >
                crashCountAtStart
            ) {
                throw new Error(
                    `Target crashed while opening ${post.url}.`,
                );
            }

            return record;
        } catch (error) {
            lastError = error;

            if (
                browserDisconnected ||
                isBrowserDisconnectedError(error)
            ) {
                throw new Error(
                    `BROWSER_DISCONNECTED while opening ${post.url}: ` +
                    getErrorMessage(error),
                );
            }

            console.error(
                `❌ Detail attempt ${attempt}/` +
                `${DETAIL_PAGE_MAX_ATTEMPTS} failed: ` +
                getErrorMessage(error),
            );

            if (
                attempt < DETAIL_PAGE_MAX_ATTEMPTS &&
                isRetryablePageError(error)
            ) {
                const delayMs = attempt * 1_500;

                console.log(
                    `♻️ Retrying post with a fresh detail page in ` +
                    `${delayMs / 1_000} seconds...`,
                );

                await sleep(delayMs);
                continue;
            }

            break;
        } finally {
            await closePageSafely(
                detailPage,
                `detail page for ${post.url}`,
            );
        }
    }

    throw lastError || new Error(
        `Could not extract post details for ${post.url}.`,
    );
}

async function processSearchTerm({
                                     context,
                                     query,
                                     termSource,
                                     runId,
                                     seenDuringRun,
                                 }) {
    const allPosts = await collectPostsForSearchTerm(
        context,
        query,
    );

    const existingAll = await getExistingUrls(allPosts);
    const crossTermUrls = new Set();
    const uniqueForThisRun = [];

    for (const post of allPosts) {
        const url = normalizePostUrl(post.url);

        if (seenDuringRun.has(url)) {
            crossTermUrls.add(url);
            continue;
        }

        seenDuringRun.add(url);
        uniqueForThisRun.push(post);
    }

    const auditRows = await logSearchObservations({
        runId,
        query,
        termSource,
        posts: allPosts,
        existingUrls: existingAll,
        crossTermUrls,
    });

    console.log(
        `🔁 Cross-term duplicate check: ` +
        `${crossTermUrls.size} already found during this run, ` +
        `${uniqueForThisRun.length} remain.`,
    );

    const existingUnique = new Set(
        uniqueForThisRun
            .map((post) => normalizePostUrl(post.url))
            .filter((url) => existingAll.has(url)),
    );

    const posts = uniqueForThisRun.filter(
        (post) =>
            !existingAll.has(normalizePostUrl(post.url)),
    );

    console.log(
        `🧱 Database duplicate check: ` +
        `${existingUnique.size} existing, ${posts.length} new candidate(s).`,
    );

    let inserted = 0;
    let failed = 0;

    for (let index = 0; index < posts.length; index += 1) {
        const post = posts[index];

        console.log(
            `\n[${index + 1}/${posts.length}] ` +
            `"${query}" → ${post.url}`,
        );

        try {
            const record =
                await extractPostDetailsWithFreshPage(
                    context,
                    post,
                    query,
                );

            console.dir(record, { depth: null });

            if (
                !record.description ||
                record.description.length < 10
            ) {
                console.log("⏭️ No usable description.");
                await markAuditError(
                    runId,
                    query,
                    post.url,
                    "No usable description",
                );
                failed += 1;
                continue;
            }

            const leadId =
                await insertUnfilteredGeneralContracting(record);

            await markAuditInserted(
                runId,
                query,
                post.url,
                leadId,
            );

            inserted += 1;
        } catch (error) {
            if (
                browserDisconnected ||
                isBrowserDisconnectedError(error)
            ) {
                throw error;
            }

            const message = getErrorMessage(error);

            console.error(
                `⏭️ Skipping post after fresh-page retries: ${message}`,
            );

            await markAuditError(
                runId,
                query,
                post.url,
                message,
            ).catch(() => {});

            failed += 1;
        }

        await sleep(
            650 + Math.floor(Math.random() * 700),
        );
    }

    console.log("");
    console.log("📊 TERM RESULT");
    console.log(`   Search term: ${query}`);
    console.log(`   Source: ${termSource}`);
    console.log(`   Result observations logged: ${auditRows}`);
    console.log(`   Cross-term duplicates: ${crossTermUrls.size}`);
    console.log(`   Existing DB posts: ${existingUnique.size}`);
    console.log(`   New candidates: ${posts.length}`);
    console.log(`   Inserted: ${inserted}`);
    console.log(`   Failed: ${failed}`);

    return {
        inserted,
        failed,
        auditRows,
        newCandidates: posts.length,
        existingSkipped: existingUnique.size,
        crossTermSkipped: crossTermUrls.size,
    };
}

async function triggerFtnEnrichment({
                                        totalInserted,
                                        totalFailed,
                                        totalExistingSkipped,
                                        totalCrossTermSkipped,
                                    }) {
    if (!CRM_API_BASE_URL) {
        throw new Error(
            "CRM_API_BASE_URL is missing. Set it to the host that serves " +
            ENRICHMENT_ENDPOINT_PATH,
        );
    }

    const endpointUrl =
        process.env.FTN_TRIGGER_URL ||
        new URL(
            ENRICHMENT_ENDPOINT_PATH,
            CRM_API_BASE_URL,
        ).toString();

    const payload = {
        source_table: TABLE_NAME,
        lead_type: ["general_contracting"],
        scrape_summary: {
            inserted: totalInserted,
            failed: totalFailed,
            existing_db_posts_skipped:
            totalExistingSkipped,
            cross_term_duplicates_skipped:
            totalCrossTermSkipped,
        },
    };

    const maxAttempts = Math.max(
        1,
        Number(process.env.FTN_TRIGGER_MAX_ATTEMPTS || 3),
    );

    const timeoutMs = Math.max(
        5_000,
        Number(process.env.FTN_TRIGGER_TIMEOUT_MS || 60_000),
    );

    let lastError = null;

    console.log("");
    console.log("============================================================");
    console.log("🚀 Sending FTN enrichment request...");
    console.log(`   Endpoint: ${endpointUrl}`);
    console.log(`   Source table: ${TABLE_NAME}`);
    console.log("============================================================");

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            console.log(
                `📡 FTN trigger attempt ${attempt}/${maxAttempts}...`,
            );

            const response = await fetch(endpointUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(timeoutMs),
            });

            const responseText = await response.text();

            console.log(
                `📡 FTN response status: ${response.status}`,
            );
            console.log(
                `📡 FTN response body: ` +
                `${responseText || "(empty body)"}`,
            );

            if (!response.ok) {
                throw new Error(
                    `FTN trigger returned HTTP ${response.status}: ` +
                    `${responseText || "(empty body)"}`,
                );
            }

            let responseBody = null;

            if (responseText) {
                try {
                    responseBody = JSON.parse(responseText);
                } catch {
                    responseBody = {
                        raw: responseText,
                    };
                }
            }

            if (responseBody?.success === false) {
                throw new Error(
                    `FTN trigger rejected the request: ` +
                    `${responseBody.error || responseText}`,
                );
            }

            console.log(
                "✅ FTN enrichment request was accepted.",
            );

            if (responseBody?.status) {
                console.log(
                    `   FTN status: ${responseBody.status}`,
                );
            }

            if (responseBody?.source_table) {
                console.log(
                    `   FTN source table: ` +
                    `${responseBody.source_table}`,
                );
            }

            if (
                responseBody?.queue_position !== undefined &&
                responseBody?.queue_position !== null
            ) {
                console.log(
                    `   Queue position: ` +
                    `${responseBody.queue_position}`,
                );
            }

            return responseBody;
        } catch (error) {
            lastError = error;

            console.error(
                `❌ FTN trigger attempt ${attempt} failed: ` +
                `${error.message}`,
            );

            if (attempt < maxAttempts) {
                const retryDelayMs = attempt * 3_000;

                console.log(
                    `⏳ Retrying FTN trigger in ` +
                    `${retryDelayMs / 1_000} seconds...`,
                );

                await sleep(retryDelayMs);
            }
        }
    }

    throw new Error(
        `FTN enrichment trigger failed after ${maxAttempts} ` +
        `attempt(s): ${lastError?.message || "unknown error"}`,
    );
}

async function main() {
    console.log(
        "🏗️ Nextdoor Adaptive General Contracting Scraper Started",
    );

    if (!process.env.MULTILOGIN_WS) {
        throw new Error("MULTILOGIN_WS is missing.");
    }

    const runId = crypto.randomUUID();
    const totals = {
        inserted: 0,
        failed: 0,
        existingSkipped: 0,
        crossTermSkipped: 0,
        newCandidates: 0,
        resultObservations: 0,
        uniqueResultUrls: 0,
    };

    let browser = null;
    let bootstrapPage = null;
    let searchRunFinalized = false;

    try {
        await purgeExpiredSearchHistory();

        const strategy = await buildAdaptiveSearchPlan();

        await createSearchRun(runId, strategy);

        console.log(`🆔 GC search run: ${runId}`);

        browser = await chromium.connectOverCDP(
            process.env.MULTILOGIN_WS,
        );

        browser.on("disconnected", () => {
            browserDisconnected = true;
            console.error(
                "💥 Playwright disconnected from the Multilogin browser.",
            );
        });

        const context = browser.contexts()[0];

        if (!context) {
            throw new Error(
                "No Multilogin browser context found.",
            );
        }

        // Use the combined scraper's safer lifecycle: validate one bootstrap
        // page, close stale restored tabs, then use disposable pages for each
        // search and each new-post detail extraction.
        bootstrapPage = await waitForNextdoorReady(
            context,
            180_000,
        );

        await closeStaleContextPages(context, bootstrapPage);
        await parkBootstrapPage(bootstrapPage);

        const seenDuringRun = new Set();

        for (
            let termIndex = 0;
            termIndex < strategy.plan.length;
            termIndex += 1
        ) {
            const entry = strategy.plan[termIndex];
            const query = entry.query;
            const termSource = entry.source;

            if (
                browserDisconnected ||
                !browser.isConnected()
            ) {
                throw new Error(
                    `BROWSER_DISCONNECTED before search term "${query}".`,
                );
            }

            console.log("");
            console.log("############################################################");
            console.log(
                `🔎 SEARCH ${termIndex + 1}/${strategy.plan.length}: ` +
                `"${query}" [${termSource}]`,
            );
            printTermHistory(query, strategy.performanceByTerm);
            console.log("############################################################");

            try {
                const result = await processSearchTerm({
                    context,
                    query,
                    termSource,
                    runId,
                    seenDuringRun,
                });

                totals.inserted += result.inserted;
                totals.failed += result.failed;
                totals.existingSkipped +=
                    result.existingSkipped;
                totals.crossTermSkipped +=
                    result.crossTermSkipped;
                totals.newCandidates +=
                    result.newCandidates;
                totals.resultObservations +=
                    result.auditRows;
            } catch (error) {
                if (
                    browserDisconnected ||
                    isBrowserDisconnectedError(error)
                ) {
                    throw error;
                }

                console.error(
                    `⏭️ Skipping search term "${query}" after ` +
                    `fresh-page retries: ${getErrorMessage(error)}`,
                );
                totals.failed += 1;
            }

            totals.uniqueResultUrls = seenDuringRun.size;
            await sleep(1_000);
        }

        console.log("");
        console.log(
            "============================================================",
        );
        console.log("✅ Adaptive general contracting scrape finished.");
        console.log(`   Run ID: ${runId}`);
        console.log(`   Search terms: ${strategy.plan.length}`);
        console.log(
            `   Result observations logged: ${totals.resultObservations}`,
        );
        console.log(
            `   Unique result URLs: ${totals.uniqueResultUrls}`,
        );
        console.log(`   New candidates: ${totals.newCandidates}`);
        console.log(`   Inserted: ${totals.inserted}`);
        console.log(`   Failed: ${totals.failed}`);
        console.log(
            `   Existing DB posts skipped: ${totals.existingSkipped}`,
        );
        console.log(
            `   Cross-term duplicates skipped: ${totals.crossTermSkipped}`,
        );
        console.log(
            `   Async target crashes recovered: ` +
            `${asynchronousTargetCrashCount}`,
        );
        console.log(
            "============================================================",
        );

        await finishSearchRun(runId, "completed", totals);
        searchRunFinalized = true;

        // The FTN pipeline is unchanged: the scraper still asks the internal
        // FTN service to run pre_enrichment first, then FamilyTreeNow.
        await triggerFtnEnrichment({
            totalInserted: totals.inserted,
            totalFailed: totals.failed,
            totalExistingSkipped: totals.existingSkipped,
            totalCrossTermSkipped: totals.crossTermSkipped,
        });

        console.log("");
        console.log(
            "✅ Scrape completed. FTN enrichment request was accepted.",
        );
    } catch (error) {
        if (!searchRunFinalized) {
            await finishSearchRun(
                runId,
                "failed",
                totals,
                getErrorMessage(error),
            ).catch((finishError) => {
                console.warn(
                    `⚠️ Could not finalize failed GC search run: ` +
                    `${getErrorMessage(finishError)}`,
                );
            });
        }

        throw error;
    } finally {
        console.log("🧹 Closing scraper resources...");

        await closePageSafely(
            bootstrapPage,
            "bootstrap page",
        );

        await pool.end().catch((error) => {
            console.warn(
                `⚠️ Could not close database pool: ${error.message}`,
            );
        });

        if (browser?.isConnected()) {
            await browser.close().catch((error) => {
                console.warn(
                    `⚠️ Could not close Multilogin browser: ${error.message}`,
                );
            });
        }

        console.log("✅ Scraper resources closed.");
    }
}

main()
    .then(async () => {
        console.log(
            "✅ Adaptive general contracting scraper completed successfully.",
        );
        console.log(
            "🛑 Force-terminating scraper process with exit code 0.",
        );

        // Briefly allow final log output to flush.
        await new Promise((resolve) => {
            setTimeout(resolve, 250);
        });

        process.exit(0);
    })
    .catch(async (error) => {
        console.error(
            "❌ Fatal scraper error:",
            error?.stack || error?.message || error,
        );

        await pool.end().catch(() => {});

        process.exit(1);
    });

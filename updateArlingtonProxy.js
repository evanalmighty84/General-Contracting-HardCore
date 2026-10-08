#!/usr/bin/env node

"use strict";

require("dotenv").config();

const crypto = require("node:crypto");

const PROFILE_ID = process.env.PROFILE_ID;
const PROFILE_UPDATE_URL =
    process.env.MULTILOGIN_PROFILE_UPDATE_URL ||
    "https://api.multilogin.com/profile/partial_update";

// Same refreshed Smartproxy pool currently used by the FTN service.
// Override the list or selected index from Railway without changing code.
const PROXY_HOSTS = String(
    process.env.ARLINGTON_PROXY_HOSTS ||
    "204.77.129.143,207.228.200.92,23.231.0.74",
)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

const PROXY_PORT = Number(process.env.ARLINGTON_PROXY_PORT || 6014);
const PROXY_INDEX = Number.parseInt(
    process.env.ARLINGTON_PROXY_INDEX || "0",
    10,
);

const PROXY_USER =
    process.env.ARLINGTON_PROXY_USER ||
    process.env.PROXY_USER ||
    process.env.SMARTPROXY_USER ||
    process.env.FTN_PROXY_USER ||
    "";

const PROXY_PASS =
    process.env.ARLINGTON_PROXY_PASS ||
    process.env.PROXY_PASS ||
    process.env.SMARTPROXY_PASS ||
    process.env.FTN_PROXY_PASS ||
    "";

function selectedProxyHost() {
    if (!PROXY_HOSTS.length) {
        throw new Error("ARLINGTON_PROXY_HOSTS contains no usable proxy hosts.");
    }

    const safeIndex = Number.isFinite(PROXY_INDEX)
        ? ((PROXY_INDEX % PROXY_HOSTS.length) + PROXY_HOSTS.length) %
          PROXY_HOSTS.length
        : 0;

    return {
        host: PROXY_HOSTS[safeIndex],
        index: safeIndex,
    };
}

async function readBody(response) {
    const text = await response.text();

    if (!text) {
        return {};
    }

    try {
        return JSON.parse(text);
    } catch {
        return { rawResponse: text };
    }
}

async function getToken() {
    if (process.env.MULTILOGIN_TOKEN) {
        console.log("ℹ️ Using MULTILOGIN_TOKEN for Arlington proxy update.");
        return process.env.MULTILOGIN_TOKEN.trim();
    }

    const email = process.env.MULTILOGIN_EMAIL;
    const password = process.env.MULTILOGIN_PASSWORD;
    const configuredMd5 = process.env.MULTILOGIN_PASSWORD_MD5;

    if (!email) {
        throw new Error(
            "Set MULTILOGIN_TOKEN or MULTILOGIN_EMAIL plus a Multilogin password.",
        );
    }

    const passwordMd5 =
        configuredMd5 ||
        (password
            ? crypto.createHash("md5").update(password).digest("hex")
            : null);

    if (!passwordMd5) {
        throw new Error(
            "Set MULTILOGIN_PASSWORD or MULTILOGIN_PASSWORD_MD5.",
        );
    }

    console.log("🔐 Signing in to Multilogin for Arlington proxy update...");

    const response = await fetch("https://api.multilogin.com/user/signin", {
        method: "POST",
        headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            email,
            password: passwordMd5,
        }),
    });

    const body = await readBody(response);

    if (!response.ok) {
        throw new Error(
            `Multilogin sign-in failed with HTTP ${response.status}: ` +
                JSON.stringify(body),
        );
    }

    const token = body?.data?.token || body?.data?.refresh_token;

    if (!token) {
        throw new Error(
            `Multilogin sign-in returned no token: ${JSON.stringify(body)}`,
        );
    }

    console.log("✅ Fresh Multilogin token received.");
    return token;
}

async function updateProxy(token) {
    if (!PROFILE_ID) {
        throw new Error("PROFILE_ID is required.");
    }

    if (!PROXY_USER || !PROXY_PASS) {
        throw new Error(
            "Arlington Smartproxy credentials are missing. Set " +
                "ARLINGTON_PROXY_USER and ARLINGTON_PROXY_PASS (or PROXY_USER/PROXY_PASS).",
        );
    }

    const selected = selectedProxyHost();

    console.log("🔄 Updating Arlington Multilogin proxy...");
    console.log(`   Profile: ${PROFILE_ID}`);
    console.log(
        `   Proxy:   ${selected.host}:${PROXY_PORT} ` +
            `(pool index ${selected.index}/${PROXY_HOSTS.length - 1})`,
    );

    const response = await fetch(PROFILE_UPDATE_URL, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            profile_id: PROFILE_ID,
            proxy: {
                host: selected.host,
                type: "http",
                port: PROXY_PORT,
                username: PROXY_USER,
                password: PROXY_PASS,
            },
            parameters: {
                flags: {
                    proxy_masking: "custom",
                },
            },
        }),
    });

    const body = await readBody(response);

    if (!response.ok) {
        throw new Error(
            `Arlington proxy update failed with HTTP ${response.status}: ` +
                JSON.stringify(body),
        );
    }

    console.log(
        `✅ Arlington Multilogin proxy updated to ${selected.host}:${PROXY_PORT}.`,
    );
}

(async () => {
    const token = await getToken();
    await updateProxy(token);
})().catch((error) => {
    console.error("❌ Arlington proxy update failed:", error?.stack || error);
    process.exit(1);
});

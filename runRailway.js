#!/usr/bin/env node

"use strict";

require("dotenv").config();

const { spawn } = require("node:child_process");
const pool = require("./db/db");

const sleep = (ms) =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

function required(name) {
    const value = process.env[name];

    if (!value) {
        throw new Error(`${name} is required`);
    }

    return value;
}

async function getWebSocket(port, timeoutMs = 60_000) {
    const host = process.env.MULTILOGIN_BROWSER_HOST || "127.0.0.1";
    const deadline = Date.now() + timeoutMs;
    let lastError = "";

    console.log(`🔌 Waiting for browser WebSocket on ${host}:${port}...`);

    while (Date.now() < deadline) {
        try {
            const response = await fetch(
                `http://${host}:${port}/json/version`,
            );

            if (response.ok) {
                const payload = await response.json();

                if (payload.webSocketDebuggerUrl) {
                    return payload.webSocketDebuggerUrl;
                }

                lastError =
                    "The browser responded, but webSocketDebuggerUrl was missing.";
            } else {
                lastError = `HTTP ${response.status}`;
            }
        } catch (error) {
            lastError = error?.message || String(error);
        }

        await sleep(1_000);
    }

    throw new Error(
        `No browser WebSocket became available on port ${port}. ` +
        `Last error: ${lastError || "unknown"}`,
    );
}

function runScraper(ws) {
    return new Promise((resolve, reject) => {
        console.log("▶️ Launching nextdoor_unfiltered_general_contracting.js...");

        const child = spawn(
            process.execPath,
            ["nextdoor_unfiltered_general_contracting.js"],
            {
                cwd: __dirname,
                stdio: "inherit",
                env: {
                    ...process.env,
                    MULTILOGIN_WS: ws,
                },
            },
        );

        child.once("error", reject);

        child.once("exit", (code, signal) => {
            if (code === 0) {
                resolve();
                return;
            }

            reject(
                new Error(
                    `Scraper exited with code ${code ?? "null"}` +
                    `${signal ? ` and signal ${signal}` : ""}`,
                ),
            );
        });
    });
}

async function main() {
    // checkCoreDownload.js starts the Multilogin profile and injects this
    // dynamic port when spawning runRailway.js.
    const portText = required("MULTILOGIN_PORT");
    const port = Number.parseInt(portText, 10);

    if (!Number.isInteger(port) || port <= 0) {
        throw new Error(
            `MULTILOGIN_PORT must be a positive integer. Received: ${portText}`,
        );
    }

    console.log("=== Railway Lights Automation ===");
    console.log(`Multilogin port: ${port}`);
    console.log(
        "ℹ️ The profile is already running; this process will not start, " +
        "restart, kill, or stop it.",
    );

    const ws = await getWebSocket(port);

    console.log(
        `✅ Browser WebSocket ready: ${ws.replace(
            /\/devtools\/browser\/.+$/,
            "/devtools/browser/[hidden]",
        )}`,
    );

    await runScraper(ws);

    console.log("✅ Railway lights automation completed.");
}

main()
    .catch((error) => {
        console.error(
            "❌ Railway lights automation failed:",
            error?.stack || error,
        );
        process.exitCode = 1;
    })
    .finally(async () => {
        await pool.end().catch((error) => {
            console.warn(
                `⚠️ Database pool shutdown warning: ${
                    error?.message || String(error)
                }`,
            );
        });

        process.exit(process.exitCode || 0);
    });

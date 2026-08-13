#!/usr/bin/env node

// checkCoreDownload.js
// Keeps a Railway/Linux container alive while Multilogin downloads its core.
// It waits indefinitely, retries conservatively, and does not stop the profile
// or exit after the profile starts.
//
// Usage:
//   node checkCoreDownload.js
//
// Required environment variables:
//   PROFILE_ID
//   Folder ID is hard-coded below.
//
// Authentication:
//   MULTILOGIN_TOKEN
//   OR
//   MULTILOGIN_EMAIL + MULTILOGIN_PASSWORD
//   OR
//   MULTILOGIN_EMAIL + MULTILOGIN_PASSWORD_MD5

require("dotenv").config();

const crypto = require("node:crypto");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const LAUNCHER_BASE =
    process.env.MULTILOGIN_LAUNCHER_URL ||
    "https://launcher.mlx.yt:45001";

const PROFILE_UPDATE_URL =
    process.env.MULTILOGIN_PROFILE_UPDATE_URL ||
    "https://api.multilogin.com/profile/partial_update";

const PROFILE_ID = process.env.PROFILE_ID;
const FOLDER_ID = "f2f07075-63ff-49dc-be6b-929a9872fac7";

const HEALTH_CHECK_INTERVAL_MS = 60_000;
const DOWNLOAD_RETRY_INTERVAL_MS = 5 * 60_000;
const ERROR_RETRY_INTERVAL_MS = 3 * 60_000;
const LOCK_RETRY_INTERVAL_MS = 60_000;
const START_REQUEST_TIMEOUT_MS = 10 * 60_000;
const HEALTH_REQUEST_TIMEOUT_MS = 30_000;
const SIGNIN_REQUEST_TIMEOUT_MS = 60_000;
const PROFILE_UPDATE_TIMEOUT_MS = 60_000;
const STORAGE_LOG_INTERVAL_MS = 5 * 60_000;

const RAILWAY_CHROMIUM_FLAGS = [
    { flag: "no-sandbox" },
    { flag: "disable-setuid-sandbox" },
    { flag: "disable-dev-shm-usage" },
];

const sleep = (ms) =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

function timestamp() {
    return new Date().toISOString();
}

function describeError(error) {
    return {
        name: error?.name || null,
        message: error?.message || String(error),
        causeCode: error?.cause?.code || null,
        causeMessage: error?.cause?.message || null,
    };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30_000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        return await fetch(url, {
            ...options,
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeout);
    }
}

async function readResponseBody(response) {
    const text = await response.text();

    if (!text) {
        return {};
    }

    try {
        return JSON.parse(text);
    } catch {
        return {
            rawResponse: text,
        };
    }
}

async function checkLauncherHealth() {
    try {
        const response = await fetchWithTimeout(
            `${LAUNCHER_BASE}/api/v1/version`,
            {
                headers: {
                    Accept: "application/json",
                },
            },
            HEALTH_REQUEST_TIMEOUT_MS,
        );

        const body = await readResponseBody(response);

        return {
            healthy: response.ok,
            status: response.status,
            body,
        };
    } catch (error) {
        return {
            healthy: false,
            error: describeError(error),
        };
    }
}

async function getToken() {
    if (process.env.MULTILOGIN_TOKEN) {
        console.log("ℹ️ Using MULTILOGIN_TOKEN from environment variables.");
        return process.env.MULTILOGIN_TOKEN.trim();
    }

    const email = process.env.MULTILOGIN_EMAIL;
    const plainPassword = process.env.MULTILOGIN_PASSWORD;
    const configuredMd5 = process.env.MULTILOGIN_PASSWORD_MD5;

    if (!email) {
        throw new Error(
            "Set MULTILOGIN_TOKEN or MULTILOGIN_EMAIL with a password.",
        );
    }

    const passwordMd5 =
        configuredMd5 ||
        (plainPassword
            ? crypto.createHash("md5").update(plainPassword).digest("hex")
            : null);

    if (!passwordMd5) {
        throw new Error(
            "Set MULTILOGIN_PASSWORD or MULTILOGIN_PASSWORD_MD5.",
        );
    }

    console.log("🔐 Signing in to Multilogin for a fresh token...");

    const response = await fetchWithTimeout(
        "https://api.multilogin.com/user/signin",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            body: JSON.stringify({
                email,
                password: passwordMd5,
            }),
        },
        SIGNIN_REQUEST_TIMEOUT_MS,
    );

    const body = await readResponseBody(response);

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


async function applyRailwayChromiumFlags(token) {
    console.log("");
    console.log("🛠️ Applying Railway Chromium flags to the Multilogin profile...");
    console.log(`   Profile: ${PROFILE_ID}`);
    console.log(`   Endpoint: ${PROFILE_UPDATE_URL}`);
    console.log(
        `   Flags: ${RAILWAY_CHROMIUM_FLAGS.map((item) => `--${item.flag}`).join(", ")}`,
    );

    try {
        const response = await fetchWithTimeout(
            PROFILE_UPDATE_URL,
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: "application/json",
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    profile_id: PROFILE_ID,
                    parameters: {
                        fingerprint: {
                            cmd_params: {
                                params: RAILWAY_CHROMIUM_FLAGS,
                            },
                        },
                    },
                }),
            },
            PROFILE_UPDATE_TIMEOUT_MS,
        );

        const body = await readResponseBody(response);

        if (!response.ok) {
            return {
                ok: false,
                status: response.status,
                body,
            };
        }

        console.log("✅ Railway Chromium flags were saved to Multilogin.");
        console.log(
            "   The next browser command should include " +
            "--no-sandbox, --disable-setuid-sandbox, and " +
            "--disable-dev-shm-usage.",
        );
        console.log("");

        return {
            ok: true,
            status: response.status,
            body,
        };
    } catch (error) {
        return {
            ok: false,
            error: describeError(error),
        };
    }
}
async function clearChromeSingletonFiles() {
    const profileDir =
        "/root/mlx/profiles/" +
        "5adfd699-e98a-4069-bf05-8004911108aa/" +
        `${FOLDER_ID}/${PROFILE_ID}`;

    console.log("🧹 Clearing stale Chrome singleton files...");
    console.log(`   Profile directory: ${profileDir}`);

    try {
        const { stdout, stderr } = await execFileAsync("sh", [
            "-c",
            [
                `profile_dir='${profileDir}'`,
                'find "$profile_dir" -maxdepth 2 -type f \\( -name "SingletonLock" -o -name "SingletonSocket" -o -name "SingletonCookie" -o -name "DevToolsActivePort" \\) -print -delete 2>/dev/null || true',
                'find "$profile_dir" -maxdepth 2 -type l \\( -name "SingletonLock" -o -name "SingletonSocket" -o -name "SingletonCookie" \\) -print -delete 2>/dev/null || true',
            ].join("; "),
        ]);

        if (stdout.trim()) {
            console.log("   Removed:");
            console.log(stdout.trim());
        } else {
            console.log("   No stale singleton files were found.");
        }

        if (stderr.trim()) {
            console.log(`   Cleanup warning: ${stderr.trim()}`);
        }
    } catch (error) {
        console.log(
            `⚠️ Singleton cleanup failed: ${
                describeError(error).message
            }`,
        );
    }
}
async function applyRailwayChromiumFlagsForever(initialToken) {
    let token = initialToken;

    while (true) {
        const result = await applyRailwayChromiumFlags(token);

        if (result.ok) {
            return token;
        }

        if (
            result.status === 401 ||
            result.status === 403 ||
            String(result.body?.status?.message || "")
                .toLowerCase()
                .includes("token")
        ) {
            console.error(
                `[${timestamp()}] Multilogin rejected the token during the profile update.`,
            );
            console.log("  -> Getting a fresh token...");
            token = await acquireTokenForever();
            await sleep(5_000);
            continue;
        }

        if (result.error) {
            console.error(
                `[${timestamp()}] Profile flag update request failed: ` +
                `${result.error.message}`,
            );

            if (result.error.causeCode || result.error.causeMessage) {
                console.error(
                    `  -> Cause: ${result.error.causeCode || "unknown"} ` +
                    `${result.error.causeMessage || ""}`,
                );
            }
        } else {
            console.error(
                `[${timestamp()}] Profile flag update failed ` +
                `(HTTP ${result.status}): ${JSON.stringify(result.body)}`,
            );
        }

        console.log(
            "  -> Waiting 3 minutes before retrying the profile update...",
        );
        await sleep(ERROR_RETRY_INTERVAL_MS);
    }
}
async function stopExistingProfile(token) {
    const url =
        `${LAUNCHER_BASE}/api/v1/profile/stop/p/` +
        encodeURIComponent(PROFILE_ID);

    console.log("🛑 Requesting stop for any existing profile session...");

    try {
        const response = await fetchWithTimeout(
            url,
            {
                method: "GET",
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: "application/json",
                },
            },
            60_000,
        );

        const body = await readResponseBody(response);
        const message = String(body?.status?.message || "");

        if (
            response.ok ||
            message.toLowerCase().includes("already stopped")
        ) {
            console.log("✅ Existing profile session is stopped.");
            return;
        }

        console.log(
            `⚠️ Profile stop returned HTTP ${response.status}: ` +
            JSON.stringify(body),
        );
    } catch (error) {
        console.log(
            `⚠️ Profile stop request failed: ${
                describeError(error).message
            }`,
        );
    }
}
async function tryStartProfile(token) {
    const url =
        `${LAUNCHER_BASE}/api/v2/profile/f/${encodeURIComponent(FOLDER_ID)}` +
        `/p/${encodeURIComponent(PROFILE_ID)}` +
        "/start?automation_type=playwright&headless_mode=true";

    try {
        const response = await fetchWithTimeout(
            url,
            {
                method: "GET",
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: "application/json",
                },
            },
            START_REQUEST_TIMEOUT_MS,
        );

        const body = await readResponseBody(response);

        return {
            ok: response.ok,
            status: response.status,
            body,
        };
    } catch (error) {
        const details = describeError(error);

        return {
            ok: false,
            error:
                details.name === "AbortError"
                    ? `Profile start request timed out after ${
                        START_REQUEST_TIMEOUT_MS / 60_000
                    } minutes`
                    : details.message,
            details,
        };
    }
}

async function logMultiloginStorage() {
    try {
        const { stdout } = await execFileAsync("sh", [
            "-c",
            [
                'printf "Size: "',
                'du -sh /root/mlx 2>/dev/null | awk \'{print $1}\' || printf "unknown"',
                'printf " | Files: "',
                'find /root/mlx -type f 2>/dev/null | wc -l || printf "unknown"',
            ].join("; "),
        ]);

        console.log(`💾 /root/mlx ${stdout.trim()}`);
    } catch (error) {
        console.log(
            `💾 Could not inspect /root/mlx: ${describeError(error).message}`,
        );
    }
}

async function waitWithStorageUpdates(totalMs) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < totalMs) {
        const elapsed = Date.now() - startedAt;
        const remaining = totalMs - elapsed;
        const delay = Math.min(STORAGE_LOG_INTERVAL_MS, remaining);

        await sleep(delay);
        await logMultiloginStorage();
    }
}

function isAuthenticationFailure(result) {
    const status = result?.status;
    const errorCode = result?.body?.status?.error_code;
    const message = String(result?.body?.status?.message || "").toLowerCase();

    return (
        status === 401 ||
        status === 403 ||
        errorCode === "UNAUTHORIZED" ||
        errorCode === "INVALID_TOKEN" ||
        message.includes("token") ||
        message.includes("unauthorized")
    );
}
async function printLauncherDiagnostics() {
    try {
        const { stdout } = await execFileAsync("sh", [
            "-c",
            `
      echo "===== LAUNCHER PROCESS ====="
      ps aux | grep -E '[l]auncher|[m]imic|[c]hrome' || true

      echo "===== RECENT LAUNCHER LOG ====="
      if [ -f /tmp/mlx-launcher.log ]; then
        tail -n 150 /tmp/mlx-launcher.log
      else
        echo "/tmp/mlx-launcher.log was not found"
      fi

      echo "===== MULTILOGIN LOG FILES ====="
      find /root/mlx -type f \\( -iname "*.log" -o -iname "*log*" \\) \
        -printf '%T@ %p\\n' 2>/dev/null \
        | sort -nr \
        | head -20 \
        | cut -d' ' -f2-

      echo "===== RECENT MULTILOGIN LOG CONTENT ====="
      for file in $(find /root/mlx -type f \\( -iname "*.log" -o -iname "*log*" \\) \
        -printf '%T@ %p\\n' 2>/dev/null \
        | sort -nr \
        | head -5 \
        | cut -d' ' -f2-); do
          echo
          echo "--- $file ---"
          tail -n 100 "$file" 2>/dev/null || true
      done

      echo "===== MEMORY ====="
      free -h || true

      echo "===== DISK ====="
      df -h /root/mlx /tmp || true

      echo "===== SHARED MEMORY ====="
      df -h /dev/shm || true

      echo "===== CORE EXECUTABLES ====="
      find /root/mlx/deps/mimic_150.4 -maxdepth 3 -type f -perm /111 \
        -ls 2>/dev/null \
        | head -30
      `,
        ]);

        console.log(stdout);
    } catch (error) {
        console.log(
            `Launcher diagnostics failed: ${error?.message || String(error)}`,
        );
    }
}

async function acquireTokenForever() {
    while (true) {
        try {
            return await getToken();
        } catch (error) {
            console.error(
                `[${timestamp()}] Could not acquire token: ${describeError(error).message}`,
            );
            console.log("  -> Waiting 3 minutes before trying sign-in again...");
            await sleep(ERROR_RETRY_INTERVAL_MS);
        }
    }
}


function runRailwayAutomation(port) {
    return new Promise((resolve, reject) => {
        console.log("");
        console.log("============================================================");
        console.log(`🎭 Starting Railway automation on Multilogin port ${port}.`);
        console.log("============================================================");
        console.log("");

        const child = spawn(
            process.execPath,
            ["/app/runRailway.js"],
            {
                cwd: "/app",
                stdio: "inherit",
                env: {
                    ...process.env,
                    MULTILOGIN_PORT: String(port),
                },
            },
        );

        child.once("error", reject);

        child.once("exit", (code, signal) => {
            if (code === 0) {
                console.log("✅ runRailway.js completed successfully.");
                resolve();
                return;
            }

            reject(
                new Error(
                    `runRailway.js exited with code ${code ?? "null"}` +
                    `${signal ? ` and signal ${signal}` : ""}`,
                ),
            );
        });
    });
}


async function main() {
    console.log("=== Multilogin Core Download Monitor ===");
    console.log(`Launcher:       ${LAUNCHER_BASE}`);
    console.log(`Profile update: ${PROFILE_UPDATE_URL}`);
    console.log(`Folder:         ${FOLDER_ID || "(not set)"}`);
    console.log(`Profile:  ${PROFILE_ID || "(not set)"}`);
    console.log("Mode:     run automation once and exit");
    console.log("");

    if (!PROFILE_ID) {
        throw new Error("PROFILE_ID is required.");
    }

    let token = await acquireTokenForever();

    // Persist the Railway-safe Chromium flags before the first start attempt.
    // This is idempotent, so it is safe to run again after a redeploy.
    token = await applyRailwayChromiumFlagsForever(token);

    await stopExistingProfile(token);

    console.log(
        "⏳ Waiting 15 seconds for the previous browser session to release...",
    );
    await sleep(15_000);

    await clearChromeSingletonFiles();

    let attempt = 0;

    await logMultiloginStorage();

    while (true) {
        attempt += 1;

        const now = timestamp();
        const health = await checkLauncherHealth();

        if (!health.healthy) {
            console.log(
                `[${now}] Launcher is not healthy: ${JSON.stringify(
                    health.error || health.status,
                )}`,
            );
            console.log("  -> Waiting 1 minute before checking again...");
            await sleep(HEALTH_CHECK_INTERVAL_MS);
            continue;
        }

        console.log(`[${now}] Launcher healthy. Start attempt ${attempt}.`);

        const result = await tryStartProfile(token);

        if (result.error) {
            console.log(`[${timestamp()}] Profile start request failed: ${result.error}`);

            if (result.details?.causeCode || result.details?.causeMessage) {
                console.log(
                    `  -> Cause: ${result.details.causeCode || "unknown"} ` +
                    `${result.details.causeMessage || ""}`,
                );
            }

            await printLauncherDiagnostics();
            console.log("  -> Waiting 3 minutes before retrying...");
            await waitWithStorageUpdates(ERROR_RETRY_INTERVAL_MS);
            continue;
        }

        if (isAuthenticationFailure(result)) {
            console.log(
                `[${timestamp()}] Multilogin rejected the current token. Getting a fresh token...`,
            );
            token = await acquireTokenForever();
            token = await applyRailwayChromiumFlagsForever(token);
            await sleep(10_000);
            continue;
        }

        const errorCode = result.body?.status?.error_code;
        const message = String(result.body?.status?.message || "");
        const port = result.body?.data?.port;

        if (port) {
            try {
                await runRailwayAutomation(port);

                console.log("");
                console.log("============================================================");
                console.log("✅ Railway automation completed successfully.");
                console.log("✅ Cron execution will now exit.");
                console.log("============================================================");

                return;
            } catch (error) {
                console.error(
                    `[${timestamp()}] Railway automation failed:`,
                    error?.stack || error,
                );

                throw error;
            }
        }

        if (
            errorCode === "CORE_DOWNLOADING_STARTED" ||
            message.toLowerCase().includes("downloading")
        ) {
            console.log(
                `[${timestamp()}] Multilogin core download is in progress: ${
                    message || errorCode
                }`,
            );
            console.log(
                "  -> Waiting 5 minutes before making another profile-start request...",
            );
            await waitWithStorageUpdates(DOWNLOAD_RETRY_INTERVAL_MS);
            continue;
        }

        if (errorCode === "LOCK_PROFILE_ERROR") {
            console.log(
                `[${timestamp()}] Profile is temporarily locked: ${
                    message || errorCode
                }`,
            );
            console.log("  -> Waiting 1 minute before retrying...");
            await sleep(LOCK_RETRY_INTERVAL_MS);
            continue;
        }

        console.log(
            `[${timestamp()}] Unexpected Multilogin response ` +
            `(HTTP ${result.status}): ${JSON.stringify(result.body)}`,
        );
        console.log("  -> Waiting 3 minutes before retrying...");
        await waitWithStorageUpdates(ERROR_RETRY_INTERVAL_MS);
    }
}

process.on("SIGTERM", () => {
    console.log(
        `[${timestamp()}] SIGTERM received. Railway is stopping the container.`,
    );

    process.exit(0);
});

process.on("SIGINT", () => {
    console.log(
        `[${timestamp()}] SIGINT received. Process will now stop.`,
    );

    process.exit(0);
});

main()
    .then(() => {
        console.log(
            `[${timestamp()}] checkCoreDownload.js completed successfully.`,
        );

        process.exit(0);
    })
    .catch((error) => {
        console.error(
            `[${timestamp()}] Fatal automation error:`,
            error?.stack || error,
        );

        process.exit(1);
    });

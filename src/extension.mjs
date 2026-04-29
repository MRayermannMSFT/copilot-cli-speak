/*---------------------------------------------------------------------------------------------
 *  Speak Extension for GitHub Copilot CLI
 *  Text-to-speech using Kokoro via sherpa-onnx (native C++ inference)
 *  TTS runs in a separate Node process to handle native addon architecture mismatches
 *--------------------------------------------------------------------------------------------*/

import { joinSession } from "@github/copilot-sdk/extension";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { platform as osPlatform } from "node:os";

const __dirname = process.env.EXTENSION_PATH
    ? dirname(process.env.EXTENSION_PATH)
    : dirname(fileURLToPath(import.meta.url));

const SETTINGS_PATH = join(__dirname, ".cache", "settings.json");
const MODEL_DIR = join(__dirname, ".cache", "kokoro-en-v0_19");
const WORKER_PATH = join(__dirname, "tts-worker.mjs");
const LOG_PATH = join(__dirname, ".cache", "debug.log");
const MAX_CHARS = 500;

import { appendFileSync, mkdirSync } from "node:fs";
function log(msg) {
    try {
        mkdirSync(dirname(LOG_PATH), { recursive: true });
        appendFileSync(LOG_PATH, `${new Date().toISOString()} [ext] ${msg}\n`);
    } catch {}
}

// ── State ──────────────────────────────────────────────────────────

let speakEnabled = false;
let defaultEnabled = false;
let speed = 1.0;
let requireBluetooth = false;

// ── Bluetooth Detection ────────────────────────────────────────────

import { execSync } from "node:child_process";

function isBluetoothAudioConnected() {
    try {
        const os = osPlatform();
        if (os === "win32") {
            // Get actual BT device names (filter out infra/driver entries)
            const btOut = execSync(
                'powershell.exe -NoProfile -Command "Get-PnpDevice -Class Bluetooth -Status OK | Select-Object -ExpandProperty FriendlyName"',
                { encoding: "utf-8", windowsHide: true, timeout: 5000 },
            );
            const infraPatterns = /enumerator|transport|driver|rfcomm|service|uart|fastconnect/i;
            const btNames = btOut.split("\n").map((l) => l.trim()).filter((n) => n && !infraPatterns.test(n));

            // Get ALL audio endpoints (any status — BT shows as Unknown when idle, OK when active)
            const audioOut = execSync(
                'powershell.exe -NoProfile -Command "Get-PnpDevice -Class AudioEndpoint | Select-Object -ExpandProperty FriendlyName"',
                { encoding: "utf-8", windowsHide: true, timeout: 5000 },
            );
            const audioNames = audioOut.split("\n").map((l) => l.trim()).filter(Boolean);

            // Cross-reference: audio endpoint name contains a BT device name
            const btAudio = audioNames.filter((audio) =>
                btNames.some((bt) => audio.toLowerCase().includes(bt.toLowerCase())),
            );

            log(`BT detection (win32): bt=[${btNames.join(", ")}], matched=[${btAudio.join(", ")}]`);
            return btAudio.length > 0;
        }
        if (os === "darwin") {
            const out = execSync(
                'system_profiler SPBluetoothDataType 2>/dev/null',
                { encoding: "utf-8", timeout: 5000 },
            );
            const hasConnectedAudio = /Connected: Yes[\s\S]*?Minor Type:\s*(Headphones|Headset|Loudspeaker)/i.test(out);
            const nameMatch = out.match(/(?:^|\n)\s{6}(\S[^\n:]+):\n[\s\S]*?Connected: Yes/m);
            const deviceName = nameMatch ? nameMatch[1].trim() : "unknown";
            log(`BT detection (darwin): ${hasConnectedAudio ? `found: ${deviceName}` : "none"}`);
            return hasConnectedAudio;
        }
        log("BT detection: unsupported platform, allowing speak");
        return true;
    } catch (err) {
        log(`BT detection error: ${err.message}`);
        return true;
    }
}

// ── Settings persistence ───────────────────────────────────────────

async function loadSettings() {
    try {
        const data = JSON.parse(await readFile(SETTINGS_PATH, "utf-8"));
        defaultEnabled = !!data.defaultEnabled;
        speakEnabled = defaultEnabled;
        if (typeof data.speed === "number" && data.speed >= 0.5 && data.speed <= 2.0) {
            speed = data.speed;
        }
        if (typeof data.requireBluetooth === "boolean") {
            requireBluetooth = data.requireBluetooth;
        }
    } catch {
        // No settings file yet
    }
}

async function saveSettings() {
    await mkdir(dirname(SETTINGS_PATH), { recursive: true });
    await writeFile(SETTINGS_PATH, JSON.stringify({ defaultEnabled, speed, requireBluetooth }), "utf-8");
}

// ── Model Download ─────────────────────────────────────────────────

const MODEL_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-en-v0_19.tar.bz2";

async function ensureModelDownloaded(logFn) {
    if (existsSync(join(MODEL_DIR, "model.onnx"))) return;

    if (logFn) logFn("📦 Downloading TTS model (~305MB) — this only happens once…");

    await mkdir(MODEL_DIR, { recursive: true });
    const tarPath = join(MODEL_DIR, ".download.tar.bz2");

    try {
        // Download
        const response = await fetch(MODEL_URL);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        await writeFile(tarPath, buffer);

        // Extract
        await new Promise((resolve, reject) => {
            const proc = execFile("tar", ["-xf", tarPath, "-C", dirname(MODEL_DIR)],
                { timeout: 120000 }, (err) => err ? reject(err) : resolve());
        });

        if (logFn) logFn("✅ TTS model ready");
    } finally {
        await unlink(tarPath).catch(() => {});
    }
}

// ── TTS via Persistent Worker Process ──────────────────────────────

import { fork } from "node:child_process";

let worker = null;
let workerReady = null;
let requestId = 0;
const pendingRequests = new Map();

function ensureWorker() {
    if (worker && !worker.killed) return workerReady;

    log("spawning persistent TTS worker...");
    const nodeCmd = osPlatform() === "win32" ? "node.exe" : "node";

    workerReady = new Promise((resolveReady) => {
        const child = fork(WORKER_PATH, [__dirname], {
            execPath: nodeCmd,
            stdio: ["pipe", "ignore", "ignore", "ipc"],
            windowsHide: true,
            execArgv: [],
        });

        child.on("message", (msg) => {
            if (msg.type === "ready") {
                log("worker ready");
                resolveReady();
            } else if (msg.type === "done" || msg.type === "error") {
                const pending = pendingRequests.get(msg.id);
                if (pending) {
                    pendingRequests.delete(msg.id);
                    if (msg.type === "error") pending.reject(new Error(msg.error));
                    else pending.resolve();
                }
            }
        });

        child.on("exit", (code) => {
            log(`worker exited with code ${code}`);
            worker = null;
            // Reject any pending requests
            for (const [id, p] of pendingRequests) {
                p.reject(new Error("Worker exited"));
                pendingRequests.delete(id);
            }
        });

        child.on("error", (err) => {
            log(`worker error: ${err.message}`);
        });

        worker = child;
    });

    return workerReady;
}

async function spawnSpeech(text) {
    await ensureWorker();
    const id = ++requestId;
    return new Promise((resolve, reject) => {
        pendingRequests.set(id, { resolve, reject });
        worker.stdin.write(JSON.stringify({ type: "speak", text, speed, id }) + "\n");
    });
}

// ── Text Sanitization ──────────────────────────────────────────────

function sanitizeText(text) {
    return text
        .replace(/```[\s\S]*?```/g, " code block ")
        .replace(/`[^`]+`/g, " code ")
        .replace(/[#*_~>|]/g, "")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

// ── Speak Queue ────────────────────────────────────────────────────

let speechQueue = Promise.resolve();

function enqueueSpeech(text) {
    const sanitized = sanitizeText(text).slice(0, MAX_CHARS);
    if (!sanitized) return;

    const job = speechQueue.then(async () => {
        await ensureModelDownloaded();
        await spawnSpeech(sanitized);
    });

    speechQueue = job.catch((err) => {
        console.error("[speak] TTS/playback error:", err);
    });
}

// ── Extension Entry Point ──────────────────────────────────────────

await loadSettings();
log(`startup: enabled=${speakEnabled}, speed=${speed}, requireBT=${requireBluetooth}`);

const session = await joinSession({
    commands: [
        {
            name: "speak",
            description: "Configure speak mode settings",
            handler: async () => {
                log("command /speak invoked");

                const result = await session.ui.elicitation({
                    message: "Speak mode settings",
                    requestedSchema: {
                        type: "object",
                        properties: {
                            enabled: {
                                type: "string",
                                title: "Speak mode",
                                description: "Enable or disable speak mode for this session",
                                enum: ["on", "off"],
                                default: speakEnabled ? "on" : "off",
                            },
                            speed: {
                                type: "number",
                                title: "Speaking speed",
                                description: "0.5 = slow, 1.0 = normal, 2.0 = fast",
                                minimum: 0.5,
                                maximum: 2.0,
                                default: speed,
                            },
                            btOnly: {
                                type: "boolean",
                                title: "Require Bluetooth audio",
                                description: "Only speak when a Bluetooth audio device is connected",
                                default: requireBluetooth,
                            },
                            setDefault: {
                                type: "boolean",
                                title: "Set as default",
                                description: "Remember these settings for future sessions",
                                default: false,
                            },
                        },
                        required: ["enabled"],
                    },
                });

                if (result.action !== "accept") return;

                speakEnabled = result.content?.enabled === "on";
                if (typeof result.content?.speed === "number") {
                    speed = Math.max(0.5, Math.min(2.0, result.content.speed));
                }
                if (typeof result.content?.btOnly === "boolean") {
                    requireBluetooth = result.content.btOnly;
                }

                if (result.content?.setDefault) {
                    defaultEnabled = speakEnabled;
                    await saveSettings();
                }

                if (speakEnabled) {
                    await session.log("🔊 Speak mode enabled", { level: "info" });
                    ensureModelDownloaded((msg) => {
                        session.log(msg, { level: "info" }).catch(() => {});
                    }).catch((err) => {
                        console.error("[speak] Model download failed:", err);
                    });
                } else {
                    await session.log("🔊 Speak mode disabled", { level: "info" });
                }
            },
        },
    ],
    tools: [
        {
            name: "speak",
            description:
                "Speaks text aloud on the user's device via text-to-speech. " +
                "Call this PROACTIVELY — do not wait for the user to ask. Use it whenever something noteworthy happens: " +
                "starting or finishing a major task, encountering errors or failures, answering a direct question, " +
                "greeting the user at session start, or celebrating a success. " +
                "Always provide a full text response too — speech is supplementary, not a replacement. " +
                "Keep spoken text to 1–2 short sentences. " +
                "Do NOT speak for routine low-level steps like reading files or running grep — " +
                "only speak for meaningful status changes, answers, or outcomes the user would want to hear even if not watching the screen. " +
                'Examples: "Starting the build now." / "Build failed — TypeScript errors in auth.ts." / ' +
                '"All 47 tests passed!" / "The answer is yes, caching is enabled by default." / ' +
                '"Done! Your pull request is ready for review."',
            parameters: {
                type: "object",
                properties: {
                    text: {
                        type: "string",
                        description: "The text to speak aloud. Keep concise — 1–2 sentences.",
                    },
                },
                required: ["text"],
            },
            skipPermission: true,
            handler: async (args) => {
                log(`tool speak called: enabled=${speakEnabled}, requireBT=${requireBluetooth}, text="${(args.text || "").slice(0, 80)}"`);
                if (!speakEnabled || !args.text || !args.text.trim()) {
                    return "";
                }
                if (requireBluetooth && !isBluetoothAudioConnected()) {
                    log("speak skipped: no BT audio connected");
                    return "";
                }
                try {
                    enqueueSpeech(args.text);
                    return "Queued for speaking.";
                } catch (err) {
                    return `Speech error: ${err.message}`;
                }
            },
        },
    ],
});

// Log startup state to timeline
if (speakEnabled) {
    if (requireBluetooth && !isBluetoothAudioConnected()) {
        session.log("🔊 Speak mode is on but no Bluetooth audio connected", { level: "info", ephemeral: true }).catch(() => {});
    } else {
        session.log("🔊 Speak mode is on", { level: "info", ephemeral: true }).catch(() => {});
    }
}

// Poll BT status and log changes to timeline
let lastBtStatus = null;
let btPollRunning = false;
function pollBluetooth() {
    if (!speakEnabled || !requireBluetooth || btPollRunning) return;
    btPollRunning = true;
    try {
        const connected = isBluetoothAudioConnected();
        if (lastBtStatus !== null && connected !== lastBtStatus) {
            if (connected) {
                session.log("🔊 Bluetooth audio connected — speak active", { level: "info", ephemeral: true }).catch(() => {});
            } else {
                session.log("🔊 Bluetooth audio disconnected — speak paused", { level: "info", ephemeral: true }).catch(() => {});
            }
        }
        lastBtStatus = connected;
    } finally {
        btPollRunning = false;
    }
}
// Check every 3 seconds
setInterval(pollBluetooth, 3_000);
pollBluetooth();
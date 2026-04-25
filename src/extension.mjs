/*---------------------------------------------------------------------------------------------
 *  Speak Extension for GitHub Copilot CLI
 *  Text-to-speech using Kokoro via sherpa-onnx (native C++ inference)
 *  TTS runs in a separate Node process to handle native addon architecture mismatches
 *--------------------------------------------------------------------------------------------*/

import { joinSession } from "@github/copilot-sdk/extension";
import { execFile } from "node:child_process";
import { mkdir, unlink, readFile, writeFile } from "node:fs/promises";
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

// ── Settings persistence ───────────────────────────────────────────

async function loadSettings() {
    try {
        const data = JSON.parse(await readFile(SETTINGS_PATH, "utf-8"));
        defaultEnabled = !!data.defaultEnabled;
        speakEnabled = defaultEnabled;
        if (typeof data.speed === "number" && data.speed >= 0.5 && data.speed <= 2.0) {
            speed = data.speed;
        }
    } catch {
        // No settings file yet
    }
}

async function saveSettings() {
    await mkdir(dirname(SETTINGS_PATH), { recursive: true });
    await writeFile(SETTINGS_PATH, JSON.stringify({ defaultEnabled, speed }), "utf-8");
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

// ── TTS via Worker Process ─────────────────────────────────────────

function spawnSpeech(text) {
    return new Promise((resolve, reject) => {
        const nodeCmd = osPlatform() === "win32" ? "node.exe" : "node";
        const env = { ...process.env };
        const child = execFile(
            nodeCmd,
            [WORKER_PATH, __dirname, text, String(speed)],
            { timeout: 60000, windowsHide: true, env },
            (err, stdout, stderr) => {
                if (err) reject(new Error(stderr || err.message));
                else resolve();
            },
        );
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
                    await session.log("🔇 Speak mode disabled", { level: "info" });
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
                log(`tool speak called: enabled=${speakEnabled}, text="${(args.text || "").slice(0, 80)}"`);
                if (!speakEnabled || !args.text || !args.text.trim()) {
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

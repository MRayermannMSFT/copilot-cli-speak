/*---------------------------------------------------------------------------------------------
 *  Speak Extension for GitHub Copilot CLI
 *  Text-to-speech using Kokoro via sherpa-onnx (native C++ inference)
 *  TTS runs in a separate Node process to handle native addon architecture mismatches
 *--------------------------------------------------------------------------------------------*/

import { joinSession } from "@github/copilot-sdk/extension";
import { execFile, spawn } from "node:child_process";
import { mkdir, unlink, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { platform as osPlatform } from "node:os";

const __dirname = process.env.EXTENSION_PATH
    ? dirname(process.env.EXTENSION_PATH)
    : dirname(fileURLToPath(import.meta.url));

const AUDIO_DIR = join(__dirname, ".cache", "audio");
const SETTINGS_PATH = join(__dirname, ".cache", "settings.json");
const MODEL_DIR = join(__dirname, ".cache", "kokoro-en-v0_19");
const WORKER_PATH = join(__dirname, "tts-worker.mjs");
const MAX_CHARS = 500;

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

function generateSpeech(text, wavPath) {
    return new Promise((resolve, reject) => {
        const nodeCmd = osPlatform() === "win32" ? "node.exe" : "node";
        execFile(
            nodeCmd,
            [WORKER_PATH, __dirname, text, String(speed), wavPath],
            { timeout: 30000, windowsHide: true },
            (err, stdout, stderr) => {
                if (err) reject(new Error(stderr || err.message));
                else resolve();
            },
        );
    });
}

// ── Audio Playback ─────────────────────────────────────────────────

function getPlayCommand(wavPath) {
    const os = osPlatform();
    if (os === "darwin") return ["afplay", [wavPath]];
    if (os === "win32") {
        return [
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-Command",
                `(New-Object Media.SoundPlayer '${wavPath.replace(/'/g, "''")}').PlaySync()`],
        ];
    }
    return ["aplay", ["-q", wavPath]];
}

function playWav(wavPath) {
    const [cmd, args] = getPlayCommand(wavPath);
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, args, { stdio: "ignore", windowsHide: true });
        proc.on("error", (err) => {
            if (osPlatform() === "linux" && cmd === "aplay") {
                playWithFallbacks(wavPath, [
                    ["paplay", [wavPath]],
                    ["ffplay", ["-nodisp", "-autoexit", wavPath]],
                ]).then(resolve, reject);
            } else {
                reject(err);
            }
        });
        proc.on("close", (code) =>
            code === 0 ? resolve() : reject(new Error(`Audio player exited ${code}`)),
        );
    });
}

function playWithFallbacks(wavPath, backends) {
    if (backends.length === 0) return Promise.reject(new Error("No audio player found."));
    const [[cmd, args], ...rest] = backends;
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, args, { stdio: "ignore", windowsHide: true });
        proc.on("error", () => playWithFallbacks(wavPath, rest).then(resolve, reject));
        proc.on("close", (code) =>
            code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)),
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
        await mkdir(AUDIO_DIR, { recursive: true });
        const wavPath = join(AUDIO_DIR, `speak-${Date.now()}.wav`);
        await generateSpeech(sanitized, wavPath);
        try {
            await playWav(wavPath);
        } finally {
            await unlink(wavPath).catch(() => {});
        }
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
                    // Pre-download model in background
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
                "Use for brief spoken updates, status messages, confirmations, and concise answers. " +
                "NOT a replacement for your text response — always respond in text too. " +
                "Only works when speak mode is enabled (/speak). Keep text to 1–2 sentences.",
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
                if (!speakEnabled) {
                    return "Speak mode is not active. The user can enable it with /speak.";
                }
                if (!args.text || !args.text.trim()) {
                    return "No text provided to speak.";
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

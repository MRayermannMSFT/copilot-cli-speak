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
const MAX_CHARS = 500;

// ── State ──────────────────────────────────────────────────────────

let speakEnabled = false;
let defaultEnabled = false;
let speed = 1.0;
let debugMode = false;

const BEHAVIORS = {
    status: {
        label: "Status updates",
        description: "Announce when starting/finishing major tasks",
        default: true,
        instruction: "Use the speak tool to briefly announce when you start or finish a major task, e.g. 'Starting the build' or 'All tests passed'.",
    },
    errors: {
        label: "Errors & warnings",
        description: "Announce errors and failures aloud",
        default: true,
        instruction: "Use the speak tool to announce errors, failures, or important warnings so the user hears them even if not watching the screen.",
    },
    greetings: {
        label: "Greetings & farewells",
        description: "Say hello and goodbye",
        default: false,
        instruction: "Use the speak tool to greet the user when they start a conversation and to say goodbye when the session ends.",
    },
    answers: {
        label: "Answers",
        description: "Speak concise answers to direct questions",
        default: false,
        instruction: "When the user asks a direct question, use the speak tool to speak a concise 1-sentence answer in addition to your full text response.",
    },
    celebrations: {
        label: "Celebrations",
        description: "Celebrate wins — tests passing, PRs merged",
        default: false,
        instruction: "Use the speak tool to celebrate wins — successful deployments, all tests passing, PRs merged, milestones reached.",
    },
};

let activeBehaviors = new Set(
    Object.entries(BEHAVIORS).filter(([, b]) => b.default).map(([k]) => k),
);

// ── Settings persistence ───────────────────────────────────────────

async function loadSettings() {
    try {
        const data = JSON.parse(await readFile(SETTINGS_PATH, "utf-8"));
        defaultEnabled = !!data.defaultEnabled;
        speakEnabled = defaultEnabled;
        if (typeof data.speed === "number" && data.speed >= 0.5 && data.speed <= 2.0) {
            speed = data.speed;
        }
        if (Array.isArray(data.behaviors)) {
            activeBehaviors = new Set(data.behaviors.filter((b) => BEHAVIORS[b]));
        }
    } catch {
        // No settings file yet
    }
}

async function saveSettings() {
    await mkdir(dirname(SETTINGS_PATH), { recursive: true });
    await writeFile(SETTINGS_PATH, JSON.stringify({
        defaultEnabled, speed, behaviors: [...activeBehaviors],
    }), "utf-8");
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
        const env = { ...process.env, SPEAK_DEBUG: debugMode ? "1" : "0" };
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
    hooks: {
        onUserPromptSubmitted: async () => {
            if (!speakEnabled || activeBehaviors.size === 0) return;

            const instructions = [...activeBehaviors]
                .map((key) => BEHAVIORS[key]?.instruction)
                .filter(Boolean);

            if (instructions.length === 0) return;

            return {
                additionalContext:
                    "The user has enabled text-to-speech. You have a `speak` tool available. " +
                    "Follow these speaking guidelines:\n" +
                    instructions.map((i) => `- ${i}`).join("\n") +
                    "\nKeep spoken text to 1–2 sentences. Always provide your full text response too — speech is supplementary.",
            };
        },
    },
    commands: [
        {
            name: "speak",
            description: "Configure speak mode settings",
            handler: async () => {
                const behaviorChoices = Object.entries(BEHAVIORS).map(
                    ([key, b]) => ({ const: key, title: `${b.label} — ${b.description}` }),
                );

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
                            behaviors: {
                                type: "array",
                                title: "What to speak",
                                description: "Choose what the agent should speak aloud",
                                items: {
                                    anyOf: behaviorChoices,
                                },
                                default: [...activeBehaviors],
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
                            debug: {
                                type: "boolean",
                                title: "Enable debug logging",
                                description: "Write verbose logs to .cache/debug.log",
                                default: debugMode,
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
                if (Array.isArray(result.content?.behaviors)) {
                    activeBehaviors = new Set(result.content.behaviors.filter((b) => BEHAVIORS[b]));
                }

                if (result.content?.setDefault) {
                    defaultEnabled = speakEnabled;
                    await saveSettings();
                }

                debugMode = !!result.content?.debug;

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

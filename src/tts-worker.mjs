// TTS worker — generates speech and streams PCM to ffplay
// ffplay is auto-downloaded on first use to .cache/ffplay/
// Set SPEAK_DEBUG=1 for verbose logging to .cache/debug.log
import { createRequire } from "node:module";
import { spawn, execSync } from "node:child_process";
import { join } from "node:path";
import { existsSync, mkdirSync, unlinkSync, statSync, appendFileSync } from "node:fs";
import { platform as osPlatform } from "node:os";

const extDir = process.argv[2];
const text = process.argv[3];
const speed = parseFloat(process.argv[4] || "1.0");
const debug = process.env.SPEAK_DEBUG === "1";

const LOG_PATH = join(extDir, ".cache", "debug.log");

function log(msg) {
    if (!debug) return;
    const line = `${new Date().toISOString()} ${msg}\n`;
    try { appendFileSync(LOG_PATH, line); } catch {}
}

log(`--- worker start: text="${text.slice(0, 80)}", speed=${speed}`);

// ── Load sherpa-onnx ───────────────────────────────────────────────

const nativeDir = join(extDir, "native");
const require = createRequire(join(nativeDir, "sherpa-onnx-node", "package.json"));

log("loading sherpa-onnx...");
const sherpa_onnx = require("./sherpa-onnx.js");
log("sherpa-onnx loaded");

const MODEL_DIR = join(extDir, ".cache", "kokoro-en-v0_19");
const FFPLAY_DIR = join(extDir, ".cache", "ffplay");
const SAMPLE_RATE = 24000;

// ── ffplay download ────────────────────────────────────────────────

const FFPLAY_URLS = {
    "win32": "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
    "darwin": "https://ffmpeg.martin-riedl.de/releases/macos/arm64/snapshot/ffplay.zip",
};

function getFfplayPath() {
    const ext = osPlatform() === "win32" ? ".exe" : "";
    return join(FFPLAY_DIR, `ffplay${ext}`);
}

function ensureFfplay() {
    const ffplayPath = getFfplayPath();
    if (existsSync(ffplayPath)) {
        log(`ffplay exists at ${ffplayPath}`);
        return ffplayPath;
    }

    mkdirSync(FFPLAY_DIR, { recursive: true });
    const url = FFPLAY_URLS[osPlatform()];
    if (!url) throw new Error(`No ffplay download URL for platform: ${osPlatform()}`);

    log(`downloading ffplay from ${url}`);
    const zipPath = join(FFPLAY_DIR, "ffplay-download.zip");
    execSync(`curl -fSL -o "${zipPath}" "${url}"`, { stdio: "pipe", windowsHide: true });
    log(`downloaded ${(statSync(zipPath).size / 1024 / 1024).toFixed(0)} MB`);

    if (osPlatform() === "win32") {
        execSync(`tar -xf "${zipPath}" --strip-components=2 -C "${FFPLAY_DIR}" "*/bin/ffplay.exe"`, {
            stdio: "pipe", windowsHide: true,
        });
    } else {
        execSync(`unzip -o "${zipPath}" -d "${FFPLAY_DIR}"`, { stdio: "pipe" });
        execSync(`chmod +x "${ffplayPath}"`, { stdio: "pipe" });
    }

    unlinkSync(zipPath);
    log(`ffplay extracted: ${(statSync(ffplayPath).size / 1024 / 1024).toFixed(0)} MB`);
    return ffplayPath;
}

// ── Float32 → 16-bit PCM ──────────────────────────────────────────

function float32ToPcm16(samples) {
    const buf = Buffer.alloc(samples.length * 2);
    for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        buf.writeInt16LE(Math.round(s * 32767), i * 2);
    }
    return buf;
}

// ── Main ───────────────────────────────────────────────────────────

log("creating TTS instance...");
const tts = new sherpa_onnx.OfflineTts({
    model: {
        kokoro: {
            model: join(MODEL_DIR, "model.onnx"),
            tokens: join(MODEL_DIR, "tokens.txt"),
            voices: join(MODEL_DIR, "voices.bin"),
            dataDir: join(MODEL_DIR, "espeak-ng-data"),
        },
        debug: false,
        numThreads: 2,
        provider: "cpu",
    },
    maxNumSentences: 1,
});
log("TTS instance created");

const config = new sherpa_onnx.GenerationConfig({ sid: 0, speed });

// Ensure ffplay
const ffplayPath = ensureFfplay();
log(`spawning ffplay: ${ffplayPath}`);

const player = spawn(ffplayPath, [
    "-f", "s16le", "-ar", String(SAMPLE_RATE), "-ac", "1",
    "-nodisp", "-autoexit", "-loglevel", "quiet",
    "-i", "pipe:0",
], { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });

let playerError = null;
player.on("error", (err) => {
    playerError = err;
    log(`ffplay spawn error: ${err.message}`);
});

player.stderr?.on("data", (data) => {
    log(`ffplay stderr: ${data.toString().trimEnd()}`);
});

log("generating speech...");
let totalChunks = 0;
let totalSamples = 0;

const audio = await tts.generateAsync({
    text,
    generationConfig: config,
    onProgress: (info) => {
        totalChunks++;
        totalSamples += info.samples.length;
        log(`onProgress chunk ${totalChunks}: ${info.samples.length} samples, progress=${info.progress}`);

        if (playerError) {
            log(`skipping write — player errored`);
            return 0; // stop generation
        }

        if (player.stdin.writable) {
            const pcm = float32ToPcm16(info.samples);
            const ok = player.stdin.write(pcm);
            log(`wrote ${pcm.length} bytes to ffplay stdin (backpressure=${!ok})`);
        } else {
            log(`ffplay stdin not writable`);
        }
        return 1;
    },
});

log(`generation done: ${totalChunks} chunks, ${totalSamples} total samples`);

if (playerError) {
    log(`aborting — ffplay error: ${playerError.message}`);
    console.error(`ffplay error: ${playerError.message}`);
    process.exit(1);
}

player.stdin.end();
log("stdin closed, waiting for ffplay to finish...");

const exitCode = await new Promise((resolve) => {
    player.on("close", (code) => {
        log(`ffplay exited with code ${code}`);
        resolve(code);
    });
    setTimeout(() => {
        log("ffplay timeout after 60s");
        resolve(-1);
    }, 60000);
});

log(`worker done, exit code ${exitCode}`);
process.exit(exitCode === 0 ? 0 : 1);

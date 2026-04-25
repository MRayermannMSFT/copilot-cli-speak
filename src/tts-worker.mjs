// Persistent TTS worker — stays alive, receives commands via stdin JSON lines
// Generates speech via sherpa-onnx and streams PCM to ffplay
import { createRequire } from "node:module";
import { spawn, execSync } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { existsSync, mkdirSync, unlinkSync, statSync, appendFileSync } from "node:fs";
import { platform as osPlatform } from "node:os";

const extDir = process.argv[2];

const LOG_PATH = join(extDir, ".cache", "debug.log");
function log(msg) {
    try {
        mkdirSync(join(extDir, ".cache"), { recursive: true });
        appendFileSync(LOG_PATH, `${new Date().toISOString()} [worker] ${msg}\n`);
    } catch {}
}

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
    if (existsSync(ffplayPath)) return ffplayPath;

    mkdirSync(FFPLAY_DIR, { recursive: true });
    const url = FFPLAY_URLS[osPlatform()];
    if (!url) throw new Error(`No ffplay download URL for platform: ${osPlatform()}`);

    log(`downloading ffplay from ${url}`);
    const zipPath = join(FFPLAY_DIR, "ffplay-download.zip");
    execSync(`curl -fSL -o "${zipPath}" "${url}"`, { stdio: "pipe", windowsHide: true });

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

// ── Init TTS + ffplay ──────────────────────────────────────────────

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
log("TTS instance created — worker ready");

const ffplayPath = ensureFfplay();
log(`ffplay at: ${ffplayPath}`);

// Signal ready to parent
process.send?.({ type: "ready" });

// ── Handle requests via stdin JSON lines ───────────────────────────

const rl = createInterface({ input: process.stdin });

rl.on("line", async (line) => {
    let req;
    try {
        req = JSON.parse(line);
    } catch {
        return;
    }

    if (req.type === "speak") {
        const { text, speed = 1.0, id } = req;
        log(`speak request: id=${id}, text="${text.slice(0, 80)}"`);

        try {
            const config = new sherpa_onnx.GenerationConfig({ sid: 0, speed });

            const player = spawn(ffplayPath, [
                "-f", "s16le", "-ar", String(SAMPLE_RATE), "-ch_layout", "mono",
                "-nodisp", "-autoexit", "-loglevel", "quiet",
                "-i", "pipe:0",
            ], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });

            let playerError = null;
            player.on("error", (err) => { playerError = err; });

            const t0 = Date.now();
            const audio = await tts.generateAsync({
                text,
                generationConfig: config,
                onProgress: (info) => {
                    if (!playerError && player.stdin.writable) {
                        try { player.stdin.write(float32ToPcm16(info.samples)); } catch {}
                    }
                    return 1;
                },
            });
            log(`generated in ${Date.now() - t0}ms, ${audio.samples.length} samples`);

            player.stdin.end();

            await new Promise((resolve) => {
                player.on("close", resolve);
                setTimeout(resolve, 60000);
            });

            log(`playback done for id=${id}`);
            process.send?.({ type: "done", id });
        } catch (err) {
            log(`error: ${err.message}`);
            process.send?.({ type: "error", id, error: err.message });
        }
    }
});

rl.on("close", () => {
    log("stdin closed, exiting");
    process.exit(0);
});

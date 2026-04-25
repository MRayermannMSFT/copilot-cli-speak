// TTS worker — generates speech and streams PCM to ffplay for low-latency playback
// ffplay is auto-downloaded on first use to .cache/ffplay/
import { createRequire } from "node:module";
import { spawn, execSync } from "node:child_process";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { platform as osPlatform, arch as osArch } from "node:os";

const extDir = process.argv[2];
const text = process.argv[3];
const speed = parseFloat(process.argv[4] || "1.0");

const nativeDir = join(extDir, "native");
const require = createRequire(join(nativeDir, "sherpa-onnx-node", "package.json"));
const sherpa_onnx = require("./sherpa-onnx.js");

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
    if (!url) throw new Error(`No ffplay download for ${osPlatform()}`);

    console.error("[speak] Downloading ffplay (one-time)...");
    const zipPath = join(FFPLAY_DIR, "ffplay-download.zip");

    // Use curl for reliable download (available on all modern Windows/macOS)
    execSync(`curl -fSL -o "${zipPath}" "${url}"`, { stdio: "pipe", windowsHide: true });

    if (osPlatform() === "win32") {
        // Extract just ffplay.exe from the zip
        execSync(`tar -xf "${zipPath}" --strip-components=2 -C "${FFPLAY_DIR}" "*/bin/ffplay.exe"`, {
            stdio: "pipe", windowsHide: true,
        });
    } else {
        execSync(`unzip -o "${zipPath}" -d "${FFPLAY_DIR}"`, { stdio: "pipe" });
        execSync(`chmod +x "${ffplayPath}"`, { stdio: "pipe" });
    }

    unlinkSync(zipPath);
    console.error(`[speak] ffplay ready (${(statSync(ffplayPath).size / 1024 / 1024).toFixed(0)} MB)`);
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

// ── WAV fallback playback ──────────────────────────────────────────

function fallbackWavPlayback(samples, sampleRate) {
    const audioDir = join(extDir, ".cache", "audio");
    mkdirSync(audioDir, { recursive: true });
    const wavPath = join(audioDir, `speak-${Date.now()}.wav`);
    sherpa_onnx.writeWave(wavPath, { samples, sampleRate });

    const os = osPlatform();
    let cmd, args;
    if (os === "darwin") { cmd = "afplay"; args = [wavPath]; }
    else if (os === "win32") {
        cmd = "powershell.exe";
        args = ["-NoProfile", "-NonInteractive", "-Command",
            `(New-Object Media.SoundPlayer '${wavPath.replace(/'/g, "''")}').PlaySync()`];
    } else { cmd = "aplay"; args = ["-q", wavPath]; }

    return new Promise((resolve) => {
        const proc = spawn(cmd, args, { stdio: "ignore", windowsHide: true });
        proc.on("close", () => {
            try { unlinkSync(wavPath); } catch {}
            resolve();
        });
        proc.on("error", () => resolve());
    });
}

// ── Main ───────────────────────────────────────────────────────────

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

const config = new sherpa_onnx.GenerationConfig({ sid: 0, speed });

// Try streaming via ffplay, fall back to WAV if ffplay unavailable
let ffplayPath;
try {
    ffplayPath = ensureFfplay();
} catch (e) {
    console.error("[speak] ffplay unavailable, using WAV fallback:", e.message);
}

if (ffplayPath) {
    // Streaming mode: pipe PCM chunks to ffplay's stdin
    const player = spawn(ffplayPath, [
        "-f", "s16le", "-ar", String(SAMPLE_RATE), "-ac", "1",
        "-nodisp", "-autoexit", "-loglevel", "quiet",
        "-i", "pipe:0",
    ], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });

    const audio = await tts.generateAsync({
        text,
        generationConfig: config,
        onProgress: (info) => {
            if (player.stdin.writable) {
                player.stdin.write(float32ToPcm16(info.samples));
            }
            return 1;
        },
    });

    player.stdin.end();
    await new Promise((resolve) => {
        player.on("close", resolve);
        setTimeout(resolve, 60000);
    });
} else {
    // WAV fallback
    const audio = tts.generate({ text, generationConfig: config });
    await fallbackWavPlayback(audio.samples, audio.sampleRate);
}

process.exit(0);

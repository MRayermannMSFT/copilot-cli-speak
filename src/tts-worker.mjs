// TTS worker — generates speech and streams PCM to pcm-player for low-latency playback
import { createRequire } from "node:module";
import { fork } from "node:child_process";
import { join } from "node:path";

const extDir = process.argv[2];
const text = process.argv[3];
const speed = parseFloat(process.argv[4] || "1.0");

const nativeDir = join(extDir, "native");
const require = createRequire(join(nativeDir, "sherpa-onnx-node", "package.json"));
const sherpa_onnx = require("./sherpa-onnx.js");

const MODEL_DIR = join(extDir, ".cache", "kokoro-en-v0_19");
const PLAYER_PATH = join(extDir, "pcm-player.mjs");
const SAMPLE_RATE = 24000;

// ── Float32 → 16-bit PCM ──────────────────────────────────────────

function float32ToPcm16(samples) {
    const buf = Buffer.alloc(samples.length * 2);
    for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        buf.writeInt16LE(Math.round(s * 32767), i * 2);
    }
    return buf;
}

// ── Init TTS ───────────────────────────────────────────────────────

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

// ── Start player process ───────────────────────────────────────────

// Use system node (not the SEA binary) to run the player
const nodeCmd = process.argv[0]; // We're already running under system node
const player = fork(PLAYER_PATH, [String(SAMPLE_RATE)], {
    stdio: ["pipe", "ignore", "ignore", "ipc"],
    windowsHide: true,
});

// ── Generate and stream ────────────────────────────────────────────

const config = new sherpa_onnx.GenerationConfig({ sid: 0, speed });

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

// For short text where onProgress fires once with all samples,
// the data was already written in onProgress. Just close stdin.
player.stdin.end();

// Wait for playback to finish
await new Promise((resolve) => {
    player.on("close", resolve);
    setTimeout(resolve, 60000);
});

process.exit(0);

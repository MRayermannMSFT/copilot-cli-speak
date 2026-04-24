// TTS worker — runs in a separate Node.js process for native addon compatibility
// Loads sherpa-onnx from the extension's native/ directory (no node_modules needed)
import { createRequire } from "node:module";
import { join } from "node:path";

const extDir = process.argv[2];
const text = process.argv[3];
const speed = parseFloat(process.argv[4] || "1.0");
const outputPath = process.argv[5];

// Load sherpa-onnx from the extension's bundled native/ directory
const nativeDir = join(extDir, "native");
const require = createRequire(join(nativeDir, "sherpa-onnx-node", "package.json"));
const sherpa_onnx = require("./sherpa-onnx.js");

const MODEL_DIR = join(extDir, ".cache", "kokoro-en-v0_19");

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
const audio = tts.generate({ text, generationConfig: config });
sherpa_onnx.writeWave(outputPath, { samples: audio.samples, sampleRate: audio.sampleRate });
console.log("OK");

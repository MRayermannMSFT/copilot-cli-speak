# Copilot CLI Speak Extension

Text-to-speech extension for GitHub Copilot CLI using [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) via [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx).

## Features

- **`/speak`** — Settings dialog to enable/disable speak mode, adjust speed
- **`speak` tool** — Agent calls this to speak text aloud (non-blocking, queued)
- **Kokoro TTS** — Natural-sounding 82M parameter model, runs locally on CPU
- **Cross-platform** — Windows (x64), macOS (x64/ARM64)

## Installation from release

1. Download the zip for your platform from [Releases](../../releases)
2. Extract to `~/.copilot/extensions/speak/`
3. Restart Copilot CLI
4. Run `/speak` to enable

The TTS model (~305MB) downloads automatically on first use.

> **Windows ARM64**: Use the `win-x64` build — it runs via x86 emulation.

## Development

```bash
npm install
npm run build
```

Build output goes to `dist/`. Copy `dist/` contents to `~/.copilot/extensions/speak/` to test.

## Architecture

```
extension.mjs       ← Bundled entry point (loaded by CLI)
tts-worker.mjs      ← Runs TTS in a separate Node process
native/             ← Platform-specific sherpa-onnx binaries
.cache/             ← Auto-downloaded model + audio temp files (gitignored)
```

The CLI forks the extension as a child process. Since the CLI may be a native ARM64 binary,
TTS inference runs in a separate `node.exe` process to ensure the x64 native addon loads correctly.

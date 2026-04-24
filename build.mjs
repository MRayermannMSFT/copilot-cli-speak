import esbuild from "esbuild";
import { cpSync, mkdirSync, existsSync, readdirSync, copyFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { platform, arch } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "dist");

// Determine target platform (can be overridden via env for CI cross-builds)
const targetPlatform = process.env.TARGET_PLATFORM || (platform() === "win32" ? "win" : platform());
const targetArch = process.env.TARGET_ARCH || arch();
const platformArch = `${targetPlatform}-${targetArch}`;

console.log(`Building for ${platformArch}...`);

// Clean and create dist
mkdirSync(join(distDir, "native", "sherpa-onnx-node"), { recursive: true });

// 1. Bundle extension.mjs
await esbuild.build({
    entryPoints: ["src/extension.mjs"],
    bundle: true,
    outfile: join(distDir, "extension.mjs"),
    format: "esm",
    platform: "node",
    target: "node20",
    external: ["@github/copilot-sdk", "@github/copilot-sdk/*"],
    minify: false,
    logLevel: "info",
});

// 2. Copy tts-worker.mjs (no bundling needed — it's standalone)
copyFileSync(join(__dirname, "src", "tts-worker.mjs"), join(distDir, "tts-worker.mjs"));
console.log("Copied tts-worker.mjs");

// 3. Copy sherpa-onnx-node JS files (the pure-JS parts)
const sherpaNodeDir = join(__dirname, "node_modules", "sherpa-onnx-node");
if (existsSync(sherpaNodeDir)) {
    const jsFiles = readdirSync(sherpaNodeDir).filter(f => f.endsWith(".js") || f === "package.json");
    for (const f of jsFiles) {
        copyFileSync(join(sherpaNodeDir, f), join(distDir, "native", "sherpa-onnx-node", f));
    }
    console.log(`Copied ${jsFiles.length} sherpa-onnx-node JS files`);
}

// 4. Copy platform-specific native files
const nativePkgName = `sherpa-onnx-${platformArch}`;
const nativePkgDir = join(__dirname, "node_modules", nativePkgName);
const nativeDstDir = join(distDir, "native", nativePkgName);

if (existsSync(nativePkgDir)) {
    mkdirSync(nativeDstDir, { recursive: true });
    const nativeFiles = readdirSync(nativePkgDir).filter(f =>
        f.endsWith(".node") || f.endsWith(".dll") || f.endsWith(".dylib") || f.endsWith(".so") ||
        f === "package.json" || f === "index.js"
    );
    for (const f of nativeFiles) {
        copyFileSync(join(nativePkgDir, f), join(nativeDstDir, f));
    }
    console.log(`Copied ${nativeFiles.length} native files from ${nativePkgName}`);
} else {
    console.warn(`WARNING: Native package ${nativePkgName} not found at ${nativePkgDir}`);
    console.warn(`Available packages:`);
    readdirSync(join(__dirname, "node_modules"))
        .filter(d => d.startsWith("sherpa-onnx-"))
        .forEach(d => console.warn(`  ${d}`));
}

console.log(`\nBuild complete → ${distDir}`);
console.log("Release zip should contain the contents of dist/");

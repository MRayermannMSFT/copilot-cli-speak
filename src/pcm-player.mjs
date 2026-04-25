// Minimal PCM audio player — reads raw 16-bit mono PCM from stdin, plays via waveOut API
// Usage: node pcm-player.mjs <sampleRate>
// Pipe raw PCM bytes to stdin

import { platform } from "node:os";
import { execSync, spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sampleRate = parseInt(process.argv[2] || "24000");
const os = platform();

if (os === "darwin") {
    // macOS: pipe through sox/play if available, otherwise buffer and afplay
    const player = spawn("play", [
        "-t", "raw", "-b", "16", "-e", "signed-integer", "-L",
        "-c", "1", "-r", String(sampleRate), "-",
    ], { stdio: ["pipe", "ignore", "ignore"] });

    player.on("error", () => {
        // sox not available — collect all stdin, write WAV, play with afplay
        bufferAndPlay();
    });

    process.stdin.pipe(player.stdin);
    player.on("close", () => process.exit(0));

} else if (os === "win32") {
    // Windows: use inline C# with waveOut API for true streaming
    const csCode = `
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

class P {
    [DllImport("winmm.dll")] static extern int waveOutOpen(out IntPtr h, int id, ref W f, IntPtr cb, IntPtr inst, int flags);
    [DllImport("winmm.dll")] static extern int waveOutPrepareHeader(IntPtr h, ref H hdr, int sz);
    [DllImport("winmm.dll")] static extern int waveOutWrite(IntPtr h, ref H hdr, int sz);
    [DllImport("winmm.dll")] static extern int waveOutUnprepareHeader(IntPtr h, ref H hdr, int sz);
    [DllImport("winmm.dll")] static extern int waveOutClose(IntPtr h);
    [StructLayout(LayoutKind.Sequential)] struct W { public ushort tag,ch; public uint sr,br; public ushort ba,bps,ex; }
    [StructLayout(LayoutKind.Sequential)] struct H { public IntPtr d; public uint l,r; public IntPtr u; public uint f,lo; public IntPtr n,rv; }

    static void Main(string[] args) {
        int sr = args.Length > 0 ? int.Parse(args[0]) : 24000;
        var fmt = new W { tag=1, ch=1, sr=(uint)sr, bps=16, ba=2, br=(uint)(sr*2) };
        IntPtr h; waveOutOpen(out h, -1, ref fmt, IntPtr.Zero, IntPtr.Zero, 0);
        var sin = Console.OpenStandardInput();
        var buf = new byte[sr/5*2]; // 200ms chunks
        int n;
        while ((n = sin.Read(buf, 0, buf.Length)) > 0) {
            var p = Marshal.AllocHGlobal(n);
            Marshal.Copy(buf, 0, p, n);
            var hdr = new H { d=p, l=(uint)n };
            int sz = Marshal.SizeOf(hdr);
            waveOutPrepareHeader(h, ref hdr, sz);
            waveOutWrite(h, ref hdr, sz);
            Thread.Sleep((int)(n/(sr*2.0)*900));
            waveOutUnprepareHeader(h, ref hdr, sz);
            Marshal.FreeHGlobal(p);
        }
        Thread.Sleep(300);
        waveOutClose(h);
    }
}`;

    // Compile the C# player on first use
    const cacheDir = join(__dirname, ".cache");
    mkdirSync(cacheDir, { recursive: true });
    const exePath = join(cacheDir, "pcm-player.exe");
    const csPath = join(cacheDir, "pcm-player.cs");

    if (!existsSync(exePath)) {
        writeFileSync(csPath, csCode);
        try {
            // Use .NET Framework csc (always available on Windows)
            const cscPaths = [
                "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
                "C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe",
            ];
            const csc = cscPaths.find(p => existsSync(p)) || "csc.exe";
            execSync(`"${csc}" /nologo /optimize /out:"${exePath}" "${csPath}"`, {
                stdio: "pipe",
                windowsHide: true,
            });
        } catch (e) {
            console.error("Failed to compile PCM player:", e.message);
            process.exit(1);
        }
    }

    const player = spawn(exePath, [String(sampleRate)], {
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
    });
    process.stdin.pipe(player.stdin);
    player.on("close", () => process.exit(0));

} else {
    // Linux: aplay reads from stdin natively
    const player = spawn("aplay", [
        "-f", "S16_LE", "-r", String(sampleRate), "-c", "1", "-q",
    ], { stdio: ["pipe", "ignore", "ignore"] });
    process.stdin.pipe(player.stdin);
    player.on("close", () => process.exit(0));
}

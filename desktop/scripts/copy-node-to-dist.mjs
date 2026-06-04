// Copy the bundled Node 22.13.0 binary from src-tauri/binaries/node.exe
// into the repo-root dist/ folder so Tauri's resources can ship it as
// part of the dist bundle. We do this instead of relying on Tauri 2's
// default `binaries/` sidecar handling, which collides with itself in
// WiX when the same file is referenced twice (#node-dup-bug).
//
// Run before `bunx tauri build`:
import { copyFileSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const src = join(repoRoot, "desktop", "src-tauri", "binaries", "node.exe");
const dst = join(repoRoot, "dist", "node.exe");

if (!existsSync(src)) {
  console.error(`[copy-node] bundled node.exe not found at ${src}`);
  console.error(`[copy-node] Run 'npm run bundle:node' first to download it.`);
  process.exit(1);
}

const md = statSync(src);
if (md.size < 1_000_000) {
  console.error(
    `[copy-node] bundled node.exe is suspiciously small (${md.size} bytes) — refusing to copy`,
  );
  process.exit(1);
}

copyFileSync(src, dst);
console.log(`[copy-node] copied ${src} -> ${dst} (${(md.size / 1024 / 1024).toFixed(1)} MB)`);

// Force build desktop/src to dist - run from project root
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const result = spawnSync("npx", ["--prefix", "desktop", "vite", "build"], {
  cwd: process.cwd(),
  shell: true,
  stdio: "inherit",
});

console.log("Exit code:", result.status);

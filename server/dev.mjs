import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

const apiProc = spawn(process.execPath, [path.join(__dirname, "index.mjs")], {
  cwd: ROOT_DIR,
  stdio: "inherit",
  env: { ...process.env, API_PORT: "3001" },
});

const viteBin = path.join(ROOT_DIR, "node_modules", "vite", "bin", "vite.js");
const viteProc = spawn(process.execPath, [viteBin], {
  cwd: ROOT_DIR,
  stdio: "inherit",
  env: { ...process.env },
});

function shutdown(code = 0) {
  try { apiProc.kill(); } catch {}
  try { viteProc.kill(); } catch {}
  process.exit(code);
}

apiProc.on("exit", (code) => {
  if (code && code !== 0) shutdown(code);
});
viteProc.on("exit", (code) => shutdown(code ?? 0));
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));


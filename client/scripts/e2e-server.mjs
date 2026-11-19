// Starts the server on a fresh data directory for the end-to-end tests.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = join(dirname(new URL(import.meta.url).pathname), "..");
const port = process.argv[2] ?? "5299";
const dataDir = mkdtempSync(join(tmpdir(), "memos-lite-e2e-"));
const bin = process.env.MEMOS_LITE_BIN ?? join(root, "../server/target/debug/memos-lite");
const child = spawn(bin, [], {
  stdio: "inherit",
  env: { ...process.env, PORT: port, DATA_DIR: dataDir, CLIENT_DIR: join(root, "dist"), API_TOKEN: "e2e-token", TZ: "UTC" },
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 0));

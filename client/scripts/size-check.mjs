// Fails when the first page or the always-loaded assets outgrow their budgets.
// Usage: node scripts/size-check.mjs [base-url]   (the server must be running with memos in it)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const root = join(new URL(".", import.meta.url).pathname, "..");
const base = process.argv[2] ?? "http://localhost:5240";
const manifest = JSON.parse(readFileSync(join(root, "dist/manifest.json"), "utf8"));
const gz = (file) => readFileSync(join(root, "dist", `${file}.gz`)).length;
const KB = 1024;

const html = Buffer.from(await (await fetch(`${base}/`)).arrayBuffer());
const checks = [
  ["first page HTML (gzip -1)", gzipSync(html, { level: 1 }).length, 30 * KB],
  ["CSS", gz(manifest.css), 25 * KB],
  ["boot script and its chunks", [manifest.boot, ...manifest.preload].map(gz).reduce((a, b) => a + b, 0), 10 * KB],
];
let failed = false;
for (const [name, size, budget] of checks) {
  const ok = size <= budget;
  failed ||= !ok;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${(size / KB).toFixed(1)} KB (budget ${budget / KB} KB)`);
}
if (/<script(?![^>]*type="(module|application\/json)")[^>]*src=/.test(html.toString())) {
  failed = true;
  console.log("FAIL a classic script with src blocks rendering");
}
process.exit(failed ? 1 : 0);

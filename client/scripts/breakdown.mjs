// Main-thread work before first contentful paint, with the CPU slowed down.
// Usage: node scripts/breakdown.mjs URL [cpu-slowdown]
import { chromium } from "@playwright/test";

const [url = "http://localhost:5240/", rate = "6"] = process.argv.slice(2);
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome" });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const page = await context.newPage();
await page.goto(url, { waitUntil: "load" });
const cdp = await context.newCDPSession(page);
await cdp.send("Emulation.setCPUThrottlingRate", { rate: Number(rate) });
const events = [];
cdp.on("Tracing.dataCollected", (e) => events.push(...e.value));
const done = new Promise((r) => cdp.once("Tracing.tracingComplete", r));
await cdp.send("Tracing.start", { categories: "devtools.timeline,blink.user_timing,loading", transferMode: "ReportEvents" });
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(1000);
await cdp.send("Tracing.end");
await done;
await browser.close();
const nav = events.find((e) => e.name === "navigationStart" || e.name === "NavigationStart" || (e.name === "ResourceSendRequest" && e.args?.data?.url === url));
const t0 = nav.ts;
const fcp = events.find((e) => e.name === "firstContentfulPaint");
const end = fcp ? fcp.ts : t0 + 1e6;
const totals = {};
for (const e of events) {
  if (e.ph !== "X" || e.ts < t0 || e.ts > end || !e.dur) continue;
  if (!["ParseHTML", "ParseAuthorStyleSheet", "UpdateLayoutTree", "Layout", "Paint", "EvaluateScript", "v8.compile", "FunctionCall", "PrePaint", "Layerize", "Commit", "RunTask"].includes(e.name)) continue;
  totals[e.name] = (totals[e.name] ?? 0) + e.dur / 1000;
}
if (process.env.DETAIL) for (const e of events) if (e.name === "Layout" && e.ts >= t0 && e.ts <= end) console.log("layout", ((e.ts - t0) / 1000).toFixed(0), (e.dur / 1000).toFixed(1), JSON.stringify(e.args?.beginData ?? {}));
console.log(`FCP at ${fcp ? ((fcp.ts - t0) / 1000).toFixed(0) : "?"} ms (${rate}x CPU)`);
for (const [k, v] of Object.entries(totals).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v.toFixed(1)} ms`);

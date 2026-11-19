// Loads a page in Chrome with the CPU slowed down, as on an old phone, and
// prints when content became visible. Usage: node scripts/trace.mjs URL [cpu-slowdown] [runs]
import { chromium } from "@playwright/test";

const [url = "http://localhost:5230/", rate = "6", runs = "3"] = process.argv.slice(2);
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome" });
const results = [];
for (let i = 0; i <= Number(runs); i++) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: Number(rate) });
  if (i > 0) await page.goto(url, { waitUntil: "load" });
  const start = Date.now();
  await page.goto(url, { waitUntil: "load" });
  const load = Date.now() - start;
  await page.waitForTimeout(1500);
  const m = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const out = {};
        for (const e of performance.getEntriesByType("paint")) out[e.name] = Math.round(e.startTime);
        new PerformanceObserver((list) => {
          const entries = list.getEntries();
          out.lcp = Math.round(entries[entries.length - 1].startTime);
          resolve(out);
        }).observe({ type: "largest-contentful-paint", buffered: true });
        setTimeout(() => resolve(out), 500);
      }),
  );
  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType("navigation")[0];
    return { ttfb: Math.round(n.responseStart), dcl: Math.round(n.domContentLoadedEventEnd), bytes: n.transferSize };
  });
  if (i > 0) results.push({ ...nav, ...m, load });
  await context.close();
}
await browser.close();
console.table(results);
const med = (k) => results.map((r) => r[k]).sort((a, b) => a - b)[Math.floor(results.length / 2)];
console.log(`median (warm cache, ${rate}x CPU): ttfb ${med("ttfb")}ms, first-contentful-paint ${med("first-contentful-paint")}ms, lcp ${med("lcp")}ms, dcl ${med("dcl")}ms`);

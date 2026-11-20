import { expect, test } from "@playwright/test";
import { deflateSync } from "node:zlib";

const auth = { headers: { authorization: "Bearer e2e-token" } };

function png(): Buffer {
  const crc = (buf: Buffer) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0);
  ihdr.writeUInt32BE(4, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((4 * 3 + 1) * 4, 0x80);
  for (let y = 0; y < 4; y++) raw[y * 13] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

test("edits a memo in place", async ({ page, request }) => {
  const { uid } = await (await request.post("/api/memos", { ...auth, data: { content: "before edit" } })).json();
  await page.goto("/");
  const card = page.locator(`article#m-${uid}`);
  await card.hover();
  await card.locator("[data-popup=memo-menu]").click();
  await page.locator("[role=menu] [data-action=edit]").click();
  const editor = card.locator(".memo-editor-root[contenteditable=true]");
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" and after");
  await card.locator("[data-action=save]").click();
  await expect(page.locator(`article#m-${uid} .memo-content-root`)).toHaveText("before edit and after");
  const memo = await (await request.get(`/api/memos/${uid}`, auth)).json();
  expect(memo.content).toBe("before edit and after");
});

test("attaches an image from the composer", async ({ page }) => {
  await page.goto("/");
  await page.locator("[data-composer=create] .memo-editor-root").click();
  await page.keyboard.type("with a picture");
  await page.locator("[data-composer=create] [data-popup=insert-menu]").click();
  const chooser = page.waitForEvent("filechooser");
  await page.locator("[data-insert=attachment]").click();
  await (await chooser).setFiles({ name: "dot.png", mimeType: "image/png", buffer: png() });
  await expect(page.locator("[data-composer=create] [data-composer-extras] img")).toHaveCount(1);
  await page.locator("[data-composer=create] [data-action=save]").click();
  const card = page.locator("#memo-list article").first();
  await expect(card.locator("[data-action=preview] img")).toHaveCount(1);
  const src = await card.locator("[data-action=preview]").getAttribute("data-src");
  const file = await page.request.get(src!);
  expect(file.headers()["content-type"]).toBe("image/png");
  const range = await page.request.get(src!, { headers: { range: "bytes=0-3" } });
  expect(range.status()).toBe(206);
});

test("comments and reacts", async ({ page, request }) => {
  const { uid } = await (await request.post("/api/memos", { ...auth, data: { content: "talk about this" } })).json();
  await page.goto(`/memos/${uid}`);
  await page.locator("main [data-action=write-comment]").click();
  await page.locator("[data-composer=comment] .memo-editor-root").click();
  await page.keyboard.type("a reply");
  await page.locator("[data-composer=comment] [data-action=save]").click();
  await expect(page.locator("[data-comments] .memo-content-root")).toHaveText("a reply");
  const main = page.locator(`main article#m-${uid}`);
  await main.hover();
  await main.locator("[data-popup=reactions]").first().click();
  await page.locator('[role=gridcell][data-emoji="👍"]').click();
  await expect(page.locator(`main article#m-${uid} [data-action=react][data-emoji="👍"]`)).toBeVisible();
  await page.goto("/");
  await expect(page.locator(`[data-card="${uid}"] section[aria-label] a`)).toContainText("a reply");
});

test("searches and pages through memos", async ({ page, request }) => {
  for (let i = 0; i < 25; i++) await request.post("/api/memos", { ...auth, data: { content: `paging ${i} #paging` } });
  await page.goto("/");
  await page.locator("[data-popup=search]").click();
  await page.locator("[data-mode=expression]").click();
  await page.locator("input[name=q]").fill("#paging");
  await page.locator("input[name=q]").press("Enter");
  await expect(page).toHaveURL(/q=%23paging/);
  await expect(page.locator("#memo-list article")).toHaveCount(16);
  await page.mouse.wheel(0, 20000);
  await expect(page.locator("#memo-list article")).toHaveCount(25);
});

test("renders memos from the API again in the browser", async ({ page, request }) => {
  const { uid } = await (await request.post("/api/memos", { ...auth, data: { content: "**api** memo" } })).json();
  await page.goto(`/memos/${uid}`);
  await expect(page.locator(`article#m-${uid}`)).not.toHaveAttribute("data-stale", "");
  await expect.poll(async () => (await (await request.get(`/memos/${uid}`)).text()).includes(`id="m-${uid}"`) && !(await (await request.get(`/memos/${uid}`)).text()).includes("data-stale")).toBe(true);
});

test("highlights the searched words in memo bodies", async ({ page, request }) => {
  await request.post("/api/memos", { ...auth, data: { content: "a Zebracorn appears" } });
  await page.goto("/?q=zebracorn");
  await expect.poll(() => page.evaluate(() => [...(CSS.highlights.get("memo-search-match") ?? [])].map((r) => r.toString()))).toEqual(["Zebracorn"]);
});

test("opens tag suggestions for a tag typed before the editor loads", async ({ page, request }) => {
  await request.post("/api/memos", { ...auth, data: { content: "#earlytag" } });
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/assets/c-*.js", async (route) => {
    const response = await route.fetch();
    if ((await response.text()).includes("memos-lite-source-mode")) await held;
    await route.fulfill({ response });
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator("[data-composer=create] [contenteditable]").click();
  await page.keyboard.type("hi #ear");
  release();
  await expect(page.getByRole("option", { name: "#earlytag" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-composer=create] .memo-editor-root")).toContainText("hi #earlytag");
});

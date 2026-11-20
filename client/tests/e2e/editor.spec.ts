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

test("the composer's attachments carry memos' toolbar and details, and keep the order they are dragged into", async ({ page, request }) => {
  await page.goto("/");
  await page.locator("[data-composer=create] .memo-editor-root").click();
  await page.keyboard.type("ordered attachments");
  await page.locator("[data-composer=create] [data-popup=insert-menu]").click();
  const chooser = page.waitForEvent("filechooser");
  await page.locator("[data-insert=attachment]").click();
  await (await chooser).setFiles([
    { name: "first.png", mimeType: "image/png", buffer: png() },
    { name: "second.png", mimeType: "image/png", buffer: png() },
    { name: "one.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(3009, 1) },
    { name: "two.txt", mimeType: "text/plain", buffer: Buffer.alloc(600, 97) },
  ]);
  const extras = page.locator("[data-composer=create] [data-composer-extras]");
  const tiles = extras.locator("[data-reorder=tiles] > [data-reorder-key]");
  const rows = extras.locator("[data-reorder=rows] > [data-reorder-key]");
  await expect(tiles).toHaveCount(2);
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("New·PDF·2.9 KB");

  await tiles.first().hover();
  const keys = tiles.first().locator("[data-extra]:visible");
  await expect(keys).toHaveCount(3);
  expect(await keys.evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")))).toEqual(["Markup", "Insert image", "Remove attachment"]);

  const box = async (i: number) => (await tiles.nth(i).boundingBox())!;
  const [a, b] = [await box(0), await box(1)];
  await page.mouse.move(a.x + 20, a.y + 80);
  await page.mouse.down();
  await page.mouse.move(a.x + 30, a.y + 80, { steps: 2 });
  await page.mouse.move(b.x + 40, b.y + 80, { steps: 8 });
  await page.mouse.up();
  await expect(tiles.first()).toHaveAttribute("aria-label", "Preview second.png");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await rows.first().locator("[data-reorder-handle]").focus();
  await page.keyboard.press("ArrowDown");
  await expect(rows.first()).toContainText("two.txt");

  await tiles.first().focus();
  await page.keyboard.press("Alt+ArrowRight");
  await expect(tiles.first()).toHaveAttribute("aria-label", "Preview first.png");
  await tiles.nth(1).focus();
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(tiles.first()).toHaveAttribute("aria-label", "Preview second.png");

  await page.locator("[data-composer=create] [data-action=save]").click();
  await expect(extras.locator("[data-reorder-key]")).toHaveCount(0);
  const uid = await page.locator("#memo-list article").filter({ hasText: "ordered attachments" }).first().getAttribute("data-card");
  const memo = await (await request.get(`/api/memos/${uid}`, auth)).json();
  expect(memo.attachments.map((x: { filename: string }) => x.filename)).toEqual(["second.png", "first.png", "two.txt", "one.pdf"]);
});

test("the composer removes an attachment and inserts an image into the text from its toolbar", async ({ page }) => {
  await page.goto("/");
  await page.locator("[data-composer=create] .memo-editor-root").click();
  await page.locator("[data-composer=create] [data-popup=insert-menu]").click();
  const chooser = page.waitForEvent("filechooser");
  await page.locator("[data-insert=attachment]").click();
  await (await chooser).setFiles([
    { name: "keep.png", mimeType: "image/png", buffer: png() },
    { name: "drop.png", mimeType: "image/png", buffer: png() },
  ]);
  const tiles = page.locator("[data-composer=create] [data-reorder=tiles] > [data-reorder-key]");
  await expect(tiles).toHaveCount(2);
  await tiles.nth(1).hover();
  await tiles.nth(1).getByRole("button", { name: "Remove attachment" }).click();
  await expect(tiles).toHaveCount(1);
  await tiles.first().hover();
  await tiles.first().getByRole("button", { name: "Insert image" }).click();
  await expect(tiles).toHaveCount(0);
  await expect(page.locator("[data-composer=create] .memo-editor-root img")).toHaveCount(1);
});

test("editing a memo lists its links with their dates and the memos linking to it", async ({ page, request }) => {
  const { uid: target } = await (await request.post("/api/memos", { ...auth, data: { content: "relation target memo" } })).json();
  await page.goto("/");
  await page.locator("[data-composer=create] .memo-editor-root").click();
  await page.keyboard.type("relation source memo");
  await page.locator("[data-composer=create] [data-popup=insert-menu]").click();
  await page.locator("[data-insert=link]").click();
  await expect(page.getByRole("dialog").getByPlaceholder("Search")).toBeFocused();
  await page.keyboard.type("relation target");
  await page.keyboard.press("Enter");
  const extras = page.locator("[data-composer=create] [data-composer-extras]");
  await expect(extras.locator(`[data-link="${target}"]`)).toContainText("relation target memo");
  await expect(extras.locator(`[data-link="${target}"] time`)).toHaveAttribute("data-fmt", "short");
  await page.locator("[data-composer=create] [data-action=save]").click();
  await expect(extras.locator("[data-link]")).toHaveCount(0);

  const card = page.locator(`article#m-${target}`);
  await card.hover();
  await card.locator("[data-popup=memo-menu]").click();
  await page.locator("[role=menu] [data-action=edit]").click();
  const back = card.locator("[data-composer-extras] a[title='Referenced by']");
  await expect(back).toContainText("relation source memo");
  await expect(back.locator("time")).toHaveCount(1);
  await card.locator("[data-cancel]").click();

  const source = page.locator("#memo-list article").filter({ hasText: "relation source memo" }).first();
  await source.hover();
  await source.locator("[data-popup=memo-menu]").click();
  await page.locator("[role=menu] [data-action=edit]").click();
  const link = source.locator(`[data-composer-extras] [data-link="${target}"]`);
  await expect(link).toContainText("relation target memo");
  await link.hover();
  await link.getByRole("button", { name: "Remove relation" }).click();
  await expect(link).toHaveCount(0);
});

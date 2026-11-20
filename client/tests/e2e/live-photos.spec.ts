import { expect, test } from "@playwright/test";
import { auth, memo, png, upload } from "./pages-helpers";

const motionJpeg = () =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe1]),
    Buffer.from('<?xpacket begin=""?><rdf:Description GCamera:MotionPhoto="1" GCamera:MotionPhotoPresentationTimestampUs="123456"></rdf:Description>'),
    Buffer.from([0xff, 0xd9, 0, 0, 0, 0x10, ...Buffer.from("ftypisom"), 0, 0, 0, 0]),
  ]);

test("pairs an Apple Live Photo into one Live tile that moves, plays and goes away whole", async ({ page, request }) => {
  await page.goto("/");
  await page.locator("[data-composer=create] .memo-editor-root").click();
  await page.keyboard.type("apple live photo");
  await page.locator("[data-composer=create] [data-popup=insert-menu]").click();
  const chooser = page.waitForEvent("filechooser");
  await page.locator("[data-insert=attachment]").click();
  await (await chooser).setFiles([
    { name: "IMG_0001.JPG", mimeType: "image/jpeg", buffer: png([200, 40, 40]) },
    { name: "IMG_0001.MOV", mimeType: "video/quicktime", buffer: Buffer.from("not a real movie") },
    { name: "plain.png", mimeType: "image/png", buffer: png() },
  ]);
  const tiles = page.locator("[data-composer=create] [data-reorder=tiles] > [data-reorder-key]");
  await expect(tiles).toHaveCount(2);
  await expect(tiles.first()).toContainText("Live");
  await expect(tiles.first()).toHaveAttribute("data-motion", /IMG_0001\.MOV$/);
  await tiles.first().hover();
  expect(await tiles.first().locator("[data-extra]:visible").evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")))).toEqual(["Insert image", "Remove attachment"]);
  await tiles.first().focus();
  await page.keyboard.press("Alt+ArrowRight");
  await expect(tiles.nth(1)).toContainText("Live");
  await page.locator("[data-composer=create] [data-action=save]").click();

  const card = page.locator("#memo-list article").filter({ hasText: "apple live photo" });
  const uid = await card.getAttribute("data-card");
  const saved = await (await request.get(`/api/memos/${uid}`, { headers: auth })).json();
  expect(saved.attachments.map((x: { filename: string }) => x.filename)).toEqual(["plain.png", "IMG_0001.JPG", "IMG_0001.MOV"]);
  await expect(card.locator("[data-action=preview]")).toHaveCount(2);
  const badge = card.getByRole("button", { name: "Hover or press to play the live photo", exact: true });
  await expect(badge).toHaveCount(1);
  await badge.focus();
  await expect(card.locator("[data-motion] video")).toHaveAttribute("src", /IMG_0001\.MOV$/);

  await card.locator("[data-motion] img").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("img", { name: "Preview live photo 2 of 2" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Hover or press to play the live photo", exact: true })).toHaveText("Live");
  await page.keyboard.press("Escape");

  await page.goto("/attachments?tab=media");
  const media = page.locator('[data-part=media] article[class*="rounded-[20px]"]');
  await expect(media.filter({ hasText: "IMG_0001.JPG" })).toContainText("Live Photo");
  await expect(media.filter({ hasText: "IMG_0001.MOV" })).toHaveCount(0);

  await page.goto(`/memos/${uid}`);
  await page.locator("main article [data-popup=memo-menu]").click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  const editing = page.locator("main [data-composer-extras] [data-reorder=tiles] > [data-reorder-key]");
  await expect(editing).toHaveCount(2);
  await editing.nth(1).hover();
  await editing.nth(1).getByRole("button", { name: "Remove attachment" }).click();
  await expect(editing).toHaveCount(1);
  await page.locator("main").getByRole("button", { name: "Update" }).click();
  await expect(editing).toHaveCount(0);
  await expect(page.locator("main article [data-motion]")).toHaveCount(0);
  const after = await (await request.get(`/api/memos/${uid}`, { headers: auth })).json();
  expect(after.attachments.map((x: { filename: string }) => x.filename)).toEqual(["plain.png"]);

  await page.goto("/attachments?tab=unused");
  const rows = page.locator("[data-unused]").filter({ hasText: "IMG_0001" });
  await expect(rows).toHaveCount(2);
  const [still, video] = await rows.evaluateAll((els) => els.map((el) => el.querySelector("a[href*='/file/']")!.getAttribute("href")!));
  await page.getByRole("button", { name: "Delete all unused" }).click();
  await page.locator("[data-action=dialog-ok]").click();
  await expect(page.getByText("No data found.")).toBeVisible();
  for (const href of [still, video]) expect((await request.get(href)).status()).toBe(404);
});

test("finds an Android motion photo and serves its video", async ({ page, request }) => {
  const motion = await upload(request, "PXL_0001.MP.jpg", "image/jpeg", motionJpeg());
  const plain = await upload(request, "plain.jpg", "image/jpeg", png());
  await memo(request, "android motion photo", { attachments: [motion, plain] });
  await page.goto("/");
  const card = page.locator("#memo-list article").filter({ hasText: "android motion photo" });
  const live = card.locator("[data-motion]");
  await expect(live).toHaveCount(1);
  await expect(live).toHaveAttribute("data-pts", "123456");
  const clip = await request.get((await live.getAttribute("data-motion"))!);
  expect(clip.headers()["content-type"]).toBe("video/mp4");
  expect((await clip.body()).subarray(4, 8).toString()).toBe("ftyp");
  const partial = await request.get((await live.getAttribute("data-motion"))!, { headers: { range: "bytes=4-7" } });
  expect(partial.status()).toBe(206);
  expect((await partial.body()).toString()).toBe("ftyp");
  const still = await request.get((await live.getAttribute("data-src"))!);
  expect(still.headers()["content-type"]).toBe("image/jpeg");
  expect((await still.body()).length).toBe(motionJpeg().length);
  const other = await card.locator("[data-action=preview]:not([data-motion])").getAttribute("data-src");
  expect((await request.get(`${other}?motion=true`)).status()).toBe(400);

  await page.goto("/attachments?tab=media");
  await expect(page.locator('[data-part=media] article[class*="rounded-[20px]"]').filter({ hasText: "PXL_0001.MP.jpg" })).toContainText("Live Photo");
});

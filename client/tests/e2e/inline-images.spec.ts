import { expect, type Page, test } from "@playwright/test";
import { auth, png } from "./pages-helpers";

const JPEG =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAAEAAQDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDIooor6A4T/9k=";

const motionJpeg = () => {
  const jpeg = Buffer.from(JPEG, "base64");
  const xmp = Buffer.from('http://ns.adobe.com/xap/1.0/\0<rdf:Description GCamera:MotionPhoto="1" GCamera:MotionPhotoPresentationTimestampUs="123456"></rdf:Description>');
  const length = Buffer.alloc(2);
  length.writeUInt16BE(xmp.length + 2);
  return Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xe1]), length, xmp, jpeg.subarray(2), Buffer.from([0, 0, 0, 0x10, ...Buffer.from("ftypisom"), 0, 0, 0, 0])]);
};

type Upload = { name: string; mimeType: string; buffer: Buffer };

async function insertImages(page: Page, text: string, files: Upload[]) {
  await page.locator("[data-composer=create] .memo-editor-root").click();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
  await page.locator("[data-composer=create] [data-popup=insert-menu]").click();
  const chooser = page.waitForEvent("filechooser");
  await page.locator("[data-insert=image]").click();
  await (await chooser).setFiles(files);
}

const library = (page: Page) => page.locator('[data-part=media] article[class*="rounded-[20px]"]');

test("Insert image writes an Apple Live Photo's still into the text and keeps the pair attached", async ({ page, request }) => {
  await page.goto("/");
  await insertImages(page, "apple inline", [
    { name: "IMG_0002.JPG", mimeType: "image/jpeg", buffer: png([200, 40, 40]) },
    { name: "IMG_0002.MOV", mimeType: "video/quicktime", buffer: Buffer.from("not a real movie") },
  ]);
  const composer = page.locator("[data-composer=create]");
  await expect(composer.locator(".memo-editor-root img")).toHaveCount(1);
  await expect(composer.locator(".memo-editor-root img")).toHaveAttribute("src", /^\/file\/attachments\/[^/]+\/IMG_0002\.JPG$/);
  await expect(composer.locator("[data-composer-extras] [data-reorder-key]")).toHaveCount(0);
  await expect(composer.locator(".memo-upload-anchor")).toHaveCount(0);
  await composer.locator("[data-action=save]").click();

  const card = page.locator("#memo-list article").filter({ hasText: "apple inline" });
  const uid = await card.getAttribute("data-card");
  const saved = await (await request.get(`/api/memos/${uid}`, { headers: auth })).json();
  const [still, video] = saved.attachments;
  expect(saved.attachments.map((a: { filename: string }) => a.filename)).toEqual(["IMG_0002.JPG", "IMG_0002.MOV"]);
  expect(still.motionGroup).toBeTruthy();
  expect(video.motionGroup).toBe(still.motionGroup);
  expect(saved.content).toBe(`apple inline\n\n![IMG_0002](/file/attachments/${still.uid})\n`);
  await expect(card.locator(".memo-content-root img")).toHaveAttribute("src", `/file/attachments/${still.uid}/IMG_0002.JPG`);
  await expect(card.locator("[data-action=preview]")).toHaveCount(0);
  await expect(card.locator("[data-motion]")).toHaveCount(0);
  expect((await request.get(`/file/attachments/${still.uid}`)).headers()["content-type"]).toBe("image/jpeg");

  await page.goto("/attachments?tab=media");
  await expect(library(page).filter({ hasText: "IMG_0002.JPG" })).toContainText("Live Photo");
  await page.goto("/attachments?tab=unused");
  await expect(page.locator("[data-unused]").filter({ hasText: "IMG_0002" })).toHaveCount(0);

  await page.goto(`/memos/${uid}`);
  await page.locator("main article [data-popup=memo-menu]").click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await expect(page.locator("main .memo-editor-root img")).toHaveCount(1);
  await expect(page.locator("main [data-composer-extras] [data-reorder-key]")).toHaveCount(0);
});

test("Insert image keeps an Android motion photo's Live behaviour, and taking it out of the text shows it attached again", async ({ page, request }) => {
  await page.goto("/");
  await insertImages(page, "android inline", [{ name: "PXL_0002.MP.jpg", mimeType: "image/jpeg", buffer: motionJpeg() }]);
  const composer = page.locator("[data-composer=create]");
  await expect(composer.locator(".memo-editor-root img")).toHaveCount(1);
  await expect(composer.locator("[data-composer-extras] [data-reorder-key]")).toHaveCount(0);
  await composer.locator("[data-action=save]").click();

  const card = page.locator("#memo-list article").filter({ hasText: "android inline" });
  await expect(card.locator(".memo-content-root img")).toHaveCount(1);
  await expect(card.locator("[data-motion]")).toHaveCount(0);
  const uid = await card.getAttribute("data-card");
  const saved = await (await request.get(`/api/memos/${uid}`, { headers: auth })).json();
  expect(saved.attachments).toHaveLength(1);
  const clip = await request.get(`/file/attachments/${saved.attachments[0].uid}?motion=true`);
  expect(clip.headers()["content-type"]).toBe("video/mp4");
  await page.goto("/attachments?tab=media");
  await expect(library(page).filter({ hasText: "PXL_0002.MP.jpg" })).toContainText("Live Photo");

  await page.goto(`/memos/${uid}`);
  await page.locator("main article [data-popup=memo-menu]").click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  const tiles = page.locator("main [data-composer-extras] [data-reorder=tiles] > [data-reorder-key]");
  await expect(tiles).toHaveCount(0);
  await page.locator("main .memo-editor-root img").click({ force: true });
  await page.keyboard.press("Backspace");
  await expect(page.locator("main .memo-editor-root img")).toHaveCount(0);
  await expect(tiles).toHaveCount(1);
  await expect(tiles.first()).toContainText("Live");
  await expect(tiles.first()).toHaveAttribute("data-motion", /\?motion=true$/);
  await page.locator("main").getByRole("button", { name: "Update" }).click();
  await expect(page.locator("main [data-composer=edit]")).toHaveCount(0);
  await expect(page.locator("main article [data-motion]")).toHaveCount(1);
  const after = await (await request.get(`/api/memos/${uid}`, { headers: auth })).json();
  expect(after.content).toBe("android inline\n");
  expect(after.attachments.map((a: { uid: string }) => a.uid)).toEqual([saved.attachments[0].uid]);

  await page.locator("main article [data-popup=memo-menu]").click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await tiles.first().hover();
  await tiles.first().getByRole("button", { name: "Insert image" }).click();
  await expect(page.locator("main .memo-editor-root img")).toHaveCount(1);
  await expect(tiles).toHaveCount(0);
});

test("dropping files on the editor writes images in where they land and attaches the rest; pasting attaches", async ({ page, request }) => {
  await page.goto("/");
  const root = page.locator("[data-composer=create] .memo-editor-root");
  await root.click();
  await page.keyboard.type("drop first");
  await page.keyboard.press("Enter");
  await page.keyboard.type("drop second");
  const files = [
    { name: "dropped.png", type: "image/png", data: png([40, 200, 40]).toString("base64") },
    { name: "notes.txt", type: "text/plain", data: Buffer.from("hello").toString("base64") },
  ];
  await root.evaluate((editor, files) => {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(new File([Uint8Array.from(atob(f.data), (ch) => ch.charCodeAt(0))], f.name, { type: f.type }));
    const target = editor.querySelector("p")!;
    const r = target.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 20, clientY: r.top + r.height / 2 };
    for (const type of ["dragenter", "dragover", "drop"]) target.dispatchEvent(new DragEvent(type, init));
  }, files);
  await expect(root.locator("img")).toHaveCount(1);
  expect(await root.locator(":scope > *").evaluateAll((els) => els.map((el) => (el.querySelector("img") ? "img" : el.textContent)))).toEqual(["drop first", "img", "drop second"]);
  const extras = page.locator("[data-composer=create] [data-composer-extras]");
  await expect(extras.locator("[data-reorder=rows] > [data-reorder-key]")).toHaveCount(1);
  await expect(extras.locator("[data-reorder=tiles] > [data-reorder-key]")).toHaveCount(0);

  await root.evaluate((editor) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([1, 2, 3])], "pasted.png", { type: "image/png" }));
    editor.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
  });
  await expect(extras.locator("[data-reorder=tiles] > [data-reorder-key]")).toHaveCount(1);
  await expect(root.locator("img")).toHaveCount(1);

  await page.locator("[data-composer=create] [data-action=save]").click();
  const uid = await page.locator("#memo-list article").filter({ hasText: "drop first" }).getAttribute("data-card");
  const saved = await (await request.get(`/api/memos/${uid}`, { headers: auth })).json();
  const dropped = saved.attachments.find((a: { filename: string }) => a.filename === "dropped.png");
  expect(saved.content).toBe(`drop first\n\n![dropped](/file/attachments/${dropped.uid})\n\ndrop second\n`);
  expect(saved.attachments.map((a: { filename: string }) => a.filename).sort()).toEqual(["dropped.png", "notes.txt", "pasted.png"]);
});

test("a memo cannot show an attachment inline that it does not have", async ({ request }) => {
  const res = await request.post("/api/memos", { headers: auth, data: { content: "![x](/file/attachments/nothere)" } });
  expect(res.status()).toBe(400);
});

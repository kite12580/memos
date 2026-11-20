import { expect, test } from "@playwright/test";
import { auth, exifJpeg, exifTiff, memo, png, upload } from "./pages-helpers";

const composer = "[data-composer=create] .memo-editor-root";

test("saves once and keeps what is typed while the save is in flight", async ({ page, request }) => {
  await page.goto("/");
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/memos?list=1", async (route) => {
    await held;
    await route.continue();
  });
  await page.locator(composer).click();
  await expect(page.locator("[data-composer=create][data-ready]")).toHaveCount(1);
  await page.keyboard.type("flight one #flighttag");
  await page.locator("[data-composer=create] [data-action=save]").click();
  await page.locator(composer).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" flight two");
  release();
  await expect(page.locator("#memo-list article").filter({ hasText: "flight one" })).toHaveCount(1);
  await expect(page.locator(composer)).toHaveText("flight two");
  const list = await (await request.get(`/api/memos?q=${encodeURIComponent('"flight one"')}`, { headers: auth })).json();
  expect(list.memos).toHaveLength(1);
  await expect(page.locator('#sidebar a[aria-label^="#flighttag"]')).toBeVisible();
});

test("keeps the sidebar and empty state in step with deletes", async ({ page, request }) => {
  const uid = await memo(request, "only one #lonelytag");
  await page.goto("/?q=%23lonelytag");
  await expect(page.locator('#sidebar a[aria-label^="#lonelytag"]')).toBeVisible();
  await page.locator(`article#m-${uid} [data-popup=memo-menu]`).click();
  await page.locator("[role=menu] [data-action=delete]").click();
  await page.locator("[data-action=dialog-ok]").click();
  await expect(page.locator("#memo-list [data-empty]")).toContainText("No matching memos");
  await expect(page.locator('#sidebar a[aria-label^="#lonelytag"]')).toHaveCount(0);
  await page.locator(composer).click();
  await expect(page.locator("[data-composer=create][data-ready]")).toHaveCount(1);
  await page.keyboard.type("made in an empty filter");
  await page.keyboard.press("Control+Enter");
  await expect(page.locator("#memo-list article").filter({ hasText: "made in an empty filter" })).toBeVisible();
  await expect(page.locator("#memo-list [data-empty]")).toHaveCount(0);
});

test("toasts archive and restore", async ({ page, request }) => {
  const uid = await memo(request, "archive me");
  await page.goto("/");
  await page.locator(`article#m-${uid} [data-popup=memo-menu]`).click();
  await page.locator("[role=menu] [data-action=archive]").click();
  await expect(page.locator(".mu-toast")).toContainText("Archived successfully");
  await page.goto(`/memos/${uid}`);
  await page.locator(`article#m-${uid} [data-popup=memo-menu]`).click();
  await page.locator("[role=menu] [data-action=archive]").click();
  await expect(page.locator(".mu-toast")).toContainText("Restored successfully");
});

test("a tag in a memo filters by it, from the mouse or the keyboard", async ({ page, request }) => {
  const uid = await memo(request, "tagged #clickme");
  await page.goto(`/memos/${uid}`);
  await page.locator('.memo-content-root [data-tag="clickme"]').click();
  await expect(page).toHaveURL(/\/\?q=%23clickme$/);
  await page.goto(`/memos/${uid}`);
  await page.locator('.memo-content-root [data-tag="clickme"]').focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/\?q=%23clickme$/);
});

test("opens an image preview and its details from the keyboard and closes them with Escape", async ({ page, request }) => {
  const image = await upload(request, "kb.png", "image/png", png());
  const uid = await memo(request, "keyboard preview", { attachments: [image] });
  await page.goto(`/memos/${uid}`);
  await page.locator("[data-action=preview]").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "kb.png" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Close preview" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  const info = page.getByRole("button", { name: "Show attachment details" });
  await expect(info).toBeFocused();
  await expect(info).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  const details = page.getByRole("complementary", { name: "Details" });
  await expect(details).toContainText("PNG · ");
  await expect(details).toContainText("No saved capture metadata.");
  await expect(page.getByRole("button", { name: "Hide attachment details" }).first()).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: "Hide attachment details" }).first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(details).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "kb.png" })).toBeVisible();
  await expect(info).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("[data-action=preview]")).toBeFocused();
});

test("saves photo metadata when asked and shows it in the preview details", async ({ page, request }) => {
  await page.goto("/settings#preference");
  await page.getByRole("switch", { name: "Save media metadata" }).click();
  await expect(page.getByRole("switch", { name: "Save media metadata" })).toHaveAttribute("aria-checked", "true");
  await page.goto("/");
  await page.locator("[data-composer=create] .memo-editor-root").click();
  await page.keyboard.type("exif photo");
  await page.locator("[data-composer=create] [data-popup=insert-menu]").click();
  const chooser = page.waitForEvent("filechooser");
  await page.locator("[data-insert=attachment]").click();
  await (await chooser).setFiles([
    { name: "exif.jpg", mimeType: "image/jpeg", buffer: exifJpeg() },
    { name: "exif.png", mimeType: "image/png", buffer: png([128, 128, 128], exifTiff()) },
  ]);
  await expect(page.locator("[data-composer=create] [data-composer-extras] img")).toHaveCount(2);
  await page.locator("[data-composer=create] [data-action=save]").click();
  await page.locator("#memo-list article").filter({ hasText: "exif photo" }).locator("[data-action=preview]").first().click();
  await page.getByRole("button", { name: "Show attachment details" }).click();
  const details = page.getByRole("complementary", { name: "Details" });
  await expect(details).toContainText("Canon Canon EOS R6");
  await expect(details).toContainText("ƒ/2.8");
  await expect(details).toContainText("May 1, 2024, 02:23:45 PM");
  await expect(details).toContainText("Time zone unknown");
  await expect(details).not.toContainText("No saved capture metadata.");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("dialog", { name: "exif.png" })).toBeVisible();
  await expect(details).toContainText("Canon Canon EOS R6");
  await expect(details).toContainText("4 × 4 px");

  const media = JSON.stringify({ photo: { location: { latitude: 48.8582, longitude: 2.2945, altitudeMeters: 35.5 } } });
  const res = await request.post(`/api/memos/attachments?name=gps.jpg&type=image%2Fjpeg&w=4&h=4&media=${encodeURIComponent(media)}`, { headers: auth, data: png() });
  const uid = await memo(request, "gps photo", { attachments: [(await res.json()).uid] });
  await page.goto(`/memos/${uid}`);
  await page.locator("[data-action=preview]").click();
  await page.getByRole("button", { name: "Show attachment details" }).click();
  await expect(details).toContainText("4 × 4 px");
  await expect(details).toContainText("48.85820°, 2.29450°");
  await expect(details).toContainText("Altitude · 35.5 m");
  await details.getByRole("button", { name: "Copy coordinates" }).click();
  await expect(details.getByRole("button", { name: "Coordinates copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("48.8582, 2.2945");
  await page.mouse.click(200, 450);
  await expect(details).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "gps.jpg" })).toBeVisible();
});

test("switches toggle from the keyboard", async ({ page }) => {
  await page.goto("/settings#preference");
  await page.getByRole("switch", { name: "Compact mode" }).focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("switch", { name: "Compact mode" })).toHaveAttribute("aria-checked", "true");
});

test("compact mode folds a long memo on every load", async ({ page, request }) => {
  await memo(request, `foldme ${"long words ".repeat(400)}`);
  await page.goto("/settings#preference");
  await page.getByRole("switch", { name: "Compact mode" }).click();
  await expect(page.getByRole("switch", { name: "Compact mode" })).toHaveAttribute("aria-checked", "true");
  for (let i = 0; i < 3; i++) {
    await page.goto("/?q=foldme");
    await expect(page.locator("#memo-list [data-action=clamp]")).toBeVisible();
    await expect(page.locator("#memo-list [data-clamp]")).toHaveClass(/max-h-\[360px\]/);
  }
  const uid = await memo(request, `deepfold ${"far words ".repeat(400)}`);
  for (let i = 0; i < 25; i++) await memo(request, `deepfold filler ${i}`);
  await page.goto("/?q=deepfold");
  const card = page.locator(`article#m-${uid}`);
  while (!(await card.count())) await page.mouse.wheel(0, 4000);
  await card.scrollIntoViewIfNeeded();
  await expect(card.locator("[data-action=clamp]")).toBeVisible();
});

test("shows a saved draft after a reload", async ({ page }) => {
  await page.goto("/");
  await page.locator(composer).click();
  await expect(page.locator("[data-composer=create][data-ready]")).toHaveCount(1);
  await page.keyboard.type("draft to keep");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("memos-lite-draft")?.trim())).toBe("draft to keep");
  await page.reload();
  await expect(page.locator(composer)).toHaveText("draft to keep");
});

test("a missing memo gets the app's not-found page", async ({ page }) => {
  const res = await page.goto("/memos/doesnotexist");
  expect(res?.status()).toBe(404);
  await expect(page.locator("main h1")).toHaveText("The page you are looking for can't be found.");
  await expect(page.locator("#sidebar nav[aria-label=Primary]")).toBeVisible();
});

test("links a memo from the keyboard", async ({ page, request }) => {
  await memo(request, "link target keyboard");
  await page.goto("/");
  await page.locator(composer).click();
  await page.locator("[data-composer=create] [data-popup=insert-menu]").click();
  await page.locator("[data-insert=link]").click();
  await expect(page.getByRole("dialog").getByPlaceholder("Search")).toBeFocused();
  await page.keyboard.type("target keyboard");
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-composer=create] [data-composer-extras]")).toContainText("link target keyboard");
  await memo(request, "second arrow target");
  await page.locator("[data-composer=create] [data-popup=insert-menu]").click();
  await page.locator("[data-insert=link]").click();
  await expect(page.getByRole("dialog").getByPlaceholder("Search")).toBeFocused();
  await page.keyboard.type("arrow target");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-composer=create] [data-composer-extras]")).toContainText("second arrow target");
});

test("the grid keeps every card and the composer when a memo is added or deleted", async ({ page, request }) => {
  for (let i = 0; i < 6; i++) await memo(request, `grid card ${i}`);
  await page.goto("/settings#preference");
  await page.locator("[data-select=layout]").click();
  await page.getByRole("option", { name: "2" }).click();
  await expect(page.locator("[data-select=layout]")).toHaveText("2 columns");
  await page.goto("/?q=grid");
  const cards = page.locator("#memo-list [data-card]");
  await expect(cards).toHaveCount(6);
  await page.locator(composer).click();
  await expect(page.locator("[data-composer=create][data-ready]")).toHaveCount(1);
  await page.keyboard.type("grid card new");
  await page.keyboard.press("Control+Enter");
  await expect(cards).toHaveCount(7);
  await expect(page.locator("[data-composer=create]")).toBeVisible();
  const texts = await cards.evaluateAll((els) =>
    els.sort((a, b) => Number((a as HTMLElement).dataset.i) - Number((b as HTMLElement).dataset.i)).map((e) => e.querySelector(".memo-content-root")!.textContent),
  );
  expect(texts).toEqual(["grid card new", "grid card 5", "grid card 4", "grid card 3", "grid card 2", "grid card 1", "grid card 0"]);
  await cards.first().locator("[data-popup=memo-menu]").click();
  await page.locator("[role=menu] [data-action=delete]").click();
  await page.locator("[data-action=dialog-ok]").click();
  await expect(cards).toHaveCount(6);
  await expect(page.locator("[data-composer=create]")).toBeVisible();
});

test("New memo writes a memo from any page in memos' dialog", async ({ page }) => {
  await page.goto("/attachments");
  const trigger = page.locator("#sidebar").getByRole("link", { name: "New memo" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "New memo" });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/\/attachments$/);
  await page.keyboard.type("from the dialog");
  await page.keyboard.press("Control+Enter");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.goto("/");
  await expect(page.locator("#memo-list article").first()).toContainText("from the dialog");
});

import { expect, test } from "@playwright/test";
import { memo, png, upload } from "./pages-helpers";

test.use({ timezoneId: "UTC" });

test("groups the library into media, documents and audio, with counts in the sidebar", async ({ page, request }) => {
  const image = await upload(request, "lib-photo.png", "image/png", png([40, 120, 200]));
  const doc = await upload(request, "lib-notes.txt", "text/plain", Buffer.from("notes"));
  const audio = await upload(request, "lib-voice.mp3", "audio/mpeg", Buffer.from("ID3...."));
  await memo(request, "Library memo", { attachments: [image, doc, audio] });
  await page.goto("/attachments");
  const main = page.locator("[data-page=attachments]");
  await expect(main.locator('[data-part=media] article[class*="rounded-[20px]"]').filter({ hasText: "lib-photo.png" })).toBeVisible();
  await expect(main.locator("[data-part=documents]")).toContainText("lib-notes.txt");
  await expect(main.locator("[data-part=documents]")).toContainText("TXT");
  await expect(main.locator("[data-part=audio]")).toContainText("lib-voice.mp3");
  const sidebar = page.locator("#sidebar");
  await expect(sidebar.getByRole("link", { name: /^Media/ })).toContainText(/\d/);
  await sidebar.getByRole("link", { name: /^Documents/ }).click();
  await expect(page).toHaveURL(/tab=documents/);
  await expect(sidebar.getByRole("link", { name: /^Documents/ })).toHaveAttribute("aria-current", "page");
  await expect(main.locator("[data-part=media]")).toHaveCount(0);
  await expect(main.locator("[data-part=documents]")).toContainText("lib-notes.txt");
  await main.getByRole("link", { name: "Memo" }).first().click();
  await expect(page).toHaveURL(/\/memos\//);
});

test("loads more of a section as it scrolls", async ({ page, request }) => {
  const uids: string[] = [];
  for (let i = 0; i < 55; i++) uids.push(await upload(request, `many-${i}.png`, "image/png", png([i * 4, 100, 100])));
  await memo(request, "Many photos", { attachments: uids });
  await page.goto("/attachments?tab=media");
  const cards = page.locator('[data-part=media] article[class*="rounded-[20px]"]');
  await expect(cards).toHaveCount(50);
  await page.locator("[data-next]").scrollIntoViewIfNeeded();
  await expect(cards).not.toHaveCount(50);
  expect(await cards.count()).toBeGreaterThanOrEqual(55);
  await expect(page.locator('[data-part=media] > [data-month]')).toHaveCount(1);
});

test("deletes every unused upload", async ({ page, request }) => {
  await upload(request, "orphan-a.png", "image/png", png());
  await upload(request, "orphan-b.txt", "text/plain", Buffer.from("x"));
  await page.goto("/attachments?tab=unused");
  const rows = page.locator("[data-unused]");
  await expect(rows.filter({ hasText: "orphan-a.png" })).toBeVisible();
  await expect(rows.filter({ hasText: "orphan-b.txt" })).toContainText("Not linked");
  await page.getByRole("button", { name: "Delete all unused" }).click();
  await page.locator("[data-action=dialog-ok]").click();
  await expect(page.getByText("No data found.")).toBeVisible();
  await expect(rows).toHaveCount(0);
});

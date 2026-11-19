import { expect, test } from "@playwright/test";

const auth = { headers: { authorization: "Bearer e2e-token" } };

test("writes a memo with the editor and shows it as memos renders it", async ({ page }) => {
  await page.goto("/");
  const composer = page.locator("[data-composer=create] .memo-editor-root");
  await composer.click();
  await expect(page.locator("[data-composer=create][data-ready]")).toHaveCount(1);
  await page.keyboard.type("Hello **world** #e2e/one");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- [ ] first task");
  await page.locator("[data-composer=create] [data-action=save]").click();
  const card = page.locator("#memo-list article").first();
  await expect(card.locator(".memo-content-root strong")).toHaveText("world");
  await expect(card.locator('.mbe-tag[data-tag="e2e/one"]')).toBeVisible();
  await expect(card.locator("input.mbe-checkbox")).toHaveCount(1);
  await page.reload();
  await expect(page.locator('#sidebar a[aria-label^="#e2e/one"]')).toBeVisible();
  await expect(page.locator("#memo-list article").first().locator(".memo-content-root strong")).toHaveText("world");
});

test("ticks a task from the card", async ({ page, request }) => {
  const res = await request.post("/api/memos", { ...auth, data: { content: "- [ ] tick me\n- [ ] not me" } });
  expect(res.ok()).toBeTruthy();
  const { uid } = await res.json();
  await page.goto(`/memos/${uid}`);
  await page.locator('input.mbe-checkbox').first().click();
  await expect(page.locator("input.mbe-checkbox").first()).toBeChecked();
  const memo = await (await request.get(`/api/memos/${uid}`, auth)).json();
  expect(memo.content).toBe("- [x] tick me\n- [ ] not me");
});

test("pins, archives and deletes from the menu", async ({ page, request }) => {
  const { uid } = await (await request.post("/api/memos", { ...auth, data: { content: "menu target" } })).json();
  await page.goto("/");
  const card = page.locator(`article#m-${uid}`);
  await card.hover();
  await card.locator("[data-popup=memo-menu]").click();
  await page.locator("[role=menu] [data-action=pin]").click();
  await expect(page.locator(`article#m-${uid}[data-pinned]`)).toBeVisible();
  await page.locator(`article#m-${uid} [data-popup=memo-menu]`).click();
  await page.locator("[role=menu] [data-action=archive]").click();
  await expect(page.locator(`article#m-${uid}`)).toHaveCount(0);
  await page.goto("/archived");
  await page.locator(`article#m-${uid} [data-popup=memo-menu]`).click();
  await page.locator("[role=menu] [data-action=delete]").click();
  await page.locator("[data-action=dialog-ok]").click();
  await expect(page.locator(`article#m-${uid}`)).toHaveCount(0);
  expect((await request.get(`/api/memos/${uid}`, auth)).status()).toBe(404);
});

test("refuses writes from other sites", async ({ request }) => {
  const res = await request.post("/memos", { headers: { "sec-fetch-site": "cross-site" }, data: { content: "x" } });
  expect(res.status()).toBe(403);
});

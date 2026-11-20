import { expect, test } from "@playwright/test";
import { memo } from "./pages-helpers";

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
  const ticked = page.waitForResponse((r) => r.url().includes("/task"));
  await page.locator('input.mbe-checkbox').first().click();
  await ticked;
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

test("shows the pointer over menu items and emoji", async ({ page, request }) => {
  await memo(request, "Pointer memo");
  await page.goto("/");
  const card = page.locator("article", { hasText: "Pointer memo" });
  await card.locator("[data-popup=memo-menu]").click();
  await expect(page.getByRole("menuitem").first()).toHaveCSS("cursor", "pointer");
  await page.keyboard.press("Escape");
  await card.hover();
  await card.locator("[data-popup=reactions]").first().click();
  await expect(page.locator(".mu-combobox-item").first()).toHaveCSS("cursor", "pointer");
});

test("highlights the menu item under the pointer", async ({ page, request }) => {
  await memo(request, "Hover memo");
  await page.goto("/");
  await page.locator("article", { hasText: "Hover memo" }).locator("[data-popup=memo-menu]").click();
  const [first, second] = [page.getByRole("menuitem").nth(0), page.getByRole("menuitem").nth(1)];
  await second.hover();
  await expect(second).toHaveAttribute("data-highlighted", "");
  await expect(second).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await first.hover();
  await expect(first).toHaveAttribute("data-highlighted", "");
  await expect(second).not.toHaveAttribute("data-highlighted");
});

test("closes a hovered submenu when the pointer moves to another item", async ({ page, request }) => {
  await memo(request, "Submenu memo");
  await page.goto("/");
  await page.locator("article", { hasText: "Submenu memo" }).locator("[data-popup=memo-menu]").click();
  await page.locator("[data-submenu=tpl-copy-menu]").hover();
  const copy = page.locator("[data-action=copy-link]");
  await expect(copy).toBeVisible();
  await copy.hover();
  await page.waitForTimeout(200);
  await expect(copy).toBeVisible();
  await page.locator("[data-action=delete]").hover();
  await expect(copy).toBeHidden();
});

test("clears the highlight when the pointer leaves the menu", async ({ page, request }) => {
  await memo(request, "Leave memo");
  await page.goto("/");
  await page.locator("article", { hasText: "Leave memo" }).locator("[data-popup=memo-menu]").click();
  const pin = page.locator(".mu-menu-popup [data-action=pin]").first();
  await pin.hover();
  await expect(pin).toHaveAttribute("data-highlighted", "");
  await page.mouse.move(700, 700);
  await expect(pin).not.toHaveAttribute("data-highlighted");
});

test("opens and closes a submenu with the arrow keys", async ({ page, request }) => {
  await memo(request, "Arrow memo");
  await page.goto("/");
  await page.locator("article", { hasText: "Arrow memo" }).locator("[data-popup=memo-menu]").click();
  const trigger = page.locator("[data-submenu=tpl-copy-menu]");
  await trigger.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("[data-action=copy-link]")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator("[data-action=copy-link]")).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("a submenu opened by hover leaves focus on its trigger", async ({ page }) => {
  await page.goto("/");
  await page.locator("[data-popup=brand]").first().click();
  const theme = page.locator("[data-submenu=tpl-theme-menu]");
  await theme.hover();
  await expect(page.locator("[data-key=theme]").first()).toBeVisible();
  await expect(theme).toBeFocused();
});

import { expect, test } from "@playwright/test";
import { memo } from "./pages-helpers";

test("switches sections from the sidebar", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.locator("[data-section=preference]")).toBeVisible();
  await expect(page.locator("[data-section=tags]")).toBeHidden();
  await page.locator("#sidebar").getByRole("link", { name: "Tags" }).click();
  await expect(page.locator("[data-section=tags]")).toBeVisible();
  await expect(page.locator("[data-section=preference]")).toBeHidden();
  await expect(page.locator("#sidebar").getByRole("link", { name: "Tags" })).toHaveAttribute("aria-current", "page");
  await page.goto("/settings#resource-stats");
  await expect(page.locator("[data-section=resource-stats]")).toContainText("sqlite");
});

test("changes theme, language and display preferences", async ({ page }) => {
  await page.goto("/settings");
  await page.locator("[data-select=theme]").click();
  await page.getByRole("option", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.locator("#language").click();
  await page.locator("#language").fill("deut");
  await page.getByRole("option", { name: /Deutsch/ }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  await page.locator("#language").click();
  await page.locator("#language").fill("English");
  await page.keyboard.press("ArrowDown");
  await page.getByRole("option", { name: "English en", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.getByRole("switch", { name: "Compact mode" }).click();
  await expect(page.getByRole("switch", { name: "Compact mode" })).toHaveAttribute("aria-checked", "true");
});

test("tag rules color tags and blur their memos", async ({ page, request }) => {
  const uid = await memo(request, "Secret stuff #hush/deep and #paint");
  await page.goto("/settings#tags");
  await page.locator("[data-new-tag]").fill("hush");
  await page.locator("[data-new-blur]").click();
  await page.locator("[data-add]").click();
  await page.locator("[data-new-tag]").fill("paint");
  await page.locator("[data-new-color]").evaluate((el: HTMLInputElement) => {
    el.value = "#16a34a";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.locator("[data-add]").click();
  await expect(page.locator("[data-rule]")).toHaveCount(2);
  await page.locator("[data-save-tags]").click();
  await expect(page.locator(".mu-toast")).toContainText("Update succeeded");
  await expect(page.locator("[data-rule=paint] [data-rule-clear]")).toHaveText("#16a34a");

  await page.goto(`/memos/${uid}`);
  const card = page.locator(`article#m-${uid}`);
  const paint = card.locator('.mbe-tag[data-tag="paint"]');
  await expect(paint).toHaveCSS("background-color", /0\.18\)$/);
  await expect(card.locator("[data-slot=memo-body] > div").first()).toHaveClass(/blur-lg/);
  await card.getByRole("button", { name: "Click to show sensitive content" }).click();
  await expect(card.locator("[data-slot=memo-body] > div").first()).not.toHaveClass(/blur-lg/);

  await page.goto("/settings#tags");
  await page.locator("[data-rule=hush] [data-rule-delete]").click();
  await page.locator("[data-rule=paint] [data-rule-delete]").click();
  await page.locator("[data-save-tags]").click();
  await expect(page.locator(".mu-toast")).toContainText("Update succeeded");
  await expect(page.getByText("No tag metadata configured.")).toBeVisible();
});

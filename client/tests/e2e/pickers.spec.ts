import { expect, test } from "@playwright/test";
import { memo } from "./pages-helpers";

test("the language picker highlights under the pointer and continues from there with the keys", async ({ page }) => {
  await page.goto("/settings#preference");
  await page.locator("#language").click();
  const options = page.getByRole("option");
  await options.nth(2).hover();
  await expect(options.nth(2)).toHaveAttribute("data-highlighted", "");
  await expect(page.locator("#language")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(options.nth(3)).toHaveAttribute("data-highlighted", "");
  await expect(page.locator("[role=option][data-highlighted]")).toHaveCount(1);
});

test("the view icon picker highlights under the pointer and picks it with Enter", async ({ page }) => {
  await page.goto("/views#new");
  await page.locator("[data-icon-picker]").click();
  const picker = page.getByRole("dialog", { name: "Change view icon" });
  const cells = picker.locator("[data-icon]");
  await cells.nth(1).hover();
  await expect(cells.nth(1)).toHaveAttribute("data-highlighted", "");
  await page.keyboard.press("ArrowRight");
  await expect(cells.nth(2)).toHaveAttribute("data-highlighted", "");
  const icon = (await cells.nth(2).getAttribute("data-icon"))!.replace("lucide:", "");
  await page.keyboard.press("Enter");
  await expect(page.locator(`[data-icon-picker] .lucide-${icon}`)).toBeVisible();
});

test("the reaction picker reacts with the emoji under the pointer on Enter", async ({ page, request }) => {
  await memo(request, "Reaction hover memo");
  await page.goto("/");
  const card = page.locator("article", { hasText: "Reaction hover memo" });
  await card.hover();
  await card.locator("[data-popup=reactions]").first().click();
  const cell = page.locator("[role=grid] [data-emoji]").nth(3);
  await cell.hover();
  await expect(cell).toHaveAttribute("data-highlighted", "");
  const emoji = (await cell.getAttribute("data-emoji"))!;
  await page.keyboard.press("Enter");
  await expect(card).toContainText(emoji);
});

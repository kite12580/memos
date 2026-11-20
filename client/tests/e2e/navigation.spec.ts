import { expect, test } from "@playwright/test";
import { memo, thisMonth, today } from "./pages-helpers";

type Marked = Window & { kept?: boolean };

test("opens pages in place and restores them from history", async ({ page, request }) => {
  for (let i = 0; i < 25; i++) await memo(request, `Nav memo ${i}\n\nsecond paragraph\n\nthird paragraph`);
  await page.goto("/");
  await page.evaluate(() => ((window as Marked).kept = true));

  await page.locator("#sidebar").getByRole("link", { name: "Calendar" }).click();
  await expect(page).toHaveURL(/\/calendar$/);
  await expect(page.locator("[data-page=calendar]")).toHaveAttribute("data-month", thisMonth());
  await expect(page).toHaveTitle(/^Calendar · /);
  await page.getByRole("link", { name: "Next month" }).click();
  await expect(page.locator("[data-page=calendar]")).not.toHaveAttribute("data-month", thisMonth());

  await page.locator("#sidebar").getByRole("link", { name: "Timeline" }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.locator(`#sidebar-stats a[href$="on%3A${today()}"]`).click();
  await expect(page).toHaveURL(new RegExp(`\\?q=on%3A${today()}$`));
  await expect(page.locator(`#sidebar-stats a[href$="on%3A${today()}"]`)).toHaveAttribute("aria-label", / \(selected\)$/);

  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("dialog").locator("input[name=q]").fill("Nav memo");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\?q=.*Nav/);
  await expect(page.locator("#memo-list article").first()).toContainText("Nav memo");

  const left = await page.evaluate(() => {
    scrollTo(0, 800);
    [...document.querySelectorAll<HTMLAnchorElement>("#memo-list a.m-time")].find((a) => a.getBoundingClientRect().top > 0)!.click();
    return scrollY;
  });
  await expect(page).toHaveURL(/\/memos\//);
  await page.goBack();
  await expect(page).toHaveURL(/\?q=.*Nav/);
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(left);

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`\\?q=on%3A${today()}$`));
  expect(await page.evaluate(() => (window as Marked).kept)).toBe(true);
});

test("settings sections and writes stay in place", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => ((window as Marked).kept = true));
  await page.locator("#sidebar [data-popup=brand]").click();
  await page.locator(".mu-positioner").getByRole("link", { name: "Settings" }).click();
  await expect(page.locator("[data-section=my-account]")).toBeVisible();
  await page.locator("#sidebar").getByRole("link", { name: "Preferences" }).click();
  await expect(page.locator("[data-section=preference]")).toBeVisible();
  await page.locator("[data-select=layout]").click();
  await page.getByRole("option", { name: "2 columns" }).click();
  await expect(page.locator("[data-select=layout]")).toHaveText("2 columns");
  await page.locator("[data-select=layout]").click();
  await page.getByRole("option", { name: "List" }).click();
  await expect(page.locator("[data-select=layout]")).toHaveText("List");
  expect(await page.evaluate(() => (window as Marked).kept)).toBe(true);
});

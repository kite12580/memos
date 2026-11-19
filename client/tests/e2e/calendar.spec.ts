import { expect, test } from "@playwright/test";
import { memo, png, thisMonth, today, upload } from "./pages-helpers";

test.use({ timezoneId: "UTC" });

test("shows the month with each day's excerpt and photo, and opens a day's memos", async ({ page, request }) => {
  const photo = await upload(request, "cal.png", "image/png", png([200, 40, 40]));
  const dawn = Math.floor(Date.parse(`${today()}T00:00:01Z`) / 1000);
  await memo(request, "Calendar excerpt line\nsecond line #cal", { attachments: [photo], createdTs: dawn });
  await page.goto("/calendar");
  const cell = page.locator(`[data-calendar-date="${today()}"]`);
  await expect(cell).toHaveAttribute("aria-label", /memos? in/);
  await expect(cell.locator("[data-excerpt]")).toContainText("Calendar excerpt line");
  await expect(cell.locator("[data-preview] img").first()).toHaveAttribute("src", new RegExp(photo));
  await expect(cell).toHaveClass(/bg-mu-primary\//);
  await cell.click();
  await expect(page).toHaveURL(new RegExp(`/\\?q=on%3A${today()}$`));
  await expect(page.getByText(`on:${today()}`, { exact: true })).toBeVisible();
  await expect(page.locator("#memo-list article").first()).toBeVisible();
});

test("moves between months and picks one from the month picker", async ({ page }) => {
  await page.goto("/calendar");
  const month = thisMonth();
  await expect(page.locator("[data-page=calendar]")).toHaveAttribute("data-month", month);
  await page.getByRole("link", { name: "Next month" }).click();
  await expect(page).toHaveURL(/\/calendar\/\d{4}-\d{2}$/);
  expect(await page.locator("[data-page=calendar]").getAttribute("data-month")).not.toBe(month);
  await page.locator("[data-month-picker]").click();
  const picker = page.getByRole("dialog", { name: "Select month" });
  await expect(picker.locator("a")).toHaveCount(12);
  await picker.getByRole("button", { name: "Previous year" }).click();
  const year = Number(month.slice(0, 4)) - 1;
  await expect(picker.locator("[data-year-label]")).toHaveText(String(year));
  await picker.locator("a").first().click();
  await expect(page).toHaveURL(new RegExp(`/calendar/${year}-01$`));
  await expect(page.locator("[data-page=calendar] h1")).toHaveText(`January ${year}`);
  await page.goto("/calendar/not-a-month");
  await expect(page).toHaveURL(/\/calendar$/);
});

test("lists a day's memos under the grid on phones", async ({ page, request }) => {
  await memo(request, "Phone day memo");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/calendar");
  const day = page.locator("[data-day-memos]");
  await expect(day.locator("article").first()).toContainText("Phone day memo");
  await expect(page.locator(`[data-calendar-date="${today()}"]`)).toHaveAttribute("aria-current", "page");
});

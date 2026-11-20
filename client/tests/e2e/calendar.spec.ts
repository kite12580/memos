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
  await page.evaluate(() => ((window as unknown as { stay: boolean }).stay = true));
  await cell.click();
  await expect(page).toHaveURL(new RegExp(`/calendar/${today()}$`));
  const panel = page.locator(`[data-day-panel="${today()}"]`);
  await expect(panel.locator("article").first()).toContainText("Calendar excerpt line");
  await expect(cell).toHaveAttribute("aria-current", "page");

  const before = await panel.locator("article").count();
  await panel.getByRole("button", { name: "New memo on this day" }).click();
  await panel.locator("[data-composer] [contenteditable=true]").fill("Added from the panel");
  await panel.locator("[data-composer] [data-action=save]").click();
  await expect(panel.locator("article")).toHaveCount(before + 1);
  await expect(panel.getByRole("button", { name: "New memo on this day" })).toBeVisible();

  await panel.getByRole("link", { name: "Close" }).click();
  await expect(panel).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/calendar/${thisMonth()}$`));
  await expect(cell).not.toHaveAttribute("aria-current", "page");
  await page.goBack();
  await expect(page.locator(`[data-day-panel="${today()}"]`)).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { stay?: boolean }).stay)).toBe(true);

  await page.goto(`/calendar/${today()}`);
  await expect(page.locator(`[data-day-panel="${today()}"] article`)).toHaveCount(before + 1);
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

test("marks the searched day in the sidebar calendar", async ({ page, request }) => {
  await memo(request, "Sidebar day memo");
  await page.goto(`/?q=on:${today()}`);
  const day = page.locator(`#sidebar-stats a[href$="on%3A${today()}"]`);
  await expect(day).toHaveAttribute("aria-label", / \(selected\)$/);
  await expect(day.locator("span").first()).toHaveClass(/bg-mu-primary text-mu-on-primary/);
  await page.getByRole("button", { name: "Next month" }).first().click();
  await page.getByRole("button", { name: "Previous month" }).first().click();
  await expect(page.locator(`#sidebar-stats a[href$="on%3A${today()}"]`)).toHaveAttribute("aria-label", / \(selected\)$/);
});

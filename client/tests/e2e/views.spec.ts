import { expect, test } from "@playwright/test";
import { memo } from "./pages-helpers";

test("creates, edits, reorders and deletes a saved view", async ({ page, request }) => {
  await memo(request, "View target #viewtag");
  await memo(request, "Not in the view");
  await page.goto("/views#new");
  const form = page.locator("[data-form]");
  await expect(form).not.toHaveAttribute("inert");
  await page.locator("#view-title").fill("Tagged");
  await page.locator("[data-icon-picker]").click();
  const picker = page.getByRole("dialog", { name: "Change view icon" });
  await picker.getByPlaceholder("Search icons…").fill("rock");
  await picker.locator('[data-icon="lucide:rocket"]').click();
  await expect(page.locator("[data-icon-picker] .lucide-rocket")).toBeVisible();
  await page.locator("#view-filter").fill("#viewtag");
  await page.locator("[data-save]").click();
  const row = page.locator("[data-view]").filter({ hasText: "Tagged" });
  await expect(row).toContainText("#viewtag");
  await expect(row.locator(".lucide-rocket")).toBeVisible();

  await page.locator("[data-toggle-form]").click();
  await page.locator("[data-example='is:pinned']").click();
  await expect(page.locator("#view-title")).toHaveValue("Pinned");
  await page.locator("[data-icon-picker]").click();
  await page.getByRole("tab", { name: "Emoji" }).click();
  await page.locator('[role=dialog] [data-icon="🚀"]').click();
  await page.locator("[data-save]").click();
  await expect(page.locator("[data-view]")).toHaveCount(2);
  await expect(page.locator("[data-view]").nth(1)).toContainText("🚀");

  await page.locator("[data-view]").nth(1).locator("[data-view-menu]").click();
  await page.getByRole("menuitem", { name: "Move up" }).click();
  await expect(page.locator("[data-view]").first()).toContainText("Pinned");

  const tagged = page.locator("[data-view]").filter({ hasText: "Tagged" });
  await tagged.locator("[data-view-menu]").click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await expect(page.locator("[data-form-title]")).toHaveText("Edit view");
  await page.locator("#view-title").fill("Tagged memos");
  await page.locator("[data-save]").click();
  await expect(page.locator("[data-view]").filter({ hasText: "Tagged memos" })).toHaveCount(1);

  await page.locator("#sidebar").getByRole("button", { name: "Tagged memos", exact: true }).click();
  await expect(page).toHaveURL(/\/\?view=\d+$/);
  await expect(page.locator("#memo-list article")).toHaveCount(1);
  await expect(page.locator("#memo-list article")).toContainText("View target");

  await page.goto("/views");
  for (const name of ["Tagged memos", "Pinned"]) {
    await page.locator("[data-view]").filter({ hasText: name }).locator("[data-view-menu]").click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page.locator("[data-action=dialog-ok]").click();
    await expect(page.locator("[data-view]").filter({ hasText: name })).toHaveCount(0);
  }
  await expect(page.getByText("No views yet")).toBeVisible();
});

test("refuses a view without a title", async ({ page }) => {
  await page.goto("/views");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.locator("#view-filter").fill("is:pinned");
  await page.locator("[data-save]").click();
  await expect(page.locator(".mu-toast-danger")).toContainText("Title and filter cannot be empty");
});

test("edits and deletes a view from its sidebar menu", async ({ page }) => {
  await page.goto("/views#new");
  await page.locator("#view-title").fill("Sidebar view");
  await page.locator("#view-filter").fill("is:pinned");
  await page.locator("[data-save]").click();
  await expect(page.locator("[data-view]")).toHaveCount(1);
  const id = await page.locator("[data-view]").getAttribute("data-view");

  await page.goto(`/?view=${id}`);
  const sidebar = page.locator("#sidebar");
  await expect(sidebar.getByRole("link", { name: "Manage" })).toHaveCount(0);
  await sidebar.getByRole("button", { name: "Edit Sidebar view" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await expect(page).toHaveURL(/\/views$/);
  await expect(page.locator("#view-title")).toHaveValue("Sidebar view");

  await page.goto(`/?view=${id}`);
  await sidebar.getByRole("button", { name: "Edit Sidebar view" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("Are you sure you want to delete view `Sidebar view`?");
  await page.locator("[data-action=dialog-ok]").click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator(".mu-toast")).toContainText("View `Sidebar view` deleted successfully");
  await expect(sidebar.getByRole("button", { name: "Sidebar view", exact: true })).toHaveCount(0);
});

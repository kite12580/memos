// Loaded on demand so it stays out of the first page's script budget.

import { $, $$, go, post, reload, strings } from "./dom";
import { closeLayer, openDialog, openTemplate } from "./popup";
import { formatTimes } from "./time";
import { toast, toastError } from "./toast";
import { layoutGrid } from "./list";
import { articleOf, cardOf, listParam, refreshCard } from "./cards";

async function cardAction(card: HTMLElement, path: string, body: unknown) {
  const uid = card.dataset.card!;
  try {
    const res = await post(`/memos/${uid}/${path}${listParam(card)}`, body);
    return await refreshCard(card, res);
  } catch (e) {
    toastError(e);
  }
}

function removeCard(card: HTMLElement) {
  card.remove();
  layoutGrid();
  void refreshChrome();
}

/** Brings the sidebar, the comment count and the list's empty state up to date with the server after a write. */
export async function refreshChrome() {
  const res = await fetch(location.href, { cache: "no-store" }).catch(() => null);
  if (!res?.ok) return;
  const doc = new DOMParser().parseFromString(await res.text(), "text/html");
  const aside = $("[data-sidebar-header]")?.parentElement;
  const nextAside = doc.querySelector("#sidebar aside");
  if (aside && nextAside) {
    const controls = () => $$("a[href], button, [tabindex]", aside);
    const focused = controls().indexOf(document.activeElement as HTMLElement);
    aside.replaceChildren(...nextAside.childNodes);
    formatTimes(aside);
    if (focused >= 0) controls()[focused]?.focus({ preventScroll: true });
  }
  const grid = doc.querySelector("[data-cells]");
  const cells = $("[data-cells]");
  if (grid && cells) {
    cells.replaceChildren(...grid.childNodes);
    document.dispatchEvent(new CustomEvent("memos:calendar"));
  }
  const head = doc.querySelector("[data-comments-head]");
  if (head) $("[data-comments-head]")?.replaceWith(head);
  const empty = doc.querySelector("#memo-list [data-empty]");
  if (empty && !$("#memo-list [data-card], #memo-list [data-empty]")) $("#memo-list [data-leading]")?.append(empty);
}

export async function pin(card: HTMLElement, on: boolean) {
  const inList = card.closest("#memo-list");
  await cardAction(card, "pin", { on });
  if (inList) reload();
}

export async function archive(card: HTMLElement, on: boolean) {
  const uid = card.dataset.card!;
  try {
    await post(`/memos/${uid}/archive`, { on });
    const done = on ? strings.archived : strings.restored;
    if (card.closest("#memo-list, [data-day-cards]")) {
      removeCard(card);
      toast(done);
    } else {
      sessionStorage.setItem("toast", done);
      go(`${document.body.dataset.base}/${on ? "archived" : ""}`);
    }
  } catch (e) {
    toastError(e);
  }
}

export function confirmDelete(card: HTMLElement) {
  openDialog("tpl-confirm", (root) => {
    $("[data-slot=title]", root)!.textContent = strings.deleteConfirm;
    $("[data-slot=description]", root)!.textContent = strings.deleteDescription;
    $("[data-slot=ok]", root)!.textContent = strings.delete;
    $("[data-action=dialog-ok]", root)!.addEventListener("click", async () => {
      closeLayer(root);
      try {
        await post(`/memos/${card.dataset.card}/delete`);
        toast(strings.deleted);
        if (card.closest("#memo-list, [data-comments], [data-day-cards]")) removeCard(card);
        else go(`${document.body.dataset.base}/`);
      } catch (e) {
        toastError(e);
      }
    });
  });
}

export async function react(card: HTMLElement, emoji: string) {
  await cardAction(card, "react", { emoji });
}

export async function setAllTasks(card: HTMLElement, checked: boolean) {
  if (await cardAction(card, "tasks", { checked })) toast(strings.tasksUpdated);
}

/** A tick in a read-only card: the server flips that task in the Markdown and the HTML. */
export async function toggleTask(input: HTMLInputElement) {
  const card = cardOf(input);
  if (!card) return;
  const root = input.closest(".memo-content-root")!;
  const index = $$<HTMLInputElement>("input.mbe-checkbox", root).indexOf(input);
  const label = input.getAttribute("aria-label") ?? input.closest(".mbe-block")?.textContent ?? "";
  const rev = Number(articleOf(card).dataset.rev);
  try {
    const res = await post(`/memos/${card.dataset.card}/task${listParam(card)}`, { i: index, label, rev });
    await refreshCard(card, res);
  } catch (e) {
    input.checked = !input.checked;
    toastError(e);
  }
}

/** The card's ⋯ menu, with the items that apply to this memo. */
export function openMemoMenu(trigger: HTMLElement) {
  const card = cardOf(trigger);
  if (!card) return;
  const article = articleOf(card);
  const comment = !!card.closest("[data-comments]");
  const flags: Record<string, boolean> = { comment, detail: !comment && !!$("[data-memo-comments-section]") };
  const state = (key: string) => flags[key] ?? article.hasAttribute(`data-${key}`);
  openTemplate(trigger, "tpl-memo-menu", "bottom", "end", (popup) => {
    popup.dataset.for = card.dataset.card;
    for (const item of $$("[data-if]", popup)) {
      const ok = item.dataset.if!.split(" ").every((c) => (c.startsWith("!") ? !state(c.slice(1)) : state(c)));
      if (!ok) item.remove();
    }
    const open = $<HTMLAnchorElement>("[data-href]", popup);
    if (open) open.href = `${document.body.dataset.base}/memos/${card.dataset.card}`;
  });
}


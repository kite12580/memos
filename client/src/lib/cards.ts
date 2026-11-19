import { $, $$, fromHTML, post, request, strings } from "./dom";
import { closeAll, closeDialog, openDialog, openTemplate } from "./popup";
import { formatTimes } from "./time";
import { toast, toastError } from "./toast";
import { layoutGrid } from "./list";

/** The card element (or its comment-strip wrapper) holding `el`. */
export const cardOf = (el: Element) => el.closest<HTMLElement>("[data-card]");
export const articleOf = (card: HTMLElement) => (card.tagName === "ARTICLE" ? card : card.querySelector<HTMLElement>("article")!);
export const uidOf = (el: Element) => cardOf(el)?.dataset.card ?? "";

/** Swaps a card for the server's new rendering of it. */
export function replaceCard(card: HTMLElement, html: string) {
  const next = fromHTML(html).firstElementChild as HTMLElement | null;
  if (!next) return card.remove();
  card.replaceWith(next);
  formatTimes(next);
  initClamps(next);
  return next;
}

export async function refreshCard(card: HTMLElement, res: Response) {
  const html = await res.text();
  return replaceCard(card, html);
}

export const listParam = (card: Element) => (card.closest("#memo-list") ? "?list=1" : "");

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
}

export async function pin(card: HTMLElement, on: boolean) {
  await cardAction(card, "pin", { on });
  if (card.closest("#memo-list")) location.reload();
}

export async function archive(card: HTMLElement, on: boolean) {
  const uid = card.dataset.card!;
  try {
    await post(`/memos/${uid}/archive`, { on });
    if (card.closest("#memo-list")) removeCard(card);
    else location.reload();
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
      closeDialog(root);
      try {
        await post(`/memos/${card.dataset.card}/delete`);
        toast(strings.deleted);
        if (card.closest("#memo-list, [data-comments]")) removeCard(card);
        else location.href = `${document.body.dataset.base}/`;
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
  await cardAction(card, "tasks", { checked });
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

export async function copyLink(card: HTMLElement) {
  await navigator.clipboard.writeText(`${location.origin}${document.body.dataset.base}/memos/${card.dataset.card}`);
  toast(strings.linkCopied);
}

export async function copyContent(card: HTMLElement) {
  const res = await request(`/f/memos/${card.dataset.card}/source`);
  await navigator.clipboard.writeText((await res.json()).content);
  toast(strings.contentCopied);
}

/** The card's ⋯ menu, with the items that apply to this memo. */
export function openMemoMenu(trigger: HTMLElement) {
  const card = cardOf(trigger);
  if (!card) return;
  const article = articleOf(card);
  const state = (key: string) => article.hasAttribute(`data-${key}`);
  openTemplate(trigger, "tpl-memo-menu", "bottom", "end", (popup) => {
    popup.dataset.card = card.dataset.card;
    for (const item of $$("[data-if]", popup)) {
      const ok = item.dataset.if!.split(" ").every((c) => (c.startsWith("!") ? !state(c.slice(1)) : state(c)));
      if (!ok) item.remove();
    }
    const open = $<HTMLAnchorElement>("[data-href]", popup);
    if (open) open.href = `${document.body.dataset.base}/memos/${card.dataset.card}`;
  });
}

/** Folds memos taller than memos' 420px trigger behind "Show more", measured now that the browser laid them out. */
export function initClamps(root: ParentNode = document) {
  for (const section of $$("[data-clamp]", root)) {
    const inner = section.firstElementChild as HTMLElement | null;
    if (!inner || section.dataset.expanded) continue;
    const tall = inner.offsetHeight > 420;
    const button = section.parentElement?.querySelector<HTMLButtonElement>(":scope > [data-action=clamp]");
    section.classList.toggle("overflow-hidden", tall);
    section.classList.toggle("max-h-[360px]", tall);
    section.querySelector("[data-fade]")?.toggleAttribute("hidden", !tall);
    if (tall && !button) {
      section.insertAdjacentHTML("afterend", clampButton(false));
      if (!section.querySelector("[data-fade]")) section.insertAdjacentHTML("beforeend", FADE);
    } else if (!tall) {
      button?.remove();
    }
  }
}

const FADE =
  '<div class="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-linear-to-t from-mu-surface from-0% via-mu-surface/60 via-40% to-transparent to-100%" data-fade=""></div>';

const clampButton = (expanded: boolean) =>
  `<button type="button" aria-expanded="${expanded}" data-action="clamp" class="mu-button mu-button-ghost mu-base mu-s-sm mu-focus"><span class="mu-button-label">${expanded ? strings.showLess : strings.showMore}</span><svg class="lucide lucide-chevron-${expanded ? "up" : "down"}" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="${document.body.dataset.sprite}#i-chevron-${expanded ? "up" : "down"}"/></svg></button>`;

export function toggleClamp(button: HTMLElement) {
  const section = button.previousElementSibling as HTMLElement;
  const expanded = button.getAttribute("aria-expanded") !== "true";
  section.dataset.expanded = expanded ? "1" : "";
  section.classList.toggle("overflow-hidden", !expanded);
  section.classList.toggle("max-h-[360px]", !expanded);
  section.querySelector("[data-fade]")?.toggleAttribute("hidden", expanded);
  button.outerHTML = clampButton(expanded);
  closeAll();
}

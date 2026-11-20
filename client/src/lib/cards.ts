import { $, $$, fromHTML, request, strings } from "./dom";
import { closeAll } from "./popup";
import { formatTimes } from "./time";
import { toast } from "./toast";

/** The card element (or its comment-strip wrapper) holding `el`. */
export const cardOf = (el: Element) => el.closest<HTMLElement>("[data-card]");
export const articleOf = (card: HTMLElement) => (card.tagName === "ARTICLE" ? card : card.querySelector<HTMLElement>("article")!);
export const uidOf = (el: Element) => cardOf(el)?.dataset.card ?? "";

const FOCUSABLE = "[data-popup], [data-action], input.mbe-checkbox";

export const fresh = new Set<string>();

export function markFresh(root: ParentNode = document) {
  for (const uid of fresh) {
    const meta = $(`[data-card="${uid}"] [data-slot=memo-header-meta]`, root);
    if (!meta || meta.nextElementSibling?.matches("[data-new]")) continue;
    meta.insertAdjacentHTML("afterend", `<span class="mu-badge mu-badge-primary mu-base mu-s-xs mu-caption-xs mu-badge-xs shrink-0" data-new=""><span class="mu-badge-label"></span></span>`);
    meta.nextElementSibling!.firstElementChild!.textContent = strings.newBadge;
  }
}

export function replaceCard(card: HTMLElement, html: string) {
  const next = fromHTML(html).firstElementChild as HTMLElement | null;
  if (!next) return card.remove();
  const active = document.activeElement?.closest(FOCUSABLE);
  const at = active && card.contains(active) ? $$(FOCUSABLE, card).indexOf(active as HTMLElement) : -1;
  card.replaceWith(next);
  formatTimes(next);
  initClamps(next);
  markFresh(next.parentElement ?? document);
  if (at >= 0) $$(FOCUSABLE, next)[at]?.focus({ preventScroll: true });
  return next;
}

export async function refreshCard(card: HTMLElement, res: Response) {
  const html = await res.text();
  return replaceCard(card, html);
}

export const listParam = (card: Element) => (card.closest("#memo-list") ? "?list=1" : "");

export async function copyLink(card: HTMLElement) {
  const parent = card.closest("[data-comments]") && location.pathname.split("/").pop();
  const path = parent ? `${parent}#${card.dataset.card}` : card.dataset.card;
  await navigator.clipboard.writeText(`${location.origin}${document.body.dataset.base}/memos/${path}`);
  toast(strings.linkCopied);
}

export async function copyContent(card: HTMLElement) {
  const text = request(`/f/memos/${card.dataset.card}/source`)
    .then((res) => res.json())
    .then((memo) => new Blob([memo.content], { type: "text/plain" }));
  await navigator.clipboard.write([new ClipboardItem({ "text/plain": text })]);
  toast(strings.contentCopied);
}

const clampObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    clampObserver.unobserve(entry.target);
    measureClamp(entry.target as HTMLElement);
  }
});

/**
 * Folds memos taller than memos' 420px trigger behind "Show more". Cards in the
 * list skip layout until they near the screen (`content-visibility: auto`), so
 * each is measured when it first comes into view.
 */
export function initClamps(root: ParentNode = document) {
  for (const section of $$("[data-clamp]", root)) clampObserver.observe(section);
}

function measureClamp(section: HTMLElement) {
  const inner = section.firstElementChild as HTMLElement | null;
  if (!inner || section.dataset.expanded) return;
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
  const focused = document.activeElement === button;
  button.outerHTML = clampButton(expanded);
  if (focused) section.parentElement?.querySelector<HTMLElement>(":scope > [data-action=clamp]")?.focus();
  closeAll();
}

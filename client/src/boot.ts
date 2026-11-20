// The one script every page loads. It wires behavior to the server's HTML
// through `data-action` and `data-popup` attributes and never builds cards;
// the editor and the emoji picker load on first use.

import { $, $$, go, idle, post } from "./lib/dom";
import { formatTimes } from "./lib/time";
import { closeAll, closeLayer, closeFor, initPopups, isOpenFor, openTemplate } from "./lib/popup";
import * as cards from "./lib/cards";
import { initList } from "./lib/list";
import { toast, toastError } from "./lib/toast";

declare const RENDER_VERSION: string;

const editor = () => import("./editor/index");
const ui = () => import("./ui");
const actions = () => import("./lib/actions");

async function onAction(el: HTMLElement, e: MouseEvent) {
  const action = el.dataset.action!;
  const inPopup = el.closest<HTMLElement>(".mu-positioner");
  const card = inPopup ? currentCard : cards.cardOf(el);
  switch (action) {
    case "pref":
      if (el.closest(".mu-select-popup")) closeLayer(el);
      return (await ui()).setPref(el.dataset.key!, el.dataset.value!);
    case "drawer":
      return (await ui()).openDrawer();
    case "month":
      return (await ui()).showMonth(el);
    case "clamp":
      return cards.toggleClamp(el);
    case "preview":
      return (await ui()).preview(el);
    case "audio":
      return (await ui()).playAudio(el);
    case "dialog-cancel":
      return closeLayer(el);
    case "unblur":
      el.closest("[data-slot=memo-body]")?.firstElementChild?.classList.remove("blur-lg");
      return el.parentElement!.remove();
    case "new-memo":
      e.preventDefault();
      return (await editor()).openGlobal();
    case "write-comment":
      return (await editor()).openComment();
    case "edit-detail": {
      const main = $<HTMLElement>(`main [data-card="${el.closest<HTMLElement>("[data-for]")?.dataset.for}"]`);
      return main && (await editor()).editCard(main);
    }
  }
  if (!card) return;
  closeAll();
  switch (action) {
    case "edit":
      return (await editor()).editCard(card);
    case "pin":
      return (await actions()).pin(card, el.dataset.value === "1");
    case "archive":
      return (await actions()).archive(card, el.dataset.value === "1");
    case "delete":
      return (await actions()).confirmDelete(card);
    case "tasks":
      return (await actions()).setAllTasks(card, el.dataset.value === "1");
    case "copy-link":
      return cards.copyLink(card).catch(toastError);
    case "copy-content":
      return cards.copyContent(card).catch(toastError);
    case "react":
      return (await actions()).react(card, el.dataset.emoji!);
  }
}

/** The card whose popup is open, for actions taken inside that popup. */
let currentCard: HTMLElement | null = null;

function onPopup(trigger: HTMLElement) {
  if (isOpenFor(trigger)) return closeAll();
  const kind = trigger.dataset.popup!;
  currentCard = cards.cardOf(trigger);
  switch (kind) {
    case "memo-menu":
      return actions().then((a) => a.openMemoMenu(trigger));
    case "brand":
      return openTemplate(trigger, "tpl-brand", "bottom", "start");
    case "display":
      return ui().then((u) => openTemplate(trigger, "tpl-display", "bottom", "start", (p) => requestAnimationFrame(() => u.keySegmented($("[data-segmented]", p)!)), trigger.parentElement!));
    case "tags-menu":
      return openTemplate(trigger, "tpl-tags-menu", "bottom", "end");
    case "view-menu":
      return ui().then((u) => u.openViewMenu(trigger));
    case "search":
      return ui().then((u) => u.openSearch());
    case "reactions": {
      const card = currentCard;
      return import("./reactions").then((r) =>
        r.openPicker(
          trigger,
          card ? $$<HTMLElement>("[data-action=react]", card).map((b) => b.dataset.emoji!) : [],
          (emoji) => card && actions().then((a) => a.react(card, emoji)),
        ),
      );
    }
    case "insert-menu":
      return editor().then((m) => m.openInsertMenu(trigger));
    case "share":
      currentCard = $<HTMLElement>(`main [data-card="${trigger.closest<HTMLElement>("[data-for]")?.dataset.for}"]`);
      return openTemplate(trigger, "tpl-copy-menu", "bottom", "start");
  }
}

document.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (target.matches(".mu-dialog-backdrop, .mu-dialog-viewport")) return void (target.parentElement?.querySelector("[role=alertdialog]") || closeLayer(target));
  const checkbox = target.closest<HTMLInputElement>(".memo-content-root input.mbe-checkbox");
  if (checkbox) return void actions().then((a) => a.toggleTask(checkbox));
  const copy = target.closest<HTMLElement>(".memo-content-root .mbe-code-copy");
  if (copy) return void ui().then((u) => u.copyCode(copy));
  const note = target.closest<HTMLElement>(".memo-content-root :is(.mbe-footnote-ref, .mbe-footnote-backref)");
  if (note) return void ui().then((u) => u.footnote(note));
  const tag = target.closest<HTMLElement>(".memo-content-root [data-tag][role=button]");
  if (tag) return void ui().then((u) => go(u.tagHref(tag.dataset.tag!)));
  const sub = target.closest<HTMLElement>("[data-submenu]");
  if (sub) {
    if (!isOpenFor(sub)) openTemplate(sub, sub.dataset.submenu!, "inline-end", "start");
    if (e.detail) sub.focus({ preventScroll: true });
    return;
  }
  const select = target.closest<HTMLElement>("[data-select]");
  if (select) return isOpenFor(select) ? closeFor(select) : void ui().then((u) => u.openSelect(select));
  const popup = target.closest<HTMLElement>("[data-popup]");
  if (popup) return void onPopup(popup);
  const action = target.closest<HTMLElement>("[data-action]");
  if (action) void onAction(action, e);
});

document.addEventListener("pointerover", (e) => {
  const sub = (e.target as HTMLElement).closest<HTMLElement>("[data-submenu]");
  if (sub && matchMedia("(pointer: fine)").matches && !isOpenFor(sub)) {
    openTemplate(sub, sub.dataset.submenu!, "inline-end", "start");
    sub.focus({ preventScroll: true });
  }
});

// Typing in the server-rendered composer works at once; the editor takes over its text when it loads.
for (const type of ["pointerdown", "focusin", "pointerover"]) {
  document.addEventListener(type, (e) => {
    const target = e.target as HTMLElement;
    const live = target.closest<HTMLElement>("[data-live]");
    if (live) return void import("./live").then((m) => m.bind(live, e));
    const composer = target.closest<HTMLElement>("[data-composer]");
    if (composer && !composer.dataset.ready && type != "pointerover") editor().then((m) => m.activate(composer));
  });
}

document.addEventListener("keydown", (e) => {
  const target = e.target as HTMLElement;
  if ((e.metaKey || e.ctrlKey) && e.key === "k" && !target.closest("[contenteditable=true]")) {
    e.preventDefault();
    void ui().then((u) => u.openSearch());
  }
  const group = target.matches(".mu-toggle") && target.closest<HTMLElement>(".mu-toggle-group");
  if (group && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
    const all = $$<HTMLElement>(".mu-toggle", group);
    const back = e.key === (document.documentElement.dir === "rtl" ? "ArrowRight" : "ArrowLeft");
    const at = all.indexOf(target);
    const next = e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : (at + (back ? all.length - 1 : 1)) % all.length;
    all[next]?.focus();
    e.preventDefault();
    return;
  }
  if ((e.key === "ArrowDown" || e.key === "ArrowUp") && target.matches("[data-select], [data-popup][aria-haspopup=menu]") && !isOpenFor(target)) {
    e.preventDefault();
    e.stopImmediatePropagation();
    target.click();
    return;
  }
  if ((e.key === "Enter" || e.key === " ") && target.matches("[role=button], [role=switch], [role=checkbox]")) {
    e.preventDefault();
    target.click();
  }
});

/** Memos whose HTML this build would render differently get rendered again, a few at a time, when the phone is idle. */
function renderStale() {
  const stale = $$("[data-stale]");
  if (stale.length) idle(() => import("./editor/render").then((r) => r.refreshStale(stale, RENDER_VERSION)));
}

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
if (tz && !document.cookie.includes(`tz=${encodeURIComponent(tz)}`)) post("/prefs", { key: "tz", value: tz }).catch(toastError);

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
  const html = document.documentElement;
  if (html.dataset.system === undefined) return;
  html.setAttribute("data-theme", e.matches ? "dark" : "light");
});

initPopups();
idle(() => void import("./lib/tooltip").then((m) => m.initTooltips()));
document.addEventListener("memos:cards", renderStale);

const pages: Record<string, () => Promise<{ default: (signal: AbortSignal) => void }>> = {
  calendar: () => import("./pages/calendar"),
  attachments: () => import("./pages/attachments"),
  views: () => import("./pages/views"),
  settings: () => import("./pages/settings"),
};

const TREE = "memos-lite-tag-tree";

function initTagTree() {
  const tree = $("[data-tag-tree]");
  if (!tree) return;
  const state: { expanded: string[]; revealedFor?: string } = JSON.parse(localStorage.getItem(TREE) || '{"expanded":[]}');
  const save = () => localStorage.setItem(TREE, JSON.stringify(state));
  const active = $("[data-checked]", tree)?.closest<HTMLElement>("[data-path]")?.dataset.path;
  if (active !== state.revealedFor) {
    const parts = active?.split("/") ?? [];
    for (let i = 1; i < parts.length; i++) {
      const path = parts.slice(0, i).join("/");
      if (!state.expanded.includes(path)) state.expanded.push(path);
    }
    state.revealedFor = active;
    save();
  }
  const apply = () => {
    for (const item of $$("[data-path]", tree)) {
      const group = item.lastElementChild as HTMLElement;
      if (group.getAttribute("role") !== "group") continue;
      const open = state.expanded.includes(item.dataset.path!);
      group.hidden = !open;
      item.firstElementChild!.setAttribute("aria-expanded", String(open));
      const toggle = $("[data-toggle]", item)!;
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", `${open ? tree.dataset.collapse : tree.dataset.expand} ${toggle.dataset.name}`);
      const chevron = $(".lucide-chevron-right", toggle)!;
      chevron.classList.toggle("rotate-90", open);
      chevron.classList.toggle("rtl:rotate-180", !open);
    }
  };
  apply();
  tree.onclick = (e) => {
    const toggle = (e.target as HTMLElement).closest<HTMLElement>("[data-toggle]");
    if (!toggle) return;
    const path = toggle.closest<HTMLElement>("[data-path]")!.dataset.path!;
    state.expanded = state.expanded.includes(path) ? state.expanded.filter((p) => p !== path) : [...state.expanded, path];
    save();
    apply();
  };
}

let leave = new AbortController();
let first = true;

/** Wires the page in `<main>`: on load, and again each time the navigator swaps in another. */
function initPage() {
  leave.abort();
  leave = new AbortController();
  const { signal } = leave;
  formatTimes();
  cards.initClamps();
  cards.markFresh();
  initTagTree();
  initList(signal);
  if ($("[data-resize]")) void ui().then((u) => u.initResize());
  if ($("[data-highlight]")) void ui().then((u) => u.highlight(signal));
  renderStale();
  const composer = $("[data-composer=create]");
  const autofocus = location.hash === "#compose" || (first && location.pathname === `${document.body.dataset.base}/` && matchMedia("(min-width: 768px)").matches && document.activeElement === document.body);
  first = false;
  if (composer && autofocus) $("[contenteditable]", composer)?.focus();
  else if (composer && localStorage.getItem("memos-lite-draft")?.trim()) void editor().then((m) => m.activate(composer, false));
  const flash = sessionStorage.getItem("toast");
  if (flash) {
    sessionStorage.removeItem("toast");
    toast(flash);
  }
  const page = $("[data-page]")?.dataset.page;
  if (page) void pages[page]?.().then((m) => signal.aborted || m.default(signal));
}

initPage();
document.addEventListener("memos:page", initPage);
document.addEventListener("memos:sidebar", initTagTree);
void import("./nav");
idle(() => void ui());

// The one script every page loads. It wires behavior to the server's HTML
// through `data-action` and `data-popup` attributes and never builds cards;
// the editor and the emoji picker load on first use.

import { $, $$, fromHTML, idle, post, request } from "./lib/dom";
import { formatTimes } from "./lib/time";
import { closeAll, closeDialog, initPopups, isOpenFor, openDialog, openPopup, openTemplate } from "./lib/popup";
import * as cards from "./lib/cards";
import { initList } from "./lib/list";
import { toastError } from "./lib/toast";

declare const RENDER_VERSION: string;

const editor = () => import("./editor/index");

async function setPref(key: string, value: string, reload = true) {
  try {
    await post("/prefs", { key, value });
    if (reload) location.reload();
  } catch (e) {
    toastError(e);
  }
}

function openSelect(trigger: HTMLElement) {
  const options = trigger.parentElement?.querySelector<HTMLTemplateElement>("template[data-options]");
  if (!options) return;
  const popup = document.createElement("div");
  popup.className = "mu-select-popup mu-popup mu-popup-motion mu-base mu-s-md";
  popup.style.minWidth = `${trigger.offsetWidth}px`;
  const listbox = document.createElement("div");
  listbox.className = "mu-select-list";
  listbox.setAttribute("role", "listbox");
  for (const opt of options.content.children as HTMLCollectionOf<HTMLElement>) {
    const selected = opt.hasAttribute("data-selected");
    const item = document.createElement("div");
    item.className = "mu-select-item";
    item.setAttribute("role", "option");
    item.tabIndex = -1;
    item.setAttribute("aria-selected", String(selected));
    if (selected) item.setAttribute("data-selected", "");
    Object.assign(item.dataset, opt.dataset);
    item.innerHTML = `<div class="mu-select-item-text"></div><span class="mu-select-indicator">${selected ? '<svg class="lucide lucide-check" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="${document.body.dataset.sprite}#i-check"/></svg>' : ""}</span>`;
    item.firstElementChild!.textContent = opt.textContent;
    listbox.append(item);
  }
  popup.append(listbox);
  openPopup(trigger, popup, "bottom", "start");
}

function openSearch() {
  openDialog("tpl-search", (root) => {
    const input = $<HTMLInputElement>("input[name=q]", root)!;
    input.value = new URLSearchParams(location.search).get("q") ?? "";
    root.addEventListener("click", (e) => {
      const hint = (e.target as HTMLElement).closest<HTMLElement>("[data-action=search-hint]");
      if (!hint) return;
      const v = hint.dataset.value!;
      input.value = `${input.value.trimEnd()}${input.value.trim() ? " " : ""}${v}`;
      input.focus();
    });
  });
}

function openDrawer() {
  const sidebar = $("#sidebar")!;
  const backdrop = document.createElement("div");
  backdrop.className = "mu-dialog-backdrop md:hidden";
  backdrop.dataset.open = "";
  const close = () => {
    sidebar.classList.add("max-md:hidden");
    sidebar.classList.remove("shadow-lg");
    backdrop.remove();
  };
  backdrop.addEventListener("click", close);
  sidebar.before(backdrop);
  sidebar.classList.remove("max-md:hidden");
  sidebar.classList.add("shadow-lg");
}

async function showMonth(month: string) {
  const section = $("#sidebar-stats");
  if (!section) return;
  try {
    const res = await request(`/f/month?m=${month}`);
    section.replaceChildren(fromHTML(await res.text()));
    formatTimes(section);
  } catch (e) {
    toastError(e);
  }
}

function preview(el: HTMLElement) {
  const src = el.dataset.src!;
  if (el.hasAttribute("data-video")) {
    window.open(src, "_blank");
    return;
  }
  const overlay = document.createElement("div");
  overlay.className = "fixed inset-0 z-50 flex items-center justify-center bg-black/92 cursor-zoom-out";
  overlay.innerHTML = '<img class="max-h-[calc(100dvh-8rem)] max-w-[calc(100vw-1.5rem)] rounded-mu-md object-contain select-none sm:max-h-[calc(100dvh-7rem)] sm:max-w-[calc(100vw-8rem)]" alt="">';
  overlay.querySelector("img")!.src = src;
  const close = () => overlay.remove();
  overlay.addEventListener("click", close);
  addEventListener("keydown", (e) => e.key === "Escape" && close(), { once: true });
  document.body.append(overlay);
}

function playAudio(button: HTMLElement) {
  const row = button.closest<HTMLElement>("[data-audio]")!;
  let audio = row.querySelector("audio");
  if (!audio) {
    audio = document.createElement("audio");
    audio.src = row.dataset.audio!;
    audio.preload = "none";
    audio.hidden = true;
    row.append(audio);
    audio.addEventListener("ended", () => setIcon("play"));
  }
  const setIcon = (name: string) => button.querySelector("use")?.setAttribute("href", `${document.body.dataset.sprite}#i-${name}`);
  if (audio.paused) {
    audio.play();
    setIcon("pause");
  } else {
    audio.pause();
    setIcon("play");
  }
}

async function onAction(el: HTMLElement, e: MouseEvent) {
  const action = el.dataset.action!;
  const inPopup = el.closest<HTMLElement>(".mu-positioner");
  const card = inPopup ? currentCard : cards.cardOf(el);
  switch (action) {
    case "pref":
      return setPref(el.dataset.key!, el.dataset.value!);
    case "drawer":
      return openDrawer();
    case "month":
      return showMonth(el.dataset.month!);
    case "clamp":
      return cards.toggleClamp(el);
    case "preview":
      return preview(el);
    case "audio":
      return playAudio(el);
    case "dialog-cancel":
      return closeDialog(el);
    case "new-memo": {
      const composer = $("[data-composer=create]");
      if (!composer) return;
      e.preventDefault();
      composer.scrollIntoView({ block: "center" });
      return (await editor()).activate(composer);
    }
    case "write-comment": {
      const holder = $("[data-comment-composer]")!;
      holder.hidden = false;
      holder.scrollIntoView({ block: "center" });
      return (await editor()).activate($("[data-composer]", holder)!);
    }
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
      return cards.pin(card, el.dataset.value === "1");
    case "archive":
      return cards.archive(card, el.dataset.value === "1");
    case "delete":
      return cards.confirmDelete(card);
    case "tasks":
      return cards.setAllTasks(card, el.dataset.value === "1");
    case "copy-link":
      return cards.copyLink(card).catch(toastError);
    case "copy-content":
      return cards.copyContent(card).catch(toastError);
    case "react":
      return cards.react(card, el.dataset.emoji!);
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
      return cards.openMemoMenu(trigger);
    case "brand":
      return openTemplate(trigger, "tpl-brand", "bottom", "start");
    case "display":
      return openTemplate(trigger, "tpl-display", "bottom", "start");
    case "tags-menu":
      return openTemplate(trigger, "tpl-tags-menu", "bottom", "end");
    case "search":
      return openSearch();
    case "reactions":
      return import("./reactions").then((r) => r.openPicker(trigger, (emoji) => currentCard && cards.react(currentCard, emoji)));
    case "insert-menu":
      return editor().then((m) => m.openInsertMenu(trigger));
    case "share":
      currentCard = $<HTMLElement>(`main [data-card="${trigger.closest<HTMLElement>("[data-for]")?.dataset.for}"]`);
      return openTemplate(trigger, "tpl-copy-menu", "bottom", "start");
  }
}

document.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (target.matches(".mu-dialog-backdrop, .mu-dialog-viewport")) return closeDialog(target);
  const checkbox = target.closest<HTMLInputElement>(".memo-content-root input.mbe-checkbox");
  if (checkbox) return void cards.toggleTask(checkbox);
  const sub = target.closest<HTMLElement>("[data-submenu]");
  if (sub) return void openTemplate(sub, sub.dataset.submenu!, "inline-end", "start");
  const select = target.closest<HTMLElement>("[data-select]");
  if (select) return openSelect(select);
  const popup = target.closest<HTMLElement>("[data-popup]");
  if (popup) return void onPopup(popup);
  const action = target.closest<HTMLElement>("[data-action]");
  if (action) void onAction(action, e);
});

document.addEventListener("pointerover", (e) => {
  const sub = (e.target as HTMLElement).closest<HTMLElement>("[data-submenu]");
  if (sub && matchMedia("(pointer: fine)").matches && !isOpenFor(sub)) openTemplate(sub, sub.dataset.submenu!, "inline-end", "start");
});

// Typing in the server-rendered composer works at once; the editor takes over its text when it loads.
for (const type of ["pointerdown", "focusin"]) {
  document.addEventListener(type, (e) => {
    const composer = (e.target as HTMLElement).closest<HTMLElement>("[data-composer]");
    if (composer && !composer.dataset.ready) editor().then((m) => m.activate(composer));
  });
}

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "k") {
    e.preventDefault();
    openSearch();
  }
});

function initResize() {
  const handle = $("[data-resize=sidebar]");
  if (!handle) return;
  handle.addEventListener("pointerdown", (e) => {
    const root = handle.closest<HTMLElement>("[style*=--app-sidebar-width]")!;
    handle.setPointerCapture(e.pointerId);
    let width = 0;
    const move = (ev: PointerEvent) => {
      width = Math.round(Math.min(400, Math.max(224, ev.clientX)));
      root.style.setProperty("--app-sidebar-width", `${width}px`);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      if (width) setPref("sw", String(width), false);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up, { once: true });
  });
}

/** Memos whose HTML this build would render differently get rendered again, a few at a time, when the phone is idle. */
function renderStale() {
  const stale = $$("[data-stale]");
  if (stale.length) idle(() => import("./editor/render").then((r) => r.refreshStale(stale, RENDER_VERSION)));
}

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
if (tz && !document.cookie.includes(`tz=${encodeURIComponent(tz)}`)) void setPref("tz", tz, false);

initPopups();
formatTimes();
cards.initClamps();
initList();
initResize();
renderStale();
document.addEventListener("memos:cards", renderStale);
if (location.hash === "#compose") $("[data-composer=create] [contenteditable]")?.focus();

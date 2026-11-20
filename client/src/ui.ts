// Loaded on demand so it stays out of the first page's script budget.

import { $, $$, fromHTML, post, reload as softReload, request, strings } from "./lib/dom";
import { formatTimes } from "./lib/time";
import { enter, openDialog, openPopup, restore, snapshot } from "./lib/popup";
import { toastError } from "./lib/toast";
import { icon } from "./lib/icon";

export async function setPref(key: string, value: string, reload = true) {
  try {
    await post("/prefs", { key, value });
    if (!reload) return;
    if (key === "lang") return location.reload();
    const state = snapshot();
    await softReload();
    await restore(state);
  } catch (e) {
    toastError(e);
  }
}

export function openSelect(trigger: HTMLElement) {
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
    item.innerHTML = `<div class="mu-select-item-text"></div><span class="mu-select-indicator">${selected ? icon("check", "") : ""}</span>`;
    item.firstElementChild!.textContent = opt.textContent;
    listbox.append(item);
  }
  popup.append(listbox);
  openPopup(trigger, popup, "bottom", "start");
}

/** Slides a segmented control's key under its pressed button, as the package's toggle group does. */
export function keySegmented(group: HTMLElement) {
  const pressed = $<HTMLElement>("[data-pressed]", group);
  if (!pressed) return;
  group.style.setProperty("--key-left", `${pressed.offsetLeft}px`);
  group.style.setProperty("--key-width", `${pressed.offsetWidth}px`);
}

const TERMS = /-?"[^"]*"|\S+/g;
const FILTER = /^-?(#|is:|has:|before:|after:|on:)/;

/** memos' search dialog: Text searches the words, Expression reads the search syntax. */
export function openSearch() {
  const root = openDialog("tpl-search", (root) => {
    const input = $<HTMLInputElement>("input[name=q]", root)!;
    const group = $("[data-segmented]", root)!;
    const hints = $("[data-search-hints]", root)!;
    const split = (q: string) => {
      const terms = q.match(TERMS) ?? [];
      return {
        filters: terms.filter((t) => FILTER.test(t)),
        words: terms.filter((t) => !FILTER.test(t)).map((t) => t.replace(/^(-?)"(.*)"$/, "$1$2")),
      };
    };
    const quote = (words: string) => (words.match(TERMS) ?? []).map((w) => (w.startsWith('"') ? w : `"${w.replaceAll('"', "")}"`));
    let { filters } = split(new URLSearchParams(location.search).get("q") ?? "");
    let mode = localStorage.getItem("memos-lite-search") ?? "text";
    const setMode = (m: string) => {
      if (m === "text" && mode !== "text") {
        const parts = split(input.value);
        filters = parts.filters;
        input.value = parts.words.join(" ");
      } else if (m === "expression" && mode === "text") {
        input.value = [...filters, ...quote(input.value)].join(" ");
      }
      mode = m;
      localStorage.setItem("memos-lite-search", m);
      for (const b of $$<HTMLElement>("[data-mode]", group)) {
        b.toggleAttribute("data-pressed", b.dataset.mode === m);
        b.setAttribute("aria-pressed", String(b.dataset.mode === m));
      }
      hints.hidden = m !== "expression";
      requestAnimationFrame(() => keySegmented(group));
    };
    if (mode === "text") input.value = split(input.value).words.join(" ");
    setMode(mode);
    root.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const m = target.closest<HTMLElement>("[data-mode]");
      if (m) return setMode(m.dataset.mode!);
      const hint = target.closest<HTMLElement>("[data-action=search-hint]");
      if (!hint) return;
      input.value = `${input.value.trimEnd()}${input.value.trim() ? " " : ""}${hint.dataset.value}`;
      input.focus();
    });
    $("form", root)!.addEventListener("submit", () => {
      if (mode === "text") input.value = [...filters, ...quote(input.value)].join(" ");
    });
  });
  const input = root && $<HTMLInputElement>("input[name=q]", root);
  input?.setSelectionRange(input.value.length, input.value.length);
}

/** On phones the sidebar opens in memos' left drawer. */
export function openDrawer() {
  const sidebar = $("#sidebar")!;
  const aside = $("aside", sidebar)!;
  const root = document.createElement("div");
  root.innerHTML =
    '<div class="mu-drawer-backdrop" role="presentation"></div><div class="mu-drawer-viewport mu-drawer-left" role="presentation"><div role="dialog" class="mu-drawer-popup mu-drawer-bare mu-base mu-s-md w-72 max-w-[calc(100%-2rem)]"><div class="mu-drawer-content"></div></div></div>';
  const backdrop = root.firstElementChild as HTMLElement;
  const viewport = root.lastElementChild as HTMLElement;
  const popup = viewport.firstElementChild as HTMLElement;
  popup.firstElementChild!.append(aside);
  document.body.append(root);
  document.body.style.overflow = "hidden";
  enter(backdrop);
  enter(popup);
  const opener = document.activeElement as HTMLElement | null;
  popup.tabIndex = -1;
  popup.focus();
  const close = () => {
    sidebar.prepend(aside);
    root.remove();
    document.body.style.overflow = "";
    removeEventListener("keydown", onKey);
    const back = $<HTMLElement>("[data-action=drawer]");
    (opener?.isConnected ? opener : back)?.focus({ preventScroll: true });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") return close();
    if (e.key !== "Tab") return;
    const all = $$<HTMLElement>("a[href], button:not([disabled]), [tabindex]:not([tabindex='-1'])", popup).filter((el) => el.getClientRects().length);
    const at = all.indexOf(document.activeElement as HTMLElement);
    const next = e.shiftKey ? (at <= 0 ? all.at(-1) : undefined) : at === -1 || at === all.length - 1 ? all[0] : undefined;
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };
  addEventListener("keydown", onKey);
  viewport.addEventListener("click", (e) => {
    if (e.target === viewport || (e.target as HTMLElement).closest("a[href]")) close();
  });
}

let wantedMonth = "";
let monthRequest = 0;

const addMonth = (key: string, step: number) => {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y, m - 1 + step, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

export async function showMonth(button: HTMLElement) {
  const section = $("#sidebar-stats");
  if (!section) return;
  const shown = $("time[data-fmt=month]", section)?.getAttribute("datetime") ?? button.dataset.month!;
  const month = addMonth(wantedMonth || shown, button.dataset.month! < shown ? -1 : 1);
  wantedMonth = month;
  const current = ++monthRequest;
  const focused = $$("[data-action=month]", section).indexOf(document.activeElement as HTMLElement);
  const params = new URLSearchParams(location.search);
  const query = new URLSearchParams({ m: month });
  for (const key of ["q", "view"]) if (params.get(key)) query.set(key, params.get(key)!);
  if (location.pathname.endsWith("/archived")) query.set("scope", "archived");
  try {
    const res = await request(`/f/month?${query}`);
    const html = await res.text();
    if (current !== monthRequest) return;
    wantedMonth = "";
    section.replaceChildren(fromHTML(html));
    formatTimes(section);
    if (focused >= 0) $$("[data-action=month]", section)[focused]?.focus();
  } catch (e) {
    if (current === monthRequest) wantedMonth = "";
    toastError(e);
  }
}

export const preview = (el: HTMLElement) => import("./preview").then((m) => m.openPreview(el));

const COPIED_ICON =
  '<svg class="mbe-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M20 6 9 17l-5-5"></path></svg>';

export async function copyCode(button: HTMLElement) {
  const text = button.closest(".mbe-code")?.querySelector("code")?.textContent;
  if (text == null) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    return toastError(e);
  }
  const label = button.getAttribute("aria-label") ?? "";
  const original = button.innerHTML;
  button.innerHTML = COPIED_ICON;
  button.setAttribute("aria-label", strings.copied);
  button.title = strings.copied;
  button.classList.add("mbe-copied");
  setTimeout(() => {
    button.innerHTML = original;
    button.setAttribute("aria-label", label);
    button.title = label;
    button.classList.remove("mbe-copied");
  }, 1500);
}

export function footnote(el: HTMLElement) {
  const root = el.closest(".memo-content-root")!;
  const label = el.dataset.label;
  const inList = (n: Element) => n.closest(".mbe-footnotes") !== null;
  let target: Element | undefined;
  if (el.matches(".mbe-footnote-ref")) {
    const notes = $$(".mbe-footnote", root).filter((n) => n.dataset.label === label);
    target = notes.find(inList) ?? notes[0];
  } else {
    target = $$(".mbe-footnote-ref", root).filter((n) => n.dataset.label === label && !inList(n))[Number(el.dataset.ref) - 1];
  }
  target?.scrollIntoView({ block: "center", behavior: "smooth" });
}

export function tagHref(tag: string) {
  const base = document.body.dataset.base ?? "";
  const inList = location.pathname === `${base}/` || location.pathname === `${base}/archived`;
  if (!inList) return `${base}/?q=${encodeURIComponent(`#${tag}`)}`;
  const params = new URLSearchParams(location.search);
  const terms: string[] = (params.get("q") ?? "").match(/-?"[^"]*"|\S+/g) ?? [];
  const on = terms.includes(`#${tag}`);
  const rest = terms.filter((t) => !t.startsWith("#"));
  const q = (on ? rest : [...rest, `#${tag}`]).join(" ");
  if (q) params.set("q", q);
  else params.delete("q");
  params.delete("cursor");
  const search = params.toString();
  return `${location.pathname}${search ? `?${search}` : ""}`;
}

export function playAudio(button: HTMLElement) {
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

export function initResize() {
  const handle = $("[data-resize=sidebar]");
  if (!handle || handle.dataset.ready) return;
  handle.dataset.ready = "1";
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


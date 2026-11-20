// In-place navigation: links and search forms inside the app fetch the next
// page's HTML and swap it in, so the sidebar, scroll and loaded scripts stay.
// boot.ts re-wires the new page on `memos:page`; a page that can show a history
// entry itself takes the cancelable `memos:pop`.

import { $, $$, base } from "./lib/dom";
import { closeAll } from "./lib/popup";

const boot = () => $<HTMLScriptElement>("script[type=module][src]")?.src;
const sidebarScroll = () => $("#sidebar .overflow-y-auto");
let pending: AbortController | null = null;

history.scrollRestoration = "manual";

function remember() {
  history.replaceState({ ...history.state, scroll: scrollY }, "");
}

/** The app pages a link may open in place: same origin, under the base path, not files or endpoints. */
function inApp(url: URL) {
  if (url.origin !== location.origin) return false;
  const path = url.pathname.slice(base.length);
  if (!url.pathname.startsWith(base) || (path && !path.startsWith("/"))) return false;
  return !/^\/(file|thumb|avatar|api|f|assets|favicon\.svg|healthz)(\/|$)/.test(path);
}

const FOCUSABLE = "a[href], button, [tabindex]";

const chrome = () => $$<HTMLElement>(FOCUSABLE, $("#root")!).filter((el) => !el.closest("main"));

function swap(doc: Document) {
  const html = document.documentElement;
  for (const name of ["lang", "dir", "data-theme", "data-system"]) {
    const value = doc.documentElement.getAttribute(name);
    if (value === null) html.removeAttribute(name);
    else html.setAttribute(name, value);
  }
  if (html.dataset.system !== undefined && matchMedia("(prefers-color-scheme: dark)").matches) html.setAttribute("data-theme", "dark");
  document.title = doc.title;
  for (const sel of ["head > style", "link[rel=icon]", "meta[name=description]"]) {
    $$(sel).forEach((el) => el.remove());
    for (const el of doc.querySelectorAll(sel)) document.head.append(document.adoptNode(el));
  }
  const keep = sidebarScroll()?.scrollTop ?? 0;
  const active = document.activeElement as HTMLElement;
  const focused = chrome().indexOf(active);
  const card = active.closest<HTMLElement>("main [data-card]");
  const inCard = card ? $$(FOCUSABLE, card).indexOf(active) : -1;
  $("#root")!.replaceWith(document.adoptNode(doc.getElementById("root")!));
  $$("body > template").forEach((t) => t.remove());
  $("#toasts")!.before(...[...doc.querySelectorAll("body > template")].map((t) => document.adoptNode(t)));
  const side = sidebarScroll();
  if (side) side.scrollTop = keep;
  for (const old of $$<HTMLScriptElement>("#root script:not([src]):not([type])")) {
    const run = document.createElement("script");
    run.textContent = old.textContent;
    old.replaceWith(run);
  }
  return () => {
    if (focused >= 0) chrome()[focused]?.focus({ preventScroll: true });
    const again = card && $(`main [data-card="${card.dataset.card}"]`);
    if (again && inCard >= 0) $$(FOCUSABLE, again)[inCard]?.focus({ preventScroll: true });
  };
}

/** Shows `url` in place; `replace` keeps the history entry and the scroll position, as after a write. */
async function navigate(url: string, replace = false, scroll?: number) {
  const next = new URL(url, location.href);
  pending?.abort();
  const ctrl = (pending = new AbortController());
  let res: Response;
  try {
    res = await fetch(next, { signal: ctrl.signal, headers: { accept: "text/html" } });
  } catch (e) {
    if (!ctrl.signal.aborted) location.assign(next);
    return;
  }
  if (!res.headers.get("content-type")?.startsWith("text/html")) return location.assign(next);
  const doc = new DOMParser().parseFromString(await res.text(), "text/html");
  if (ctrl.signal.aborted) return;
  pending = null;
  const shown = new URL(res.url);
  shown.hash = next.hash;
  if (doc.querySelector<HTMLScriptElement>("script[type=module][src]")?.src !== boot() || !doc.getElementById("root")) {
    return location.assign(shown);
  }
  const keepScroll = replace ? scrollY : 0;
  if (scroll === undefined) {
    if (replace) history.replaceState(history.state, "", shown);
    else {
      remember();
      history.pushState(null, "", shown);
    }
  }
  closeAll();
  const refocus = swap(doc);
  document.dispatchEvent(new CustomEvent("memos:page"));
  refocus();
  const target = shown.hash && document.getElementById(decodeURIComponent(shown.hash.slice(1)));
  if (target && scroll === undefined && !replace) target.scrollIntoView();
  else restore(scroll ?? keepScroll);
}

/** Scrolls to `y`, and back to it while the new page's cards settle into their real heights. */
function restore(y: number) {
  scrollTo(0, y);
  if (!y) return;
  const watch = new ResizeObserver(() => scrollTo(0, y));
  const stop = () => {
    watch.disconnect();
    for (const type of STOP) removeEventListener(type, stop, true);
  };
  for (const type of STOP) addEventListener(type, stop, { capture: true, passive: true });
  watch.observe(document.body);
  setTimeout(stop, 1000);
}

const STOP = ["wheel", "touchstart", "keydown", "pointerdown"];

window.__navigate = navigate;

addEventListener("click", (e) => {
  const a = (e.target as Element).closest?.<HTMLAnchorElement>("a[href]");
  if (!a || e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  if (a.target || a.hasAttribute("download")) return;
  const url = new URL(a.href);
  if (!inApp(url)) return;
  if (url.hash && url.pathname === location.pathname && url.search === location.search) return;
  e.preventDefault();
  void navigate(url.href);
});

addEventListener("submit", (e) => {
  const form = e.target as HTMLFormElement;
  if (e.defaultPrevented || form.method !== "get") return;
  const url = new URL(form.action);
  if (!inApp(url)) return;
  e.preventDefault();
  url.search = new URLSearchParams(new FormData(form) as unknown as Record<string, string>).toString();
  void navigate(url.href);
});

addEventListener("popstate", (e) => {
  pending?.abort();
  if (!document.dispatchEvent(new CustomEvent("memos:pop", { cancelable: true }))) return;
  void navigate(location.href, false, (e.state as { scroll?: number } | null)?.scroll ?? 0);
});

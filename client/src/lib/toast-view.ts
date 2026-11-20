import { $, strings } from "./dom";
import { enter } from "./popup";
import { icon } from "./icon";

const LIMIT = 3;
const TIMEOUT = 5000;

let expanded = false;

const live = (viewport: HTMLElement) => [...viewport.children].filter((t) => !t.hasAttribute("data-ending-style")) as HTMLElement[];

function layout(viewport: HTMLElement) {
  const toasts = live(viewport).reverse();
  let offset = 0;
  toasts.forEach((t, i) => {
    t.style.setProperty("--toast-index", String(i));
    t.style.setProperty("--toast-offset-y", `${offset}px`);
    offset += t.offsetHeight;
    t.toggleAttribute("data-limited", i >= LIMIT);
    t.toggleAttribute("data-expanded", expanded);
    const content = t.firstElementChild as HTMLElement;
    content.toggleAttribute("data-behind", i > 0 && !expanded);
    content.toggleAttribute("data-expanded", expanded);
  });
  viewport.style.setProperty("--toast-frontmost-height", `${toasts[0]?.offsetHeight ?? 0}px`);
}

function initViewport(viewport: HTMLElement) {
  if (viewport.dataset.ready) return;
  viewport.dataset.ready = "1";
  const set = (on: boolean) => {
    expanded = on;
    layout(viewport);
  };
  viewport.addEventListener("pointerenter", () => set(true));
  viewport.addEventListener("pointerleave", () => set(false));
  viewport.addEventListener("focusin", () => set(true));
  viewport.addEventListener("focusout", (e) => viewport.contains(e.relatedTarget as Node) || set(false));
}

export function toast(message: string, type: "success" | "danger" = "success") {
  const viewport = $("#toasts");
  if (!viewport) return;
  initViewport(viewport);
  const el = document.createElement("div");
  el.className = `mu-toast mu-popup mu-base mu-s-md ${type === "danger" ? "mu-toast-danger" : "mu-toast-success"}`;
  el.dataset.type = type;
  el.setAttribute("role", "dialog");
  el.tabIndex = 0;
  el.style.cssText = "--toast-swipe-movement-x:0px;--toast-swipe-movement-y:0px;--toast-index:0;--toast-offset-y:0px";
  el.innerHTML = `<div class="mu-toast-content">${icon(type === "success" ? "circle-check" : "circle-alert", "mu-toast-icon")}<div class="mu-toast-text"><h2 class="mu-toast-title mu-label"></h2></div><button type="button" aria-label="${strings.close}" class="mu-button mu-button-ghost mu-button-icon mu-base mu-s-sm mu-focus mu-toast-close">${icon("x", "")}</button></div>`;
  el.querySelector("h2")!.textContent = message;
  viewport.append(el);
  el.style.setProperty("--toast-height", `${el.offsetHeight || 56}px`);
  layout(viewport);
  enter(el);
  let timer = 0;
  const close = () => {
    clearTimeout(timer);
    el.setAttribute("data-ending-style", "");
    layout(viewport);
    setTimeout(() => el.remove(), 300);
  };
  el.querySelector("button")!.addEventListener("click", close);
  const expire = () => (expanded ? (timer = window.setTimeout(expire, 1000)) : close());
  if (type === "success") timer = window.setTimeout(expire, TIMEOUT);
}

export const toastError = (e: unknown) => toast(e instanceof Error && e.message ? e.message : strings.error, "danger");

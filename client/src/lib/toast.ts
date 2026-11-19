import { $, strings } from "./dom";
import { enter } from "./popup";
import { icon } from "./icon";

/** A toast like the package's: success or error, gone after a few seconds. */
export function toast(message: string, type: "success" | "error" = "success") {
  const viewport = $("#toasts");
  if (!viewport) return;
  const el = document.createElement("div");
  el.className = `mu-toast mu-popup mu-base mu-s-md mu-toast-${type}`;
  el.dataset.type = type;
  el.setAttribute("role", "dialog");
  el.style.cssText = "--toast-swipe-movement-x:0px;--toast-swipe-movement-y:0px;--toast-index:0;--toast-offset-y:0px";
  el.innerHTML = `<div class="mu-toast-content">${icon(type === "success" ? "circle-check" : "circle-alert", "mu-toast-icon")}<div class="mu-toast-text"><h2 class="mu-toast-title mu-label"></h2></div><button type="button" aria-label="${strings.close}" class="mu-button mu-button-ghost mu-button-icon mu-base mu-s-sm mu-focus mu-toast-close">${icon("x", "")}</button></div>`;
  el.querySelector("h2")!.textContent = message;
  for (const old of viewport.children) (old as HTMLElement).remove();
  viewport.append(el);
  const h = el.offsetHeight || 56;
  el.style.setProperty("--toast-height", `${h}px`);
  viewport.style.setProperty("--toast-frontmost-height", `${h}px`);
  enter(el);
  const close = () => {
    el.setAttribute("data-ending-style", "");
    setTimeout(() => el.remove(), 300);
  };
  el.querySelector("button")!.addEventListener("click", close);
  setTimeout(close, type === "error" ? 6000 : 3000);
}

export const toastError = (e: unknown) => toast(e instanceof Error && e.message ? e.message : strings.error, "error");

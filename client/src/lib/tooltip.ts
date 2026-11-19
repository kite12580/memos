import { enter } from "./popup";

const TRIGGERS = '.mu-button-icon[aria-label], nav[aria-label="Primary"] [aria-label], [data-tip]';
const DELAY = 600;

let timer = 0;
let shown: HTMLElement | null = null;

function hide() {
  clearTimeout(timer);
  shown?.remove();
  shown = null;
}

function show(trigger: HTMLElement) {
  const text = trigger.dataset.tip ?? trigger.getAttribute("aria-label");
  if (!text || trigger.hasAttribute("data-popup-open")) return;
  const positioner = document.createElement("div");
  positioner.className = "mu-positioner";
  positioner.style.cssText = "position:absolute;top:0;left:0;pointer-events:none";
  const popup = document.createElement("div");
  popup.className = "mu-tooltip-popup mu-popup-motion mu-label-sm";
  popup.dataset.side = "bottom";
  popup.dataset.align = "center";
  popup.textContent = text;
  positioner.append(popup);
  document.body.append(positioner);
  const a = trigger.getBoundingClientRect();
  const p = popup.getBoundingClientRect();
  const x = Math.min(Math.max(8, a.left + (a.width - p.width) / 2), document.documentElement.clientWidth - 8 - p.width);
  positioner.style.transform = `translate(${Math.round(x + scrollX)}px, ${Math.round(a.bottom + 6 + scrollY)}px)`;
  enter(popup);
  shown = positioner;
}

/** memos' hover tooltips on icon buttons and the navigation, for mouse users. */
export function initTooltips() {
  if (!matchMedia("(pointer: fine)").matches) return;
  document.addEventListener("pointerover", (e) => {
    const trigger = (e.target as HTMLElement).closest<HTMLElement>(TRIGGERS);
    if (!trigger || shown) return;
    clearTimeout(timer);
    timer = window.setTimeout(() => show(trigger), DELAY);
    trigger.addEventListener("pointerleave", hide, { once: true });
  });
  document.addEventListener("pointerdown", hide, true);
  addEventListener("scroll", hide, { passive: true });
}

import { enter } from "./popup";

const TRIGGERS = '.mu-button-icon[aria-label], nav[aria-label="Primary"] [aria-label], [data-tip]';
const BELOW = 'nav[aria-label="Primary"] *, [data-action=drawer], [data-popup=display]';
const DELAY = 400;

let timer = 0;
let shown: HTMLElement | null = null;
let pending: HTMLElement | null = null;
let hiddenAt = 0;

function hide() {
  clearTimeout(timer);
  pending = null;
  if (shown) hiddenAt = Date.now();
  shown?.remove();
  shown = null;
}

function show(trigger: HTMLElement) {
  const text = trigger.dataset.tip ?? trigger.getAttribute("aria-label");
  if (!text || trigger.hasAttribute("data-popup-open") || !trigger.isConnected) return;
  const positioner = document.createElement("div");
  positioner.className = "mu-positioner";
  positioner.style.cssText = "position:absolute;top:0;left:0;pointer-events:none";
  const popup = document.createElement("div");
  popup.className = "mu-tooltip-popup mu-popup-motion mu-label-sm";
  const start = trigger.dataset.tipAlign === "start";
  popup.dataset.align = start ? "start" : "center";
  if (start) {
    popup.classList.add("flex", "flex-col", "items-start", "gap-0.5", "whitespace-nowrap", "text-left");
    for (const line of text.split("\n")) popup.appendChild(document.createElement("span")).textContent = line;
  } else popup.textContent = text;
  const shortcut = trigger.dataset.tipShortcut;
  if (shortcut) popup.insertAdjacentHTML("beforeend", `<span class="mu-tooltip-shortcut">${shortcut}</span>`);
  positioner.append(popup);
  document.body.append(positioner);
  const a = trigger.getBoundingClientRect();
  const p = popup.getBoundingClientRect();
  const x = Math.min(Math.max(8, start ? a.left : a.left + (a.width - p.width) / 2), document.documentElement.clientWidth - 8 - p.width);
  let side = trigger.matches(BELOW) ? "bottom" : "top";
  if (side === "top" && a.top - 6 - p.height < 8) side = "bottom";
  const y = side === "top" ? a.top - 6 - p.height : a.bottom + 6;
  popup.dataset.side = side;
  positioner.style.transform = `translate(${Math.round(x + scrollX)}px, ${Math.round(y + scrollY)}px)`;
  enter(popup);
  shown = positioner;
}

function arm(trigger: HTMLElement) {
  if (pending === trigger) return;
  hide();
  pending = trigger;
  if (Date.now() - hiddenAt < DELAY) return show(trigger);
  timer = window.setTimeout(() => show(trigger), DELAY);
}

export function initTooltips() {
  const mouse = matchMedia("(pointer: fine)").matches;
  if (mouse) {
    document.addEventListener("pointermove", (e) => {
      if (e.pointerType !== "mouse") return;
      const trigger = (e.target as HTMLElement).closest<HTMLElement>(TRIGGERS);
      if (trigger) arm(trigger);
      else if (pending) hide();
    });
    document.addEventListener("pointerleave", hide);
  }
  document.addEventListener("focusin", (e) => {
    const trigger = (e.target as HTMLElement).closest<HTMLElement>(TRIGGERS);
    if (trigger?.matches(":focus-visible")) {
      hide();
      pending = trigger;
      show(trigger);
    }
  });
  document.addEventListener("focusout", (e) => {
    if (e.target === pending) hide();
  });
  document.addEventListener("pointerdown", hide, true);
  document.addEventListener("keydown", (e) => e.key === "Escape" && hide(), true);
  addEventListener("scroll", hide, { passive: true });
}

import { fromTemplate } from "./dom";

export type Side = "bottom" | "inline-end";
export type Align = "start" | "end" | "center";

interface Layer {
  el: HTMLElement;
  trigger?: HTMLElement;
  restore?: HTMLElement | null;
  onClose?: () => void;
}

const stack: Layer[] = [];
const GAP = 6;
const TABBABLE = 'a[href], button:not([disabled]), input:not([type=hidden], [type=file], [disabled]), textarea:not([disabled]), select:not([disabled]), [contenteditable=true], [tabindex]:not([tabindex="-1"])';
const MENU = "[role=menu], .mu-select-popup";
const ITEM = ':is([role^="menuitem"], [role="option"])[tabindex]';

function highlight(scope: HTMLElement, item: HTMLElement | undefined, among = "*") {
  for (const el of scope.querySelectorAll(`:is(${among})[data-highlighted]`)) if (el !== item) el.removeAttribute("data-highlighted");
  item?.setAttribute("data-highlighted", "");
}

export interface ListNav {
  highlight(item: HTMLElement | undefined, scroll?: boolean): void;
  current(): HTMLElement | undefined;
}

/**
 * A list whose `input` keeps focus while its `items` highlight under the pointer and with
 * the `steps` keys. Enter calls `pick` with the highlighted item.
 */
export function listNav(
  list: HTMLElement,
  input: HTMLElement,
  items: () => HTMLElement[],
  pick: (item: HTMLElement | undefined) => void,
  { signal, steps = { ArrowDown: 1, ArrowUp: -1 } }: { signal?: AbortSignal; steps?: Partial<Record<string, number>> } = {},
): ListNav {
  let current: HTMLElement | undefined;
  const nav: ListNav = {
    highlight(item, scroll = true) {
      current = item;
      highlight(list, item);
      if (scroll) item?.scrollIntoView({ block: "nearest" });
    },
    current: () => (current?.isConnected ? current : undefined),
  };
  list.addEventListener("pointerover", (e) => nav.highlight(items().find((i) => i.contains(e.target as Node)), false), { signal });
  input.addEventListener(
    "keydown",
    (e) => {
      const step = steps[e.key];
      const all = items();
      if (step && all.length) {
        const at = all.indexOf(nav.current()!);
        nav.highlight(all[at < 0 ? 0 : Math.min(all.length - 1, Math.max(0, at + step))]);
      } else if (e.key === "Enter") {
        const item = nav.current();
        pick(item);
        if (!item) return;
      } else return;
      e.preventDefault();
      e.stopPropagation();
    },
    { signal },
  );
  return nav;
}

let closing: ReturnType<typeof setTimeout> | undefined;
let keyboard = false;

const popupOf = (layer: Layer) => (layer.el.firstElementChild as HTMLElement | null) ?? layer.el;

function onPointerOver(e: PointerEvent) {
  const t = e.target as HTMLElement;
  const index = stack.findIndex((l) => l.el.contains(t));
  if (index === -1) {
    const sub = stack.findIndex((l) => l.trigger?.matches("[data-submenu]"));
    if (sub > 0 && e.pointerType === "mouse" && !stack[sub].trigger!.contains(t)) {
      clearTimeout(closing);
      closing = setTimeout(() => closeFrom(sub), 100);
    }
    for (const l of stack) {
      if (popupOf(l).matches(".mu-select-popup")) continue;
      highlight(l.el, undefined, ITEM);
      const active = document.activeElement as HTMLElement | null;
      if (active?.matches(ITEM) && l.el.contains(active)) popupOf(l).focus({ preventScroll: true });
    }
    return;
  }
  const layer = stack[index];
  clearTimeout(closing);
  for (const l of stack) if (l !== layer && t.closest(ITEM)) highlight(l.el, undefined, ITEM);
  const child = stack[index + 1];
  if (child?.trigger && e.pointerType === "mouse" && !child.trigger.contains(t) && t.closest(`${ITEM}, .mu-menu-item`)) {
    closing = setTimeout(() => stack[index + 1] === child && closeFrom(index + 1), 100);
  }
  const item = t.closest<HTMLElement>(ITEM);
  if (item?.hasAttribute("data-disabled")) return;
  highlight(layer.el, item ?? undefined, ITEM);
  item?.focus({ preventScroll: true });
}

/** Places `positioner` next to `anchor` inside the viewport, flipping when it would overflow. */
function place(positioner: HTMLElement, popup: HTMLElement, anchor: HTMLElement, side: Side, align: Align) {
  const a = anchor.getBoundingClientRect();
  const p = popup.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const rtl = document.documentElement.dir === "rtl";
  let x: number;
  let y: number;
  let finalSide: string = side;
  if (side === "inline-end") {
    x = rtl ? a.left - p.width - GAP : a.right + GAP;
    if (x + p.width > vw - 8 || x < 8) x = rtl ? a.right + GAP : a.left - p.width - GAP;
    y = a.top - 4;
    if (y + p.height > vh - 8) y = Math.max(8, vh - 8 - p.height);
  } else {
    const start = rtl ? a.right - p.width : a.left;
    const end = rtl ? a.left : a.right - p.width;
    x = align === "start" ? start : align === "end" ? end : a.left + (a.width - p.width) / 2;
    if (align !== "center" && (x + p.width > vw - 8 || x < 8)) {
      const flipped = align === "start" ? end : start;
      if (flipped + p.width <= vw - 8 && flipped >= 8) {
        x = flipped;
        align = align === "start" ? "end" : "start";
      }
    }
    y = a.bottom + GAP;
    if (y + p.height > vh - 8 && a.top - GAP - p.height > 8) {
      y = a.top - GAP - p.height;
      finalSide = "top";
    }
  }
  x = Math.min(Math.max(8, x), Math.max(8, vw - 8 - p.width));
  positioner.style.transform = `translate(${Math.round(x + scrollX)}px, ${Math.round(y + scrollY)}px)`;
  positioner.style.setProperty("--available-height", `${Math.round(vh - 16)}px`);
  positioner.style.setProperty("--available-width", `${Math.round(vw - 16)}px`);
  popup.dataset.side = finalSide;
  popup.dataset.align = align;
}

let instant = false;

/** Animates in with the package's `data-starting-style` hook. */
export function enter(el: HTMLElement) {
  if (instant) return void el.setAttribute("data-open", "");
  el.setAttribute("data-starting-style", "");
  el.setAttribute("data-open", "");
  requestAnimationFrame(() => requestAnimationFrame(() => el.removeAttribute("data-starting-style")));
}

export function closeFrom(index: number) {
  const closed = stack.splice(index);
  const active = document.activeElement;
  const lost = !active || active === document.body || closed.some((l) => l.el.contains(active));
  for (const layer of closed.reverse()) {
    layer.el.remove();
    if (layer.trigger) {
      layer.trigger.removeAttribute("data-popup-open");
      layer.trigger.setAttribute("aria-expanded", "false");
    }
    layer.onClose?.();
  }
  const back = closed.at(-1)?.restore;
  if (lost && back?.isConnected) back.focus({ preventScroll: true });
}

export const closeAll = () => closeFrom(0);

export function closeFor(trigger: HTMLElement) {
  const index = stack.findIndex((l) => l.trigger === trigger);
  if (index >= 0) closeFrom(index);
}

function selectorOf(el: Element, scope: ParentNode) {
  if (el.id) return `#${CSS.escape(el.id)}`;
  for (const name of ["data-popup", "data-submenu", "data-select"]) {
    const value = el.getAttribute(name);
    if (value) return `[${name}="${CSS.escape(value)}"]`;
  }
  const key = el.getAttribute("data-key");
  if (!key) return null;
  const byKey = `[data-key="${CSS.escape(key)}"]`;
  return scope.querySelectorAll(byKey).length > 1 ? `${byKey}[data-value="${CSS.escape(el.getAttribute("data-value") ?? "")}"]` : byKey;
}

export interface Snapshot {
  chain: string[];
  focus: string | null;
}

export function snapshot(): Snapshot {
  const chain: string[] = [];
  for (const [i, layer] of stack.entries()) {
    const sel = layer.trigger && selectorOf(layer.trigger, i ? stack[i - 1].el : document);
    if (!sel) break;
    chain.push(sel);
  }
  const active = document.activeElement;
  const scope = stack[chain.length - 1]?.el ?? document;
  return { chain, focus: active && scope.contains(active) ? selectorOf(active, scope) : null };
}

export async function restore({ chain, focus }: Snapshot) {
  instant = true;
  try {
    for (const sel of chain) {
      const scope = stack.at(-1)?.el ?? document;
      const trigger = scope.querySelector<HTMLElement>(sel);
      if (!trigger) break;
      trigger.click();
      for (let i = 0; i < 20 && !isOpenFor(trigger); i++) await new Promise((r) => setTimeout(r));
    }
  } finally {
    instant = false;
  }
  if (focus) (stack.at(-1)?.el ?? document).querySelector<HTMLElement>(focus)?.focus({ preventScroll: true });
}

export function isOpenFor(trigger: HTMLElement) {
  return stack.some((l) => l.trigger === trigger);
}

/**
 * Opens `popup` anchored to `trigger`. A popup opened from inside another
 * stays as its child; anything else closes the open ones first.
 */
export function openPopup(trigger: HTMLElement, popup: HTMLElement, side: Side = "bottom", align: Align = "start", onClose?: () => void, anchor = trigger) {
  const parentIndex = stack.findIndex((l) => l.el.contains(trigger));
  closeFrom(parentIndex + 1);
  const positioner = document.createElement("div");
  positioner.className = "mu-positioner";
  positioner.setAttribute("role", "presentation");
  positioner.style.cssText = "position:absolute;top:0;left:0";
  positioner.append(popup);
  document.body.append(positioner);
  place(positioner, popup, anchor, side, align);
  enter(popup);
  trigger.setAttribute("data-popup-open", "");
  trigger.setAttribute("aria-expanded", "true");
  stack.push({ el: positioner, trigger, restore: trigger, onClose });
  if (!popup.hasAttribute("tabindex")) popup.tabIndex = -1;
  if (!matchMedia("(pointer: coarse)").matches) {
    if (popup.matches(MENU)) {
      const item = popup.querySelector<HTMLElement>(`${ITEM}[data-selected]`) ?? (keyboard ? popup.querySelector<HTMLElement>(ITEM) : null);
      if (item) {
        item.focus({ preventScroll: true });
        highlight(popup, item, ITEM);
      } else popup.focus({ preventScroll: true });
    } else {
      const first = [...popup.querySelectorAll<HTMLElement>(TABBABLE)].find((el) => el.getClientRects().length);
      (first ?? popup).focus({ preventScroll: true });
    }
  }
  return positioner;
}

export function openTemplate(trigger: HTMLElement, id: string, side: Side = "bottom", align: Align = "start", setup?: (popup: HTMLElement) => void, anchor = trigger) {
  const frag = fromTemplate(id);
  const popup = frag?.firstElementChild as HTMLElement | null;
  if (!popup) return null;
  setup?.(popup);
  openPopup(trigger, popup, side, align, undefined, anchor);
  return popup;
}

/** A modal dialog from a template holding a backdrop and a viewport. */
export function openDialog(id: string, setup?: (root: HTMLElement) => void, onClose?: () => void) {
  closeAll();
  const opener = document.activeElement;
  const frag = fromTemplate(id);
  if (!frag) return null;
  const root = document.createElement("div");
  root.append(frag);
  setup?.(root);
  document.body.append(root);
  document.body.style.overflow = "hidden";
  for (const el of root.querySelectorAll<HTMLElement>(".mu-dialog-backdrop, .mu-dialog-popup")) enter(el);
  stack.push({
    el: root,
    restore: opener instanceof HTMLElement ? opener : null,
    onClose: () => {
      document.body.style.overflow = "";
      onClose?.();
    },
  });
  root.querySelector<HTMLElement>('input:not([type=hidden], [type=file]), textarea, [data-action=dialog-cancel], [data-action=dialog-ok]')?.focus();
  return root;
}

export function closeLayer(el: Element) {
  const index = stack.findIndex((l) => l.el.contains(el));
  if (index >= 0) closeFrom(index);
}

/** Keeps menus keyboard-usable: arrows move, Enter activates, Escape closes. */
function onKey(e: KeyboardEvent) {
  if (!stack.length) return;
  if (e.key === "Escape") {
    const top = stack[stack.length - 1];
    closeFrom(stack.length - 1);
    top.restore?.focus();
    e.preventDefault();
    return;
  }
  const active = document.activeElement as HTMLElement;
  const found = stack.findIndex((l) => l.el.contains(active));
  const index = found === -1 ? stack.length - 1 : found;
  const layer = stack[index];
  const top = stack[stack.length - 1];
  if (e.key === "Tab" && !top.trigger) {
    const all = [...top.el.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => el.getClientRects().length);
    const at = all.indexOf(active);
    const next = e.shiftKey ? (at <= 0 ? all.at(-1) : undefined) : at === all.length - 1 || at === -1 ? all[0] : undefined;
    if (next) {
      next.focus();
      e.preventDefault();
    }
    return;
  }
  if (e.key === "Tab" && layer.trigger) {
    if (!popupOf(layer).matches(MENU)) {
      const all = [...layer.el.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => el.getClientRects().length);
      const at = all.indexOf(active);
      if (at === -1 && all.length && !e.shiftKey) {
        all[0].focus();
        e.preventDefault();
        return;
      }
      if (e.shiftKey ? at > 0 : at >= 0 && at < all.length - 1) return;
    }
    let outer = index;
    while (outer > 0 && stack[outer].trigger?.closest("[role=menu]")) outer--;
    const trigger = stack[outer].trigger;
    closeFrom(outer);
    trigger?.focus({ preventScroll: true });
    if (e.shiftKey) e.preventDefault();
    return;
  }
  const rtl = document.documentElement.dir === "rtl";
  if (e.key === (rtl ? "ArrowLeft" : "ArrowRight") && active.matches("[data-submenu]") && layer.el.contains(active)) {
    active.click();
    e.preventDefault();
    return;
  }
  if (e.key === (rtl ? "ArrowRight" : "ArrowLeft") && index > 0 && layer.trigger?.matches("[data-submenu]")) {
    closeFrom(index);
    layer.trigger.focus();
    e.preventDefault();
    return;
  }
  const items = [...layer.el.querySelectorAll<HTMLElement>(ITEM)].filter((i) => !i.hidden);
  if (!items.length) return;
  const at = items.indexOf(active);
  const move = (next: HTMLElement | undefined) => {
    if (!next) return;
    closeFrom(index + 1);
    next.focus();
    highlight(layer.el, next, ITEM);
    e.preventDefault();
  };
  if (e.key === "ArrowDown") move(items[at < 0 ? 0 : (at + 1) % items.length]);
  else if (e.key === "ArrowUp") move(items[at < 0 ? items.length - 1 : (at + items.length - 1) % items.length]);
  else if (e.key === "Home") move(items[0]);
  else if (e.key === "End") move(items[items.length - 1]);
  else if ((e.key === "Enter" || e.key === " ") && at >= 0) {
    items[at].click();
    e.preventDefault();
  } else if (e.key.length === 1 && e.key !== " " && !e.metaKey && !e.ctrlKey && !e.altKey && !active.matches("input, textarea")) {
    clearTimeout(typedTimer);
    typed += e.key.toLowerCase();
    typedTimer = setTimeout(() => (typed = ""), 500);
    const from = typed.length > 1 ? Math.max(at, 0) : at + 1;
    const order = [...items.slice(from), ...items.slice(0, from)];
    move(order.find((i) => (i.textContent ?? "").trim().toLowerCase().startsWith(typed)));
  }
}

let typed = "";
let typedTimer: ReturnType<typeof setTimeout> | undefined;

export function initPopups() {
  document.addEventListener("keydown", () => (keyboard = true), true);
  document.addEventListener(
    "pointerdown",
    (e) => {
      keyboard = false;
      const t = e.target as Node;
      const index = stack.findLastIndex((l) => l.el.contains(t) || l.trigger?.contains(t));
      if (index === -1) {
        if (!stack.length) return;
        const back = stack[0].restore;
        closeAll();
        addEventListener("pointerup", () => setTimeout(() => document.activeElement === document.body && back?.isConnected && back.focus({ preventScroll: true })), { once: true });
      } else if (!stack[index].el.contains(t)) return;
      else closeFrom(index + 1);
    },
    true,
  );
  document.addEventListener("keydown", onKey);
  document.addEventListener("pointerover", onPointerOver);
  addEventListener("resize", closeAll);
}

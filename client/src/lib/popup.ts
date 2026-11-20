import { fromTemplate } from "./dom";

export type Side = "bottom" | "inline-end";
export type Align = "start" | "end" | "center";

interface Layer {
  el: HTMLElement;
  trigger?: HTMLElement;
  onClose?: () => void;
}

const stack: Layer[] = [];
const GAP = 6;
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
        nav.highlight(all[Math.min(all.length - 1, Math.max(0, at + step))]);
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

function onPointerOver(e: PointerEvent) {
  const t = e.target as HTMLElement;
  const index = stack.findIndex((l) => l.el.contains(t));
  if (index === -1) return;
  const layer = stack[index];
  clearTimeout(closing);
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

/** Animates in with the package's `data-starting-style` hook. */
export function enter(el: HTMLElement) {
  el.setAttribute("data-starting-style", "");
  el.setAttribute("data-open", "");
  requestAnimationFrame(() => requestAnimationFrame(() => el.removeAttribute("data-starting-style")));
}

export function closeFrom(index: number) {
  for (const layer of stack.splice(index)) {
    layer.el.remove();
    if (layer.trigger) {
      layer.trigger.removeAttribute("data-popup-open");
      layer.trigger.setAttribute("aria-expanded", "false");
    }
    layer.onClose?.();
  }
}

export const closeAll = () => closeFrom(0);

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
  stack.push({ el: positioner, trigger, onClose });
  const first = popup.querySelector<HTMLElement>('[role^="menuitem"], [role="option"], input, [tabindex="0"]');
  if (first && !matchMedia("(pointer: coarse)").matches) first.focus({ preventScroll: true });
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
    onClose: () => {
      document.body.style.overflow = "";
      onClose?.();
    },
  });
  root.querySelector<HTMLElement>("input, textarea, [data-action=dialog-ok]")?.focus();
  return root;
}

export function closeDialog(el: Element) {
  const index = stack.findIndex((l) => l.el.contains(el));
  if (index >= 0) closeFrom(index);
}

/** Keeps menus keyboard-usable: arrows move, Enter activates, Escape closes. */
function onKey(e: KeyboardEvent) {
  if (!stack.length) return;
  if (e.key === "Escape") {
    const top = stack[stack.length - 1];
    closeFrom(stack.length - 1);
    top.trigger?.focus();
    e.preventDefault();
    return;
  }
  const top = stack[stack.length - 1].el;
  const items = [...top.querySelectorAll<HTMLElement>(ITEM)].filter((i) => !i.hidden);
  if (!items.length) return;
  const at = items.indexOf(document.activeElement as HTMLElement);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    const next = items[(at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length];
    next.focus();
    highlight(top, next, ITEM);
    e.preventDefault();
  } else if ((e.key === "Enter" || e.key === " ") && at >= 0) {
    items[at].click();
    e.preventDefault();
  }
}

export function initPopups() {
  document.addEventListener(
    "pointerdown",
    (e) => {
      const t = e.target as Node;
      const index = stack.findIndex((l) => l.el.contains(t) || l.trigger?.contains(t));
      if (index === -1) closeAll();
      else if (!stack[index].el.contains(t)) return;
      else closeFrom(index + 1);
    },
    true,
  );
  document.addEventListener("keydown", onKey);
  document.addEventListener("pointerover", onPointerOver);
  addEventListener("resize", closeAll);
}

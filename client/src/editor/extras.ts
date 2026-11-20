import { $$ } from "../lib/dom";
import { icon } from "../lib/icon";
import { closeAll, openPopup } from "../lib/popup";
import type { Session } from "./index";
import { t } from "./strings";

const DRAG_THRESHOLD_PX = 4;
const LONG_PRESS_MS = 350;
const LONG_PRESS_SLOP_PX = 8;
const MOTION_MS = 180;
const MOTION_EASING = "cubic-bezier(0.2, 0.9, 0.3, 1)";

const TILE_PLACEHOLDER_STYLE = "border-style:dashed;border-color:var(--mu-edge);background:color-mix(in oklab,var(--mu-well) 50%,transparent);box-shadow:none";
const ROW_PLACEHOLDER_STYLE = "background:transparent;box-shadow:inset 0 0 0 1px var(--mu-edge)";
const GHOST_CLASS = "pointer-events-none fixed start-0 top-0 overflow-hidden rounded-mu-md border";
const GHOST_STYLE = "z-index:var(--mu-layer-popup);border-color:var(--mu-edge);scale:1.03";

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const itemsIn = (list: HTMLElement) => $$<HTMLElement>(":scope > [data-reorder-key]", list);

interface Press {
  item: HTMLElement;
  list: HTMLElement;
  pointerId: number;
  x: number;
  y: number;
  offsetX: number;
  offsetY: number;
  longPress: boolean;
  timer?: number;
}

function slide(before: Map<HTMLElement, DOMRect>) {
  if (reducedMotion()) return;
  for (const [el, from] of before) {
    for (const a of el.getAnimations()) a.cancel();
    const to = el.getBoundingClientRect();
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    const sx = to.width ? from.width / to.width : 1;
    const sy = to.height ? from.height / to.height : 1;
    if (!dx && !dy && sx === 1 && sy === 1) continue;
    el.animate(
      [
        { transformOrigin: "top left", transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
        { transformOrigin: "top left", transform: "none" },
      ],
      { duration: MOTION_MS, easing: MOTION_EASING },
    );
  }
}

function place(list: HTMLElement, item: HTMLElement, position: number) {
  const items = itemsIn(list);
  const before = new Map(items.map((el) => [el, el.getBoundingClientRect()]));
  const rest = items.filter((el) => el !== item);
  const next = rest[position];
  if (next) next.before(item);
  else (rest[rest.length - 1] ?? item).after(item);
  const shown = itemsIn(list);
  shown.forEach((el, i) => {
    el.dataset.reorderPosition = String(i);
    if (list.dataset.reorder === "tiles" && shown.length === 3) el.classList.toggle("row-span-2", i === 0);
  });
  slide(before);
}

function members(session: Session, uid: string) {
  const a = session.attachments.find((x) => x.uid === uid);
  return session.attachments.filter((x) => x === a || (a?.motionGroup && x.motionGroup === a.motionGroup));
}

/** memos' `moveGroup`: the moved item takes the place of the one it landed on. */
function commit(session: Session, key: string, target: string) {
  const all = session.attachments;
  const moved = members(session, key);
  const landed = members(session, target);
  if (!moved.length || !landed.length || moved.includes(landed[0])) return;
  const forward = all.indexOf(moved[0]) < all.indexOf(landed[0]);
  const rest = all.filter((a) => !moved.includes(a));
  rest.splice(forward ? rest.indexOf(landed[landed.length - 1]) + 1 : rest.indexOf(landed[0]), 0, ...moved);
  all.splice(0, all.length, ...rest);
}

function ghostOf(item: HTMLElement, rect: DOMRect, rows: boolean) {
  const ghost = document.createElement("div");
  ghost.className = `${GHOST_CLASS} ${rows ? "flex items-center gap-1 bg-mu-surface px-2 mu-caption text-mu-text" : "bg-mu-well"}`;
  ghost.style.cssText = GHOST_STYLE;
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  ghost.style.translate = `${rect.left}px ${rect.top}px`;
  if (rows) {
    const audio = item.querySelector(".lucide-file-headphone, [data-action=audio]");
    ghost.innerHTML = `<span class="flex size-5 shrink-0 items-center justify-center">${icon(audio ? "file-headphone" : "file", "mu-icon-sm text-mu-text-secondary")}</span><span class="min-w-0 flex-1 truncate"></span>`;
    ghost.lastElementChild!.textContent = item.querySelector("[title]")?.getAttribute("title") ?? "";
  } else {
    if (item.style.background) ghost.style.background = item.style.background;
    const media = item.querySelector("img, video");
    if (media) ghost.append(media.cloneNode());
  }
  return ghost;
}

export function wireExtras(session: Session) {
  const box = session.extras;
  let press: Press | null = null;
  let dragging: { item: HTMLElement; list: HTMLElement; ghost: HTMLElement; slots: { left: number; top: number; right: number; bottom: number }[]; start: string[]; settling: boolean } | null = null;
  let swallow = false;

  const hold = (item: HTMLElement, on: boolean, style = "") => {
    for (const child of item.children) (child as HTMLElement).style.visibility = on ? "hidden" : "";
    if (on) item.dataset.style = item.style.cssText;
    item.style.cssText = on ? `${item.style.cssText};${style}` : (item.dataset.style ?? "");
    if (!on) delete item.dataset.style;
  };

  const start = (p: Press) => {
    const box = p.list.getBoundingClientRect();
    const rect = p.item.getBoundingClientRect();
    const rows = p.list.dataset.reorder === "rows";
    const ghost = ghostOf(p.item, rect, rows);
    ghost.style.translate = `${p.x - p.offsetX}px ${p.y - p.offsetY}px`;
    document.body.append(ghost);
    const items = itemsIn(p.list);
    dragging = {
      item: p.item,
      list: p.list,
      ghost,
      slots: items.map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left - box.left, top: r.top - box.top, right: r.right - box.left, bottom: r.bottom - box.top };
      }),
      start: items.map((el) => el.dataset.reorderKey!),
      settling: false,
    };
    p.item.dataset.reorderPlaceholder = "true";
    hold(p.item, true, rows ? ROW_PLACEHOLDER_STYLE : TILE_PLACEHOLDER_STYLE);
  };

  const clear = () => {
    if (!dragging) return;
    dragging.ghost.remove();
    hold(dragging.item, false);
    delete dragging.item.dataset.reorderPlaceholder;
    dragging = null;
  };

  const end = (ok: boolean) => {
    if (press?.timer) clearTimeout(press.timer);
    press = null;
    removeListeners();
    if (!dragging || dragging.settling) return;
    swallow = true;
    setTimeout(() => (swallow = false), 0);
    const { ghost, item, list, start: order } = dragging;
    const key = item.dataset.reorderKey!;
    const at = Number(item.dataset.reorderPosition);
    if (!ok) {
      clear();
      return place(list, item, order.indexOf(key));
    }
    if (order[at] !== key) {
      commit(session, key, order[at]);
      session.changed();
    }
    if (reducedMotion()) return clear();
    dragging.settling = true;
    const target = item.getBoundingClientRect();
    const animation = ghost.animate(
      [
        { translate: ghost.style.translate, scale: "1.03" },
        { translate: `${target.left}px ${target.top}px`, scale: "1" },
      ],
      { duration: MOTION_MS, easing: MOTION_EASING, fill: "forwards" },
    );
    let done = false;
    const settle = () => {
      if (done) return;
      done = true;
      clear();
    };
    animation.onfinish = settle;
    animation.oncancel = settle;
    setTimeout(settle, MOTION_MS + 80);
  };

  const onMove = (e: PointerEvent) => {
    const p = press;
    if (!p || e.pointerId !== p.pointerId || dragging?.settling) return;
    if (!dragging) {
      const distance = Math.hypot(e.clientX - p.x, e.clientY - p.y);
      if (p.longPress) {
        if (distance > LONG_PRESS_SLOP_PX) end(false);
        return;
      }
      if (distance < DRAG_THRESHOLD_PX) return;
      start(p);
    }
    const d = dragging!;
    d.ghost.style.translate = `${e.clientX - p.offsetX}px ${e.clientY - p.offsetY}px`;
    const r = d.list.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const position = d.slots.findIndex((s) => x >= s.left && x < s.right && y >= s.top && y < s.bottom);
    if (position >= 0 && position !== Number(d.item.dataset.reorderPosition)) place(d.list, d.item, position);
  };
  const onUp = (e: PointerEvent) => {
    if (press && e.pointerId === press.pointerId) end(e.type === "pointerup");
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && dragging) end(false);
  };
  const onTouchMove = (e: TouchEvent) => {
    if (dragging) e.preventDefault();
  };
  const removeListeners = () => {
    removeEventListener("pointermove", onMove);
    removeEventListener("pointerup", onUp);
    removeEventListener("pointercancel", onUp);
    removeEventListener("keydown", onKey);
    removeEventListener("touchmove", onTouchMove);
  };

  box.addEventListener("pointerdown", (e) => {
    const target = e.target as HTMLElement;
    const item = target.closest<HTMLElement>("[data-reorder-key]");
    const list = item?.parentElement;
    if (!item || !list?.dataset.reorder || e.button !== 0 || press || dragging || itemsIn(list).length < 2) return;
    const control = target.closest("button, a, [role=menuitem]");
    if (control && control !== item && !control.hasAttribute("data-reorder-handle")) return;
    const longPress = list.dataset.reorder === "tiles" && e.pointerType === "touch";
    if (e.pointerType === "touch" && !longPress && !target.closest("[data-reorder-handle]")) return;
    const rect = item.getBoundingClientRect();
    const p: Press = { item, list, pointerId: e.pointerId, x: e.clientX, y: e.clientY, offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top, longPress };
    if (longPress) p.timer = window.setTimeout(() => press === p && start(p), LONG_PRESS_MS);
    press = p;
    addEventListener("pointermove", onMove);
    addEventListener("pointerup", onUp);
    addEventListener("pointercancel", onUp);
    addEventListener("keydown", onKey);
    addEventListener("touchmove", onTouchMove, { passive: false });
  });

  box.addEventListener(
    "click",
    (e) => {
      if (!swallow) return;
      swallow = false;
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );

  box.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement;
    const item = target.closest<HTMLElement>("[data-reorder-key]");
    const list = item?.parentElement;
    if (!item || !list?.dataset.reorder) return;
    const tile = list.dataset.reorder === "tiles";
    if (tile ? target !== item || !e.altKey : !target.hasAttribute("data-reorder-handle")) return;
    const step = e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : 0;
    const items = itemsIn(list);
    const from = items.indexOf(item);
    const to = from + step;
    if (!step || to < 0 || to >= items.length) return;
    e.preventDefault();
    e.stopPropagation();
    commit(session, item.dataset.reorderKey!, items[to].dataset.reorderKey!);
    place(list, item, to);
    target.focus();
    session.changed();
  });

  const act = (action: string, uid: string, trigger: HTMLElement) => {
    const a = session.attachments.find((x) => x.uid === uid);
    const group = members(session, uid);
    switch (action) {
      case "remove":
        session.attachments = session.attachments.filter((x) => !group.includes(x));
        break;
      case "unlink":
        session.relations = session.relations.filter((r) => r.uid !== uid);
        break;
      case "insert":
        if (!a) return;
        session.insertImages([a]);
        session.attachments = session.attachments.filter((x) => !group.includes(x));
        break;
      case "markup":
        if (a) void import("./draw").then((m) => m.openDrawing(session, t, a));
        return;
      case "more":
        return openMore(trigger, uid);
      default:
        return;
    }
    session.renderExtras();
    session.changed();
  };

  const openMore = (trigger: HTMLElement, uid: string) => {
    const popup = document.createElement("div");
    popup.className = "mu-menu-popup mu-popup mu-popup-motion mu-base mu-s-sm";
    popup.setAttribute("role", "menu");
    const keys = trigger.closest("[data-theme]")!.querySelectorAll<HTMLElement>("[data-extra]:not([data-extra=more])");
    popup.innerHTML = [...keys]
      .map(
        (k) =>
          `<div role="menuitem" tabindex="-1" class="mu-menu-item mu-s-sm mu-caption" data-item="${k.dataset.extra}"><span class="mu-option-icon" aria-hidden="true">${k.innerHTML}</span><span class="mu-menu-label"></span></div>`,
      )
      .join("");
    $$<HTMLElement>(".mu-menu-label", popup).forEach((el, i) => (el.textContent = keys[i].getAttribute("aria-label")));
    popup.addEventListener("click", (e) => {
      const item = (e.target as HTMLElement).closest<HTMLElement>("[data-item]");
      if (!item) return;
      closeAll();
      act(item.dataset.item!, uid, trigger);
    });
    openPopup(trigger, popup, "bottom", "end");
  };

  box.addEventListener("click", (e) => {
    const button = (e.target as HTMLElement).closest<HTMLElement>("[data-extra]");
    if (!button) return;
    e.preventDefault();
    e.stopPropagation();
    const uid = button.closest<HTMLElement>("[data-reorder-key], [data-link]");
    if (uid) act(button.dataset.extra!, uid.dataset.reorderKey ?? uid.dataset.link!, button);
  });
}

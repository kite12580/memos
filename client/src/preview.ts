import { $ } from "./lib/dom";
import { icon } from "./lib/icon";
import { closeLayer, openDialog } from "./lib/popup";
import { ready, t } from "./editor/strings";

interface Item {
  src: string;
  name: string;
  video: boolean;
}

const MIN = 1;
const MAX = 4;
const STEP = 0.2;
const SWIPE = 60;
const MEDIA = "max-h-[calc(100dvh-8rem)] max-w-[calc(100vw-1.5rem)] rounded-mu-md object-contain sm:max-h-[calc(100dvh-7rem)] sm:max-w-[calc(100vw-8rem)]";

const button = (label: string, name: string, attrs = "") =>
  `<button type="button" aria-label="${label}" ${attrs} class="mu-button mu-button-neutral mu-button-icon mu-base mu-s-md mu-focus">${icon(name, "")}</button>`;

export async function openPreview(from: HTMLElement) {
  await ready;
  const scope = from.closest("[data-card], main") ?? document;
  const sources = [...scope.querySelectorAll<HTMLElement>("[data-action=preview]")];
  const items: Item[] = sources.map((el) => ({ src: el.dataset.src!, name: el.dataset.name ?? "", video: el.hasAttribute("data-video") }));
  let index = Math.max(0, sources.indexOf(from));
  let scale = MIN;
  let pan = { x: 0, y: 0 };
  const many = items.length > 1;
  const wide = matchMedia("(min-width: 640px)").matches;

  const frag = document.createRange().createContextualFragment(
    `<div class="mu-dialog-backdrop" role="presentation"></div><div role="presentation" class="mu-dialog-viewport mu-dialog-full"><div role="dialog" aria-modal="true" aria-labelledby="preview-title" class="mu-dialog-popup mu-dialog-bare mu-popup mu-base mu-s-md"><div class="absolute inset-0 bg-black/92">
<div class="mu-visually-hidden"><h2 id="preview-title" class="mu-dialog-title mu-title" data-title=""></h2><p class="mu-dialog-description mu-body">${t("attachment-preview.description")}</p></div>
<div class="absolute inset-x-0 top-0 z-50 bg-linear-to-b from-black/70 via-black/35 to-transparent px-3 pb-6 pt-3 sm:px-5 sm:pt-4"><div class="flex items-start justify-between gap-3"><div class="min-w-0 text-mu-text" data-theme="dark"><div class="truncate mu-label" data-name=""></div>${many ? '<div class="mt-1 mu-caption text-mu-text-secondary" data-count=""></div>' : ""}</div><div class="flex shrink-0 items-center gap-1.5" data-theme="dark">${button(t("attachment-preview.close"), "x", "data-close")}</div></div></div>
<div class="flex h-full w-full items-center justify-center px-3 pb-20 pt-16 sm:px-16 sm:pb-8 sm:pt-20" data-surface=""><div class="flex max-h-full max-w-full items-center justify-center" data-stage=""></div></div>
<div class="absolute inset-x-0 bottom-0 z-30 px-3 pb-3 pt-6" data-zoombar=""><div data-theme="dark" class="mx-auto flex w-fit items-center gap-1 rounded-full bg-black/60 px-2 py-2 backdrop-blur-sm">${
      many && !wide
        ? `${button(t("attachment-preview.previous"), "chevron-left", "data-prev")}<div class="min-w-9 px-1 text-center mu-label-sm tabular-nums text-mu-text-secondary" data-short=""></div>${button(t("attachment-preview.next"), "chevron-right", "data-next")}<div class="mx-1 h-5 w-px bg-mu-line"></div>`
        : ""
    }${button(t("map.zoom-out"), "zoom-out", "data-out")}<div class="min-w-12 px-2 text-center mu-label-sm tabular-nums text-mu-text-secondary" data-percent=""></div>${button(t("map.zoom-in"), "zoom-in", "data-in")}<div class="mx-1 h-5 w-px bg-mu-line"></div>${button(t("attachment-preview.reset-zoom"), "rotate-ccw", "data-reset")}</div></div>
${many && wide ? `<div data-theme="dark" class="absolute top-1/2 z-20 -translate-y-1/2 left-4">${button(t("attachment-preview.previous"), "chevron-left", "data-prev")}</div><div data-theme="dark" class="absolute top-1/2 z-20 -translate-y-1/2 right-4">${button(t("attachment-preview.next"), "chevron-right", "data-next")}</div>` : ""}
</div></div></div>`,
  );
  const root = openDialog(frag, (root) => {
    const popup = $("[role=dialog]", root)!;
    const surface = $("[data-surface]", root)!;
    const stage = $("[data-stage]", root)!;
    const zoombar = $("[data-zoombar]", root)!;
    let media: HTMLImageElement | HTMLVideoElement;
    let dragging: { id: number; x: number; y: number; px: number; py: number; swipe: boolean } | null = null;

    const setDisabled = (sel: string, off: boolean) => {
      for (const b of root.querySelectorAll<HTMLButtonElement>(sel)) {
        b.disabled = off;
        b.toggleAttribute("data-disabled", off);
      }
    };
    const transform = (dx = 0, animate = true) => {
      media.style.transform = `translate3d(${pan.x + dx}px, ${pan.y}px, 0) scale(${scale})`;
      media.style.transition = animate ? "transform 120ms ease-out" : "none";
      $("[data-percent]", root)!.textContent = `${Math.round(scale * 100)}%`;
      setDisabled("[data-out]", scale === MIN);
      setDisabled("[data-in]", scale === MAX);
      setDisabled("[data-reset]", scale === MIN);
      surface.classList.toggle("cursor-zoom-in", !items[index].video && scale === MIN);
      media.classList.toggle("cursor-grab", scale > MIN || many);
    };
    const clampPan = () => {
      const style = getComputedStyle(surface);
      const w = surface.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
      const h = surface.clientHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom);
      const mx = Math.max(0, (media.offsetWidth * scale - w) / 2);
      const my = Math.max(0, (media.offsetHeight * scale - h) / 2);
      pan = { x: Math.min(mx, Math.max(-mx, pan.x)), y: Math.min(my, Math.max(-my, pan.y)) };
    };
    const zoom = (next: number) => {
      scale = Math.min(MAX, Math.max(MIN, next));
      if (scale === MIN) pan = { x: 0, y: 0 };
      else clampPan();
      transform();
    };
    const show = () => {
      const item = items[index];
      scale = MIN;
      pan = { x: 0, y: 0 };
      media = document.createElement(item.video ? "video" : "img");
      media.className = `${MEDIA}${item.video ? "" : " select-none"}`;
      media.src = item.src;
      if (media instanceof HTMLVideoElement) {
        media.controls = media.autoplay = media.playsInline = true;
      } else {
        media.alt = t("attachment-preview.image-alt").replace("{{index}}", String(index + 1)).replace("{{count}}", String(items.length));
        media.draggable = false;
        media.style.touchAction = "none";
        media.style.transformOrigin = "center center";
      }
      stage.replaceChildren(media);
      zoombar.hidden = item.video;
      const name = item.name || t("attachment-preview.title");
      $("[data-name]", root)!.textContent = name;
      $("[data-title]", root)!.textContent = name;
      const count = $("[data-count]", root);
      if (count) count.textContent = `${index + 1} / ${items.length}`;
      const short = $("[data-short]", root);
      if (short) short.textContent = `${index + 1}/${items.length}`;
      setDisabled("[data-prev]", index === 0);
      setDisabled("[data-next]", index === items.length - 1);
      if (!item.video) transform(0, false);
    };
    const go = (step: number) => {
      const next = Math.min(items.length - 1, Math.max(0, index + step));
      if (next === index) return;
      index = next;
      show();
    };

    popup.addEventListener("keydown", (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        go(e.key === "ArrowLeft" ? -1 : 1);
      }
    });
    popup.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest("[data-close]")) closeLayer(popup);
      else if (target.closest("[data-prev]")) go(-1);
      else if (target.closest("[data-next]")) go(1);
      else if (target.closest("[data-out]")) zoom(scale - STEP);
      else if (target.closest("[data-in]")) zoom(scale + STEP);
      else if (target.closest("[data-reset]")) zoom(MIN);
      else if (target === surface && scale === MIN) closeLayer(popup);
    });
    surface.addEventListener(
      "wheel",
      (e) => {
        if (items[index].video) return;
        e.preventDefault();
        zoom(scale + (e.deltaY < 0 ? STEP : -STEP));
      },
      { passive: false },
    );
    stage.addEventListener("dblclick", () => !items[index].video && zoom(scale === MIN ? 2 : MIN));
    stage.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || items[index].video) return;
      e.preventDefault();
      media.setPointerCapture(e.pointerId);
      dragging = { id: e.pointerId, x: e.clientX, y: e.clientY, px: pan.x, py: pan.y, swipe: scale === MIN };
    });
    stage.addEventListener("pointermove", (e) => {
      if (!dragging || dragging.id !== e.pointerId) return;
      const dx = e.clientX - dragging.x;
      if (dragging.swipe) {
        if (many) transform(dx, false);
        return;
      }
      pan = { x: dragging.px + dx, y: dragging.py + e.clientY - dragging.y };
      clampPan();
      transform(0, false);
    });
    const end = (e: PointerEvent) => {
      if (!dragging || dragging.id !== e.pointerId) return;
      const dx = e.clientX - dragging.x;
      const dy = e.clientY - dragging.y;
      const swipe = dragging.swipe;
      dragging = null;
      if (swipe && many && Math.abs(dx) > SWIPE && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
      else transform();
    };
    stage.addEventListener("pointerup", end);
    stage.addEventListener("pointercancel", end);
    show();
  });
  root && $<HTMLElement>("[data-close]", root)?.focus();
}

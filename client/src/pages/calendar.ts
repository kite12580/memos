// The calendar page: fits each day's preview to the cell size as memos'
// layoutForCellSize does, the month picker, arrow-key moves between days, the
// open day's panel beside the grid, and on phones the chosen day's memos under it.

import { initClamps } from "../lib/cards";
import { $, $$, base, fromHTML, fromTemplate, go, request } from "../lib/dom";
import { closeAll, enter, isOpenFor, openPopup } from "../lib/popup";
import { formatTimes } from "../lib/time";
import { toastError } from "../lib/toast";

export default function init(signal: AbortSignal) {
  const LINE_HEIGHT = 18;
  const IMAGE_SIZE = 36;
  const IMAGE_GAP = 4;
  const HEADER_HEIGHT = 48;
  const HORIZONTAL_PADDING = 24;
  const PREVIEW_MIN_CELL_WIDTH = 100;
  const SLIM_MIN_CELL_WIDTH = 64;

  const root = $("[data-page=calendar]")!;
  const cells = $("[data-cells]", root)!;

  function layoutFor(width: number, height: number) {
    const compact = width < SLIM_MIN_CELL_WIDTH;
    const slim = !compact && width < PREVIEW_MIN_CELL_WIDTH;
    const available = Math.max(0, height - HEADER_HEIGHT);
    const showImages = !compact && available >= IMAGE_SIZE;
    return {
      textLines: compact ? 0 : Math.min(slim ? 2 : 3, Math.floor(available / LINE_HEIGHT)),
      textLinesWithImages: showImages ? Math.min(slim ? 1 : 2, Math.floor((available - IMAGE_SIZE - IMAGE_GAP) / LINE_HEIGHT)) : 0,
      imageCount: !showImages ? 0 : slim ? 1 : Math.min(3, Math.max(1, Math.floor((width - HORIZONTAL_PADDING + IMAGE_GAP) / (IMAGE_SIZE + IMAGE_GAP)))),
      slim,
      mark: compact || (!showImages && available < LINE_HEIGHT),
    };
  }

  let last = "";

  function fit() {
    const rows = Math.ceil(cells.children.length / 7);
    const md = matchMedia("(min-width: 48rem)").matches;
    const l = layoutFor(cells.clientWidth / 7, md ? cells.clientHeight / rows : 0);
    const key = JSON.stringify(l);
    if (key === last) return;
    last = key;
    for (const cell of cells.children as HTMLCollectionOf<HTMLElement>) {
      cell.classList.toggle("sm:px-2", l.slim);
      const mark = $("[data-mark]", cell);
      if (mark) {
        mark.classList.remove("md:hidden");
        mark.hidden = !l.mark;
      }
      const preview = $("[data-preview]", cell);
      if (!preview) continue;
      preview.classList.remove("max-md:hidden");
      const images = $$("img", preview);
      images.forEach((img, i) => (img.hidden = i >= l.imageCount));
      const strip = images[0]?.parentElement;
      const showImages = l.imageCount > 0 && images.length > 0;
      if (strip) strip.hidden = !showImages;
      const lines = showImages ? l.textLinesWithImages : l.textLines;
      const excerpt = $("[data-excerpt]", preview);
      if (excerpt) {
        excerpt.hidden = lines <= 0;
        excerpt.style.setProperty("-webkit-line-clamp", String(lines));
      }
      preview.hidden = !showImages && (!excerpt || lines <= 0);
    }
  }

  const resized = new ResizeObserver(fit);
  resized.observe(cells);
  signal.addEventListener("abort", () => resized.disconnect());

  const monthNames = Array.from({ length: 12 }, (_, i) =>
    new Date(2000, i, 1).toLocaleString(document.documentElement.lang || "en", { month: "short" }),
  );

  function openPicker(trigger: HTMLElement) {
    const popup = fromTemplate("tpl-month-picker")?.firstElementChild as HTMLElement | null;
    if (!popup) return;
    let year = Number(root.dataset.month!.slice(0, 4));
    const label = $("[data-year-label]", popup)!;
    const links = $$<HTMLAnchorElement>("a", popup);
    const dot = links.flatMap((a) => $$("span", a))[0];
    const render = () => {
      label.textContent = String(year);
      links.forEach((a, i) => {
        const key = `${year}-${String(i + 1).padStart(2, "0")}`;
        a.href = `${base}/calendar/${key}`;
        a.textContent = monthNames[i];
        if (key === root.dataset.month) a.setAttribute("aria-current", "page");
        else a.removeAttribute("aria-current");
        if (dot && key === root.dataset.current) a.append(dot);
      });
      if (dot && !links.some((a) => a.contains(dot))) dot.remove();
    };
    popup.addEventListener("click", (e) => {
      const step = (e.target as HTMLElement).closest<HTMLElement>("[data-year]");
      if (!step) return;
      year += Number(step.dataset.year);
      render();
    });
    render();
    openPopup(trigger, popup, "bottom", "start");
  }

  const trigger = $("[data-month-picker]", root)!;
  trigger.addEventListener("click", () => (isOpenFor(trigger) ? closeAll() : openPicker(trigger)));

  const KEY_DELTAS: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };

  cells.addEventListener("keydown", (e) => {
    const days = [...cells.children] as HTMLElement[];
    const at = days.indexOf(e.target as HTMLElement);
    if (at < 0) return;
    let next = -1;
    if (e.key in KEY_DELTAS) {
      const rtl = document.documentElement.dir === "rtl" && (e.key === "ArrowLeft" || e.key === "ArrowRight");
      next = at + KEY_DELTAS[e.key] * (rtl ? -1 : 1);
    } else if (e.key === "Home" || e.key === "End") {
      const month = root.dataset.month!;
      const inMonth = days.filter((d) => d.dataset.calendarDate!.startsWith(month));
      next = days.indexOf(e.key === "Home" ? inMonth[0] : inMonth[inMonth.length - 1]);
    }
    if (next < 0 || next >= days.length) return;
    e.preventDefault();
    days[next].focus();
  });

  const OPEN_BADGE = "inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-mu-md px-[5px] bg-mu-text/10 text-mu-text";
  const OPEN_TODAY_HALO = "-m-[3px] inline-flex rounded-[9px] bg-mu-text/10 p-[3px]";
  const phone = matchMedia("(max-width: 47.98rem)");
  const lang = document.documentElement.lang || "en";

  function select(cell: HTMLElement | null) {
    for (const day of cells.children as HTMLCollectionOf<HTMLElement>) {
      const open = day === cell;
      const numeral = $("[data-numeral]", day)!;
      numeral.dataset.class ??= numeral.className;
      const today = numeral.dataset.class.includes("bg-mu-primary");
      const halo = numeral.parentElement!.matches("[data-halo]") ? numeral.parentElement! : null;
      numeral.className = open && !today ? `mu-caption tabular-nums ${OPEN_BADGE}` : numeral.dataset.class;
      if (open && today && !halo) {
        const wrap = document.createElement("span");
        wrap.className = OPEN_TODAY_HALO;
        wrap.dataset.halo = "";
        numeral.replaceWith(wrap);
        wrap.append(numeral);
      } else if (!(open && today) && halo) halo.replaceWith(numeral);
      if (open) day.setAttribute("aria-current", "page");
      else day.removeAttribute("aria-current");
      if (cell) day.tabIndex = open ? 0 : -1;
    }
  }

  let shown = "";

  async function showDay(cell: HTMLElement) {
    const date = cell.dataset.calendarDate!;
    if (date === shown) return;
    shown = date;
    select(cell);
    const label = new Date(`${date}T00:00:00`).toLocaleDateString(lang, { weekday: "long", month: "long", day: "numeric" });
    let section = $<HTMLElement>("[data-day-memos]", root);
    if (!section) {
      section = document.createElement("section");
      section.className = "mt-4 flex w-full flex-col md:hidden";
      section.dataset.dayMemos = "";
      section.innerHTML = '<header class="mb-3 border-b border-mu-line/70 pb-3"><h2 class="truncate mu-title text-mu-text"></h2></header><div></div>';
      root.append(section);
    }
    section.setAttribute("aria-label", label);
    $("h2", section)!.textContent = label;
    try {
      const res = await fetch(`${base}/f/memos?scope=home&q=${encodeURIComponent(`on:${date}`)}`);
      if (!res.ok) throw new Error(res.statusText);
      const list = fromHTML(await res.text());
      list.querySelector("[data-next]")?.remove();
      if (date !== shown) return;
      const holder = section.lastElementChild as HTMLElement;
      holder.replaceChildren(list);
      if (!holder.children.length) holder.innerHTML = `<p class="py-8 text-center mu-body text-mu-text-secondary">${root.dataset.empty}</p>`;
      formatTimes(holder);
      initClamps(holder);
      document.dispatchEvent(new CustomEvent("memos:cards"));
    } catch (e) {
      toastError(e);
    }
  }

  const PANEL_GAP = "xl:pe-[calc(var(--memo-panel-width)+12px)]";
  const panel = () => $<HTMLElement>("[data-day-panel]");
  const cellFor = (date: string) => $<HTMLElement>(`[data-calendar-date="${date}"]`, cells);
  let opening = "";

  async function openPanel(date: string, push: boolean) {
    const cell = cellFor(date);
    if (!cell || !date.startsWith(root.dataset.month!)) return go(`${base}/calendar/${date}`);
    if (push) history.pushState(null, "", `${base}/calendar/${date}`);
    opening = date;
    select(cell);
    try {
      const next = fromHTML(await (await request(`/f/day?d=${date}`)).text()).firstElementChild as HTMLElement;
      if (opening !== date) return;
      const old = panel();
      if (old) old.replaceWith(next);
      else {
        root.parentElement!.after(next);
        enter(next);
      }
      root.classList.add(PANEL_GAP);
      formatTimes(next);
      initClamps(next);
      document.dispatchEvent(new CustomEvent("memos:cards"));
    } catch (e) {
      toastError(e);
    }
  }

  function closePanel(push: boolean) {
    if (push) history.pushState(null, "", `${base}/calendar/${root.dataset.month}`);
    opening = "";
    select(null);
    root.classList.remove(PANEL_GAP);
    const el = panel();
    if (!el) return;
    el.removeAttribute("data-day-panel");
    el.setAttribute("data-ending-style", "");
    setTimeout(() => el.remove(), 200);
  }

  cells.addEventListener("click", (e) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>("[data-calendar-date]");
    if (!cell || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
    e.preventDefault();
    if (phone.matches) return void showDay(cell);
    if (cell.dataset.calendarDate !== panel()?.dataset.dayPanel) void openPanel(cell.dataset.calendarDate!, true);
  });

  $("[data-today]", root)?.addEventListener("click", (e) => {
    const today = cellFor(root.dataset.today!);
    if (!today || phone.matches || root.dataset.month !== root.dataset.current) return;
    e.preventDefault();
    if (panel()?.dataset.dayPanel === root.dataset.today) closePanel(true);
    else void openPanel(root.dataset.today!, true);
  });

  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest("[data-close-day]")) {
      e.preventDefault();
      return closePanel(true);
    }
    const compose = target.closest<HTMLElement>("[data-day-compose]");
    if (!compose) return;
    const holder = compose.nextElementSibling as HTMLElement;
    compose.hidden = true;
    holder.hidden = false;
    void import("../editor/index").then((m) => m.activate($("[data-composer]", holder)!));
  }, { signal });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !e.defaultPrevented && panel() && !$(".mu-positioner, .mu-dialog-viewport")) closePanel(true);
  }, { signal });

  document.addEventListener(
    "memos:pop",
    (e) => {
      const path = location.pathname.slice(base.length);
      const day = /^\/calendar\/(\d{4}-\d{2}-\d{2})$/.exec(path)?.[1];
      const month = day?.slice(0, 7) ?? /^\/calendar\/(\d{4}-\d{2})$/.exec(path)?.[1] ?? (path === "/calendar" ? root.dataset.current : "");
      if (month !== root.dataset.month || phone.matches) return;
      e.preventDefault();
      if (day) void openPanel(day, false);
      else closePanel(false);
    },
    { signal },
  );

  document.addEventListener(
    "memos:calendar",
    () => {
      last = "";
      fit();
    },
    { signal },
  );

  if (phone.matches) void showDay($<HTMLElement>('[tabindex="0"]', cells)!);
}

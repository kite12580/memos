import { $, $$, fromHTML } from "./dom";
import { formatTimes } from "./time";
import { initClamps } from "./cards";
import { toastError } from "./toast";

declare global {
  interface Window {
    __grid?: () => void;
  }
}

const list = () => $("#memo-list");

/** Lays the cards out in columns again, as the page's inline script first did. */
export function layoutGrid() {
  window.__grid?.();
}

/** Appends cards to the list, or to the shortest grid column. */
function append(cards: HTMLElement[]) {
  const l = list()!;
  const cols = $$("[data-col]", l);
  let index = Math.max(-1, ...$$("[data-i]", l).map((e) => Number(e.dataset.i))) + 1;
  for (const card of cards) {
    if (!cols.length) {
      l.append(card);
      continue;
    }
    card.classList.remove("mb-2");
    card.dataset.i = String(index++);
    cols.reduce((a, b) => (b.offsetHeight < a.offsetHeight ? b : a)).append(card);
  }
}

let loading = false;

async function loadMore(sentinel: HTMLElement, observer: IntersectionObserver) {
  if (loading) return;
  loading = true;
  observer.unobserve(sentinel);
  try {
    const res = await fetch(sentinel.dataset.next!);
    if (!res.ok) throw new Error(res.statusText);
    const frag = fromHTML(await res.text());
    const next = frag.querySelector<HTMLElement>("[data-next]");
    const cards = [...frag.children].filter((c) => c !== next) as HTMLElement[];
    sentinel.remove();
    append(cards);
    for (const c of cards) {
      formatTimes(c);
      initClamps(c);
    }
    if (next) {
      list()!.append(next);
      observer.observe(next);
    }
    document.dispatchEvent(new CustomEvent("memos:cards"));
  } catch (e) {
    toastError(e);
    observer.observe(sentinel);
  } finally {
    loading = false;
  }
}

export function initList() {
  const l = list();
  if (!l) return;
  const observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) loadMore(e.target as HTMLElement, observer);
    },
    { rootMargin: "800px 0px" },
  );
  const sentinel = $("[data-next]", l);
  if (sentinel) observer.observe(sentinel);
  if (l.dataset.layout !== "list") {
    let width = l.clientWidth;
    addEventListener("resize", () => {
      if (Math.abs(l.clientWidth - width) > 20) {
        width = l.clientWidth;
        layoutGrid();
      }
    });
  }
}

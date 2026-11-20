// memos' reaction picker (MemoReactionListView/ReactionSelector.tsx): a search
// box over the emoji grid, eight to a row, drawing only the rows in view.

import { icon } from "./lib/icon";
import { closeAll, listNav, openPopup } from "./lib/popup";
import { findEmoji } from "./memos/emoji";
import { ready, t } from "./editor/strings";

const COLUMNS = 8;
const ROW = 34;
const HEIGHT = 240;

export async function openPicker(trigger: HTMLElement, reacted: string[], pick: (emoji: string) => void) {
  await ready;
  const popup = document.createElement("div");
  popup.setAttribute("role", "dialog");
  popup.setAttribute("aria-label", t("memo.add-reaction"));
  popup.className = "mu-popover-popup mu-popup mu-popup-motion mu-base mu-s-md max-w-[calc(100vw-2rem)] p-[calc(var(--mu-space-3)-1px)] transition-none";
  popup.style.width = `calc(${COLUMNS} * var(--mu-row-height) + ${COLUMNS - 1} * var(--mu-inset) + 2 * var(--mu-space-3))`;
  popup.innerHTML = `<div class="flex min-w-0 flex-col gap-2"><div role="group" class="mu-input-root mu-base mu-s-md"><span class="mu-input-prefix">${icon("search", "")}</span><input autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="none" class="mu-input"></div><div role="grid" tabindex="-1" class="mu-combobox-list h-60 p-0 overflow-y-auto"><div role="presentation" class="relative"></div></div></div>`;
  const input = popup.querySelector("input")!;
  input.placeholder = t("space.icon.search-emoji");
  input.setAttribute("aria-label", input.placeholder);
  const list = popup.querySelector<HTMLElement>("[role=grid]")!;
  list.setAttribute("aria-label", t("space.icon.emoji"));
  const canvas = list.firstElementChild as HTMLElement;
  let options = findEmoji("");

  const draw = () => {
    const rows = Math.ceil(options.length / COLUMNS);
    canvas.style.height = `${rows * ROW}px`;
    const first = Math.max(0, Math.floor(list.scrollTop / ROW) - 2);
    const last = Math.min(rows, first + Math.ceil(HEIGHT / ROW) + 4);
    let html = "";
    for (let r = first; r < last; r++) {
      html += `<div role="row" class="mu-combobox-row absolute inset-x-0 grid" style="top:${r * ROW}px;margin-top:0;grid-template-columns:repeat(${COLUMNS},minmax(0,1fr))">`;
      for (const o of options.slice(r * COLUMNS, (r + 1) * COLUMNS)) {
        const on = reacted.includes(o.emoji);
        html += `<div role="gridcell" data-emoji="${o.emoji}" aria-label="${o.name}" aria-selected="${on}"${on ? " data-selected" : ""} class="mu-combobox-item" style="width:100%"><span class="mu-combobox-item-text"><span class="inline-flex size-5 items-center justify-center text-xl" aria-hidden="true">${o.emoji}</span></span><span class="mu-combobox-indicator">${on ? icon("check", "") : ""}</span></div>`;
      }
      html += "</div>";
    }
    canvas.innerHTML = rows ? html : `<div role="status" class="mu-combobox-empty mu-body">${t("space.icon.no-results")}</div>`;
  };

  input.addEventListener("input", () => {
    options = findEmoji(input.value);
    list.scrollTop = 0;
    draw();
    nav.highlight(input.value ? (canvas.querySelector<HTMLElement>("[data-emoji]") ?? undefined) : undefined);
  });
  list.addEventListener("scroll", draw, { passive: true });
  list.addEventListener("click", (e) => {
    choose((e.target as HTMLElement).closest<HTMLElement>("[data-emoji]")?.dataset.emoji);
  });
  const choose = (emoji: string | undefined) => {
    if (!emoji) return;
    closeAll();
    pick(emoji);
  };
  const nav = listNav(list, input, () => [...canvas.querySelectorAll<HTMLElement>("[data-emoji]")], (c) => choose(c?.dataset.emoji), {
    steps: { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLUMNS, ArrowUp: -COLUMNS },
  });
  openPopup(trigger, popup, "bottom", "start");
  draw();
  input.focus({ preventScroll: true });
}

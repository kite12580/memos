// The reaction picker: memos' quick reactions, and the editor's emoji search
// for anything else. Loaded on first use.

import { openPopup, closeAll } from "./lib/popup";

const QUICK = ["👍", "👎", "😄", "🎉", "😕", "❤️", "🚀", "👀", "🔥", "💯", "🙏", "✅"];

export function openPicker(trigger: HTMLElement, pick: (emoji: string) => void) {
  const popup = document.createElement("div");
  popup.setAttribute("role", "dialog");
  popup.className = "mu-popover-popup mu-popup mu-popup-motion mu-base mu-s-md";
  popup.innerHTML = `<div class="grid grid-cols-6 gap-0.5">${QUICK.map(
    (e) => `<button type="button" data-emoji="${e}" class="mu-button mu-button-ghost mu-button-icon mu-base mu-s-md mu-focus text-lg leading-none">${e}</button>`,
  ).join("")}</div>`;
  popup.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-emoji]");
    if (!b) return;
    closeAll();
    pick(b.dataset.emoji!);
  });
  openPopup(trigger, popup, "bottom", "end");
}

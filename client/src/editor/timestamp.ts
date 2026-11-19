import { openPopup, closeAll } from "../lib/popup";
import type { Session } from "./index";

const pad = (n: number) => String(n).padStart(2, "0");

/** memos' created-time popover: a date and time field for backdating a memo. */
export function openTimestamp(trigger: HTMLElement, session: Session, onChange: () => void) {
  const d = new Date((session.createdTs ?? Date.now() / 1000) * 1000);
  const value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const popup = document.createElement("div");
  popup.setAttribute("role", "dialog");
  popup.className = "mu-popover-popup mu-popup mu-popup-motion mu-base mu-s-md";
  popup.innerHTML = `<span class="mu-input-root mu-base mu-s-md"><input type="datetime-local" class="mu-input" step="1"></span>`;
  const input = popup.querySelector("input")!;
  input.value = value;
  input.addEventListener("change", () => {
    const ts = new Date(input.value).getTime();
    if (!Number.isNaN(ts)) {
      session.createdTs = Math.floor(ts / 1000);
      onChange();
    }
  });
  input.addEventListener("keydown", (e) => e.key === "Enter" && closeAll());
  openPopup(trigger, popup, "bottom", "start");
}

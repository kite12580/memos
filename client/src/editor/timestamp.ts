import { openPopup } from "../lib/popup";
import { t } from "./strings";
import type { Session } from "./index";

const FORMAT = "YYYY-MM-DD HH:mm:ss";
const pad = (n: number) => String(n).padStart(2, "0");

const format = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

function parse(value: string): Date | undefined {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m || Number(m[1]) === 0) return undefined;
  const d = new Date(0);
  d.setFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setHours(Number(m[4]), Number(m[5]), Number(m[6]), 0);
  return format(d) === value ? d : undefined;
}

export function openTimestamp(trigger: HTMLElement, session: Session, onChange: () => void) {
  const popup = document.createElement("div");
  popup.setAttribute("role", "dialog");
  popup.className = "mu-popover-popup mu-popup mu-popup-motion mu-base mu-s-md w-auto";
  const field = (label: string, ts: number | undefined, set: (ts: number) => void) => {
    const initial = ts ? format(new Date(ts * 1000)) : "";
    const root = document.createElement("div");
    root.className = "mu-field-root";
    root.innerHTML = `<label class="mu-field-label mu-label"></label><span class="mu-input-root mu-base mu-s-md"><input type="text" class="mu-input font-mono" placeholder="${FORMAT}"></span>`;
    const name = root.querySelector("label")!;
    name.textContent = label;
    const input = root.querySelector("input")!;
    input.value = initial;
    input.setAttribute("aria-label", label);
    input.addEventListener("input", () => {
      root.removeAttribute("data-invalid");
      input.removeAttribute("aria-invalid");
      name.querySelector("span")?.remove();
      if (input.value !== initial) name.insertAdjacentHTML("beforeend", '<span class="text-mu-primary ml-0.5">*</span>');
      const d = parse(input.value);
      if (d) set(Math.floor(d.getTime() / 1000));
    });
    input.addEventListener("blur", () => {
      const bad = !parse(input.value);
      root.toggleAttribute("data-invalid", bad);
      input.setAttribute("aria-invalid", String(bad));
    });
    return root;
  };
  popup.append(
    field(t("common.created-at"), session.createdTs, (ts) => {
      session.createdTs = ts;
      onChange();
    }),
    field(t("common.last-updated-at"), session.updatedTs, (ts) => (session.updatedTs = ts)),
  );
  openPopup(trigger, popup, "bottom", "start");
}

import { $$, strings } from "./dom";

const lang = strings.lang || document.documentElement.lang || "en";
const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
const DAY = 86400e3;

const dateFormat = (sameYear: boolean) =>
  new Intl.DateTimeFormat(lang, sameYear ? { weekday: "short", month: "short", day: "numeric" } : { weekday: "short", month: "short", day: "numeric", year: "numeric" });

/** "now", "5 minutes ago" within a day, then "Tue, Nov 17", as memos' relative-time shows. */
export function relative(date: Date, now = Date.now()): string {
  const diff = now - date.getTime();
  if (diff < DAY && diff >= 0) {
    const s = Math.floor(diff / 1000);
    if (s < 60) return rtf.format(0, "second");
    if (s < 3600) return rtf.format(-Math.floor(s / 60), "minute");
    return rtf.format(-Math.floor(s / 3600), "hour");
  }
  return dateFormat(date.getFullYear() === new Date(now).getFullYear()).format(date);
}

const formats: Record<string, Intl.DateTimeFormat> = {
  month: new Intl.DateTimeFormat(lang, { month: "long", year: "numeric" }),
  short: new Intl.DateTimeFormat(lang, { month: "short", day: "numeric" }),
  date: new Intl.DateTimeFormat(lang, { month: "short", day: "numeric", year: "numeric" }),
  "month-short": new Intl.DateTimeFormat(lang, { month: "short", year: "numeric" }),
};

/** Formats the `<time>` elements the server wrote in English. */
export function formatTimes(root: ParentNode = document) {
  for (const el of $$<HTMLTimeElement>("time[data-rel], time[data-fmt]", root)) {
    const date = new Date(el.dateTime.length === 7 ? `${el.dateTime}-01T00:00:00` : el.dateTime);
    if (Number.isNaN(date.getTime())) continue;
    const fmt = el.dataset.fmt;
    const text = fmt && formats[fmt] ? formats[fmt].format(date) : relative(date);
    if (el.textContent !== text) el.textContent = text;
  }
}

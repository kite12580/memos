import { request } from "../lib/dom";

let strings: Record<string, string> = {};

/** The client's UI strings in the page's language, loaded once. */
export const ready = request("/f/strings")
  .then((r) => r.json())
  .then((s) => {
    strings = s;
  })
  .catch(() => undefined);

export const t = (key: string) => strings[key] ?? key;

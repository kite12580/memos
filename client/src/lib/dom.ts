export const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);
export const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll<T>(sel)];

declare global {
  interface Window {
    __navigate?: (url: string, replace?: boolean) => Promise<void>;
  }
}

/** Opens `url`, in place once the navigator (nav.ts) has loaded. */
export const go = (url: string) => (window.__navigate ? void window.__navigate(url) : location.assign(url));

/** Shows the page again as the server has it now, in place and at the same scroll position when it can. */
export const reload = () => (window.__navigate ? void window.__navigate(location.href, true) : location.reload());

/** The app's path prefix, `""` or `/memos`. */
export const base = document.body.dataset.base ?? "";

export const strings: Record<string, string> = JSON.parse($("#strings")?.textContent || "{}");

export const fromHTML = (html: string): DocumentFragment => {
  const t = document.createElement("template");
  t.innerHTML = html;
  return t.content;
};

export const fromTemplate = (id: string): DocumentFragment | null => {
  const t = document.getElementById(id) as HTMLTemplateElement | null;
  return t ? (t.content.cloneNode(true) as DocumentFragment) : null;
};

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Fetches a path under the app's prefix; throws on an error status. */
export async function request(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const { json, ...rest } = init;
  if (json !== undefined) {
    rest.method ??= "POST";
    rest.body = JSON.stringify(json);
    rest.headers = { "content-type": "application/json", ...(rest.headers as Record<string, string>) };
  }
  const res = await fetch(base + path, rest);
  if (!res.ok) {
    let message = res.statusText;
    try {
      message = (await res.clone().json()).error ?? message;
    } catch {
      message = (await res.text()) || message;
    }
    throw new HttpError(res.status, message);
  }
  return res;
}

export const post = (path: string, json: unknown = {}) => request(path, { json });

export const idle = (fn: () => void) =>
  "requestIdleCallback" in window ? requestIdleCallback(fn, { timeout: 2000 }) : setTimeout(fn, 200);

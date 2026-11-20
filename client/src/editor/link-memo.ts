import { request } from "../lib/dom";
import { icon } from "../lib/icon";
import { closeLayer, openDialog } from "../lib/popup";
import type { Session } from "./index";

interface Link {
  uid: string;
  snippet: string;
  createdTs: number;
}

/** Search memos by text and link the picked one, as memos' Link memo dialog does. */
export function openLinkMemo(session: Session, t: (k: string) => string) {
  const frag = document.createRange().createContextualFragment(
    `<div class="mu-dialog-backdrop" role="presentation"></div><div role="presentation" class="mu-dialog-viewport"><div role="dialog" aria-labelledby="link-memo-title" aria-describedby="link-memo-description" class="mu-dialog-popup mu-dialog-bare mu-popup mu-base mu-s-md w-md"><h2 id="link-memo-title" class="mu-dialog-title mu-title mu-visually-hidden"></h2><p id="link-memo-description" class="mu-dialog-description mu-body mu-visually-hidden"></p><div class="flex flex-col"><div class="p-3"><span class="mu-input-root mu-base mu-s-md"><input class="mu-input" autocomplete="off"></span></div><div class="border-t border-mu-line"></div><div class="max-h-[320px] overflow-y-auto" data-results=""></div></div></div></div>`,
  );
  openDialog(frag, (root) => {
    root.querySelector("h2")!.textContent = t("tooltip.link-memo");
    root.querySelector("p")!.textContent = t("tooltip.link-memo-description");
    const input = root.querySelector("input")!;
    input.placeholder = t("reference.search-placeholder");
    input.setAttribute("aria-label", input.placeholder);
    const results = root.querySelector<HTMLElement>("[data-results]")!;
    let timer = 0;
    let latest = 0;
    const row = (l: Link) => {
      const linked = session.relations.some((r) => r.uid === l.uid);
      const el = document.createElement("div");
      el.className = `flex cursor-pointer items-start border-b border-mu-line last:border-b-0 px-3 py-2.5 hover:bg-mu-hover/50 transition-colors mu-focus${linked ? " opacity-40 cursor-default" : ""}`;
      el.innerHTML = `<div class="w-full flex flex-col gap-1"><div class="flex items-center gap-1.5 mu-body text-mu-text-secondary select-none">${linked ? icon("link", "mu-icon-xs shrink-0") : ""}<span data-date=""></span></div><div class="pointer-events-none flex flex-col gap-1"><div class="flex min-w-0 shrink-0 items-center gap-1.5 mu-caption text-mu-text-secondary"><span class="shrink-0 font-mono mu-caption text-mu-text-secondary/60"></span></div><div class="max-h-36 w-full overflow-hidden mu-body text-mu-text" data-snippet=""></div></div></div>`;
      el.querySelector("[data-date]")!.textContent = new Date(l.createdTs * 1000).toLocaleString();
      el.querySelector(".font-mono")!.textContent = l.uid.slice(0, 6);
      el.querySelector("[data-snippet]")!.textContent = l.snippet;
      if (!linked) {
        el.tabIndex = -1;
        el.dataset.link = "";
        el.addEventListener("click", () => {
          session.relations.push(l);
          session.renderExtras();
          closeLayer(root);
        });
      }
      return el;
    };
    const search = async () => {
      const id = ++latest;
      const exclude = session.uid ? `&exclude=${session.uid}` : "";
      const res = await request(`/f/links?q=${encodeURIComponent(input.value)}${exclude}`).catch(() => null);
      if (!res) return;
      const links: Link[] = await res.json();
      if (id !== latest) return;
      if (links.length) results.replaceChildren(...links.map(row));
      else results.innerHTML = `<div class="py-8 text-center mu-body text-mu-text-secondary">${t("reference.no-memos-found")}</div>`;
    };
    let current = search();
    const settle = () => {
      if (timer) {
        clearTimeout(timer);
        timer = 0;
        current = search();
      }
      return current;
    };
    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = window.setTimeout(settle, 200);
    });
    root.addEventListener("keydown", async (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        await settle();
        const rows = [...results.querySelectorAll<HTMLElement>("[data-link]")];
        const next = rows.indexOf(document.activeElement as HTMLElement) + (e.key === "ArrowDown" ? 1 : -1);
        if (next < 0) input.focus();
        else rows[Math.min(next, rows.length - 1)]?.focus();
      } else if (e.key === "Enter") {
        const active = document.activeElement as HTMLElement;
        if (active !== input && !active.matches("[data-link]")) return;
        e.preventDefault();
        await settle();
        (active === input ? results.querySelector<HTMLElement>("[data-link]") : active)?.click();
      }
    });
  });
}

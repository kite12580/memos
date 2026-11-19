import { request } from "../lib/dom";
import { icon } from "../lib/icon";
import { closeDialog, openDialog } from "../lib/popup";
import type { Session } from "./index";

/** Search memos by text and link the picked one, as memos' Link memo dialog does. */
export function openLinkMemo(session: Session, t: (k: string) => string) {
  let template = document.getElementById("tpl-link-memo") as HTMLTemplateElement | null;
  if (!template) {
    template = document.createElement("template");
    template.id = "tpl-link-memo";
    template.innerHTML = `<div class="mu-dialog-backdrop" data-open="" role="presentation"></div><div data-open="" role="presentation" class="mu-dialog-viewport"><div data-open="" role="dialog" class="mu-dialog-popup mu-dialog-bare mu-popup mu-base mu-s-md w-lg self-start mt-[max(0px,calc(12vh-var(--mu-space-6)))]"><h2 class="mu-dialog-title mu-title px-4 pt-4"></h2><div class="px-4 py-3"><span class="mu-input-root mu-base mu-s-md"><span class="mu-input-prefix">${icon("search", "")}</span><input class="mu-input" autocomplete="off"></span></div><div class="flex max-h-80 flex-col gap-0.5 overflow-y-auto px-2 pb-3" data-results=""></div></div></div>`;
    document.body.append(template);
  }
  openDialog("tpl-link-memo", (root) => {
    root.querySelector("h2")!.textContent = t("editor.insert-menu.link-memo");
    const input = root.querySelector("input")!;
    input.placeholder = t("common.search");
    const results = root.querySelector<HTMLElement>("[data-results]")!;
    let timer = 0;
    let latest = 0;
    const search = async () => {
      const id = ++latest;
      const exclude = session.uid ? `&exclude=${session.uid}` : "";
      const res = await request(`/f/links?q=${encodeURIComponent(input.value)}${exclude}`).catch(() => null);
      if (!res) return;
      const links: { uid: string; snippet: string }[] = await res.json();
      if (id !== latest) return;
      results.replaceChildren(
        ...links
          .filter((l) => !session.relations.some((r) => r.uid === l.uid))
          .map((l) => {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "flex h-8 w-full min-w-0 items-center gap-2 rounded-mu-md px-2 text-start mu-caption text-mu-text-secondary hover:bg-mu-hover hover:text-mu-text mu-focus border border-transparent";
            b.innerHTML = `${icon("link", "mu-icon-sm shrink-0")}<span class="min-w-0 flex-1 truncate"></span>`;
            b.querySelector("span")!.textContent = l.snippet || l.uid;
            b.addEventListener("click", () => {
              session.relations.push(l);
              session.renderExtras();
              closeDialog(root);
            });
            return b;
          }),
      );
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
        const buttons = [...results.querySelectorAll<HTMLButtonElement>("button")];
        const next = buttons.indexOf(document.activeElement as HTMLButtonElement) + (e.key === "ArrowDown" ? 1 : -1);
        if (next < 0) input.focus();
        else buttons[Math.min(next, buttons.length - 1)]?.focus();
      } else if (e.key === "Enter" && document.activeElement === input) {
        e.preventDefault();
        await settle();
        results.querySelector("button")?.click();
      }
    });
  });
}

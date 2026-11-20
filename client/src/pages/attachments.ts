// The attachment library: more of a section as it scrolls into view, and
// deleting every unused upload.

import { $, $$, fromHTML, post, reload } from "../lib/dom";
import { closeDialog, openDialog } from "../lib/popup";
import { formatTimes } from "../lib/time";
import { toast, toastError } from "../lib/toast";

export default function init(signal: AbortSignal) {
  const root = $("[data-page=attachments]")!;

  /** Appends a page's parts to the sections on the page; a month that continues joins its group. */
  function append(frag: DocumentFragment) {
    for (const part of $$("[data-part]", frag)) {
      const target = $(`[data-part="${part.dataset.part}"]`, root);
      if (!target) continue;
      const groups = $$<HTMLElement>(":scope > [data-month]", part);
      const last = $$<HTMLElement>(":scope > [data-month]", target).pop();
      if (groups.length && last && groups[0].dataset.month === last.dataset.month) {
        $(".grid", last)!.append(...$(".grid", groups[0])!.children);
        groups[0].remove();
      }
      target.append(...part.children);
      formatTimes(target);
    }
  }

  let loading = false;

  async function more(button: HTMLElement) {
    if (loading) return;
    loading = true;
    observer.unobserve(button);
    try {
      const res = await fetch(button.dataset.next!);
      if (!res.ok) throw new Error(res.statusText);
      const frag = fromHTML(await res.text());
      const next = $("[data-more]", frag);
      next?.remove();
      append(frag);
      const wrap = button.closest("[data-more]")!;
      if (next) wrap.replaceWith(next);
      else wrap.remove();
      if (next) observe();
    } catch (e) {
      toastError(e);
    } finally {
      loading = false;
    }
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) void more(e.target as HTMLElement);
    },
    { rootMargin: "600px 0px" },
  );
  signal.addEventListener("abort", () => observer.disconnect());

  function observe() {
    const button = $("[data-next]", root);
    if (button) observer.observe(button);
  }

  function confirmDeleteUnused(button: HTMLElement) {
    openDialog("tpl-confirm", (dialog) => {
      $("[data-slot=title]", dialog)!.textContent = button.dataset.title!;
      $("[data-slot=description]", dialog)!.textContent = button.dataset.description!;
      $("[data-action=dialog-ok]", dialog)!.addEventListener("click", async () => {
        closeDialog(dialog);
        try {
          for (const row of $$("[data-unused]", root)) await post(`/attachments/${row.dataset.unused}/delete`);
          toast(button.dataset.done!);
          reload();
        } catch (e) {
          toastError(e);
        }
      });
    });
  }

  root.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const next = target.closest<HTMLElement>("[data-next]");
    if (next) return void more(next);
    const del = target.closest<HTMLElement>("[data-delete-unused]");
    if (del) confirmDeleteUnused(del);
  });

  observe();
}

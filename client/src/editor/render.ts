// Renders a memo's Markdown to the HTML the server stores, with memos' own
// editor in read-only mode, so a saved card is exactly what memos shows.

import { Editor } from "@usememos/editor";
import { loadHighlighter } from "../memos/code-highlight";
import {
  loadSanitizer,
  MEMO_EDITOR_THEME,
  memoEditorLabels,
  memoExtensions,
  memoResolveUrl,
  memoSanitizeHtml,
  memoTagOptions,
  parseMemoMarkdown,
} from "../memos/memo-markdown";
import { MEMO_MARKDOWN } from "../memos/memo-ast";
import { headingIds } from "./headings";
import { post } from "../lib/dom";
import { ready, t } from "./strings";
import { markdownStyles, tagStyles } from "../memos/markdownStyles";

/**
 * memos' class lists the read-only view repeats on every tag, link and inline
 * code, and the short classes app.css defines to the same utilities. Stored
 * HTML uses the short ones; it is sent on every page.
 */
const ALIASES: [string, string][] = [
  [`${tagStyles.base} ${tagStyles.defaultColor} ${tagStyles.interactive}`, "m-tag mu-focus"],
  [markdownStyles.link, "m-link"],
  [markdownStyles.inlineCode, "m-code"],
  [markdownStyles.taskList, "m-task"],
];

/** Loads what the read-only view would otherwise fill in later: code languages and the HTML sanitizer. */
async function preload(markdown: string) {
  const doc = parseMemoMarkdown(markdown);
  const waits: Promise<unknown>[] = [];
  let html = false;
  for (const block of doc.blocks) {
    if (block.type === "code" && block.language.trim()) waits.push(loadHighlighter(block.language));
    if (block.type === "raw" && block.syntax === "html") html = true;
    if ("content" in block && Array.isArray(block.content) && block.content.some((s) => s.marks.includes("html"))) html = true;
  }
  if (html) waits.push(loadSanitizer());
  await Promise.all(waits);
}

const LIGHT_DARK = /color:\s*light-dark\(\s*([^,]+?)\s*,\s*([^)]+?)\s*\)/;

/** The rendered DOM as stored HTML: no editor ids, checkbox state as attributes, highlight colors as variables. */
function serialize(root: HTMLElement): string {
  for (const el of root.querySelectorAll("[data-block-id]")) el.removeAttribute("data-block-id");
  for (const input of root.querySelectorAll<HTMLInputElement>("input")) {
    if (input.type === "checkbox") input.toggleAttribute("checked", input.checked);
    else if (input.value) input.setAttribute("value", input.value);
  }
  for (const el of root.querySelectorAll<HTMLElement>(".memos-code-token[style]")) {
    const m = LIGHT_DARK.exec(el.getAttribute("style") ?? "");
    if (m) el.setAttribute("style", `--hl:${m[1]};--hd:${m[2]}`);
  }
  let html = root.innerHTML;
  for (const [long, short] of ALIASES) html = html.replaceAll(long, short);
  return html;
}

/** The HTML memos' read-only view draws for `markdown`. */
export async function renderHTML(markdown: string): Promise<string> {
  await Promise.all([ready, preload(markdown)]);
  const element = document.createElement("div");
  element.style.cssText = "position:absolute;left:-10000px;top:0;width:640px;visibility:hidden";
  element.className = "memo-content-root";
  document.body.append(element);
  const editor = new Editor({
    element,
    content: markdown,
    editable: false,
    taskToggle: true,
    markdown: MEMO_MARKDOWN,
    extensions: memoExtensions({ tags: memoTagOptions(true) }),
    theme: MEMO_EDITOR_THEME,
    labels: memoEditorLabels(t),
    resolveUrl: memoResolveUrl,
    referrerPolicy: "no-referrer",
    sanitizeHtml: memoSanitizeHtml,
    headingIds,
    toolbar: false,
    slashMenu: false,
  });
  await new Promise((r) => requestAnimationFrame(r));
  const html = serialize(element);
  editor.destroy();
  element.remove();
  return html;
}

/** Renders stale memos again and stores the result, one at a time. */
export async function refreshStale(cards: HTMLElement[], version: string) {
  for (const card of cards) {
    const uid = card.closest<HTMLElement>("[data-card]")?.dataset.card;
    if (!uid || !card.hasAttribute("data-stale")) continue;
    card.removeAttribute("data-stale");
    try {
      const res = await fetch(`${document.body.dataset.base}/f/memos/${uid}/source`);
      if (!res.ok) continue;
      const src = await res.json();
      const html = await renderHTML(src.content);
      await post(`/memos/${uid}/html`, { html, ver: version, rev: src.rev });
      const current = document.getElementById(`m-${uid}`);
      current?.removeAttribute("data-stale");
      const root = current?.querySelector(".memo-content-root");
      if (root) root.innerHTML = html;
    } catch {
      // A memo that fails to render keeps its server HTML; the next visit tries again.
    }
  }
}

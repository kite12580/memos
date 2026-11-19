// memos' editor configuration (web/src/lib/memo-markdown.ts), without the
// features this app leaves out: math, mentions, Mermaid and per-tag colors
// (tag colors come from a stylesheet the server writes).

import {
  type Block,
  type Doc,
  type Extension,
  footnotes,
  isPlainTextBlock,
  isTextBlock,
  type Labels,
  parseMarkdown,
  type ResolveUrl,
  type SanitizeHtml,
  type Span,
  scanTags,
  type TagsOptions,
  type Theme,
  tags,
} from "@usememos/editor";
import { highlightLoadedCode, loadHighlighter } from "./code-highlight";
import { cn } from "./cn";
import { headingClasses, markdownStyles, tagStyles } from "./markdownStyles";
import { MEMO_MARKDOWN, MEMO_SYNTAX } from "./memo-ast";
import { isAllowedLinkUrl } from "./url-policy";

export type Translate = (key: string) => string;

/** Editors whose code needs highlighting again once a language finishes loading. */
const highlightedEditors = new Set<import("@usememos/editor").Editor>();
const loadingLanguages = new Set<string>();

/** Token-based syntax highlighting for code blocks, while editing and when read-only. */
const codeHighlight = (): Extension => ({
  name: "codeHighlight",
  onCreate: ({ editor }) => {
    highlightedEditors.add(editor);
    return () => highlightedEditors.delete(editor);
  },
  codeDecorations: ({ text, language }) => {
    if (!language.trim() || !text) return [];
    const ranges = highlightLoadedCode(text, language);
    if (ranges === undefined) {
      const key = language.trim().toLowerCase();
      if (!loadingLanguages.has(key)) {
        loadingLanguages.add(key);
        void loadHighlighter(language)
          .then(
            () => highlightedEditors.forEach((editor) => editor.redecorate()),
            () => undefined,
          )
          .finally(() => loadingLanguages.delete(key));
      }
      return [];
    }
    return ranges;
  },
});

type HtmlSanitizer = typeof import("./sanitized-html").sanitizeMemoHtml;
let htmlSanitizer: HtmlSanitizer | null = null;
let htmlSanitizerPromise: Promise<HtmlSanitizer> | null = null;

export const loadSanitizer = () =>
  (htmlSanitizerPromise ??= import("./sanitized-html").then((module) => {
    htmlSanitizer = module.sanitizeMemoHtml;
    return htmlSanitizer;
  }));

/** Raw HTML (`<details>`, `<kbd>`, trusted embeds) through memos' sanitizer, loaded the first time it is needed. */
export const memoSanitizeHtml: SanitizeHtml = (tree) => {
  if (htmlSanitizer) return htmlSanitizer(tree);
  return loadSanitizer().then((sanitize) => sanitize(tree));
};

// `mbe-tag` is the editor's own class; the memo view finds tags by it.
const DEFAULT_TAG_CLASS = cn("mbe-tag", tagStyles.base, tagStyles.defaultColor);

/** How a #tag looks wherever a memo is shown: an inline tint, a button in the memo view. */
export const memoTagOptions = (interactive: boolean): Pick<TagsOptions, "class" | "attributes"> => ({
  class: () => cn(DEFAULT_TAG_CLASS, interactive && tagStyles.interactive),
  attributes: (match): Record<string, string> => ({
    "data-tag": match.slice(1),
    ...(interactive ? { role: "button", tabindex: "0" } : {}),
  }),
});

/** The extensions every memo surface reads with: footnotes, #tags and highlighted code. */
export const memoExtensions = (options: { tags?: Pick<TagsOptions, "class" | "attributes" | "onClick"> } = {}): Extension[] => [
  footnotes(),
  tags(options.tags),
  codeHighlight(),
];

/** Images load from relative URLs and https only, as memos' sanitizer allowed; anything else is dropped. */
const isAllowedImageSource = (src: string): boolean => !/^[a-z][a-z0-9+.-]*:/i.test(src) || /^https:/i.test(src);

export const memoResolveUrl: ResolveUrl = (url, kind) => {
  if (kind === "image") return isAllowedImageSource(url) ? url : null;
  return isAllowedLinkUrl(url.trim()) ? url.trim() : null;
};

/** The editor's look on @usememos/ui's tokens (memos' MEMO_EDITOR_THEME). */
export const MEMO_EDITOR_THEME: Theme = (() => {
  const colors = {
    text: "var(--mu-text)",
    muted: "var(--mu-text-secondary)",
    background: "transparent",
    accent: "var(--mu-accent)",
    link: "var(--mu-accent)",
    codeBackground: "var(--mu-well)",
    border: "var(--mu-line)",
    popupBackground: "var(--mu-surface)",
    popupBorder: "var(--mu-line)",
    hover: "var(--mu-hover)",
    danger: "var(--mu-danger)",
    calloutNote: "var(--mu-accent)",
    calloutTip: "var(--mu-success)",
    calloutImportant: "var(--mu-accent)",
    calloutWarning: "var(--mu-warning)",
    calloutCaution: "var(--mu-danger)",
  };
  return {
    colorScheme: "inherit",
    tokens: {
      colors,
      font: "inherit",
      mono: "var(--mu-font-mono)",
      fontSize: 16,
      lineHeight: 24,
      radius: "var(--mu-radius-md)",
      blockGap: 12,
    },
    classes: {
      heading: headingClasses,
      code: markdownStyles.inlineCode,
      codeBlock: markdownStyles.codeBlock,
      taskList: markdownStyles.taskList,
      link: markdownStyles.link,
      image: "rounded-mu-lg",
    },
  };
})();

export const MEMO_FOCUS_EDITOR_THEME: Theme = {
  ...MEMO_EDITOR_THEME,
  tokens: { ...MEMO_EDITOR_THEME.tokens, fontSize: 17, lineHeight: 28 },
};

/** The editor's UI strings in the user's language. */
export const memoEditorLabels = (t: Translate): Partial<Labels> => ({
  text: t("editor.format.paragraph"),
  heading1: t("editor.format.heading-1"),
  heading2: t("editor.format.heading-2"),
  heading3: t("editor.format.heading-3"),
  heading4: t("editor.format.heading-4"),
  bulletList: t("editor.format.bullet-list"),
  numberedList: t("editor.format.ordered-list"),
  todoList: t("editor.format.task-list"),
  task: t("editor.blocks.task"),
  quote: t("editor.blocks.quote"),
  callout: t("editor.blocks.callout"),
  calloutNote: t("editor.blocks.callout-note"),
  calloutTip: t("editor.blocks.callout-tip"),
  calloutImportant: t("editor.blocks.callout-important"),
  calloutWarning: t("editor.blocks.callout-warning"),
  calloutCaution: t("editor.blocks.callout-caution"),
  details: t("editor.blocks.collapsible-section"),
  detailsHint: t("common.title"),
  expandSection: t("common.expand"),
  collapseSection: t("common.collapse"),
  code: t("editor.format.code-block"),
  table: t("editor.blocks.table"),
  divider: t("editor.blocks.divider"),
  noResults: t("editor.blocks.no-results"),
  suggestions: t("editor.suggestions"),
  commands: t("editor.blocks.commands"),
  loading: t("editor.blocks.loading"),
  duplicate: t("editor.blocks.duplicate"),
  delete: t("common.delete"),
  bold: t("editor.format.bold"),
  italic: t("editor.format.italic"),
  strike: t("editor.format.strikethrough"),
  inlineCode: t("editor.blocks.inline-code"),
  link: t("editor.format.link"),
  textStyle: t("editor.blocks.text-style"),
  list: t("editor.blocks.list-hint"),
  linkPlaceholder: t("editor.blocks.link-placeholder"),
  removeLink: t("editor.blocks.remove-link"),
  openLink: t("editor.blocks.open-link"),
  copyLink: t("editor.blocks.copy-link"),
  editLink: t("editor.blocks.edit-link"),
  blockHandle: t("editor.blocks.block-menu"),
  listHint: t("editor.blocks.list-hint"),
  quoteHint: t("editor.blocks.quote"),
  language: t("common.language"),
  plainText: t("editor.blocks.plain-text"),
  copyCode: t("common.copy"),
  copied: t("message.copied"),
  addRowAbove: t("editor.blocks.add-row-above"),
  addRowBelow: t("editor.blocks.add-row-below"),
  addColumnLeft: t("editor.blocks.add-column-left"),
  addColumnRight: t("editor.blocks.add-column-right"),
  deleteRow: t("editor.blocks.delete-row"),
  deleteColumn: t("editor.blocks.delete-column"),
  align: t("editor.blocks.align"),
  alignLeft: t("editor.blocks.align-left"),
  alignCenter: t("editor.blocks.align-center"),
  alignRight: t("editor.blocks.align-right"),
  tableSection: t("editor.blocks.table"),
  imageSection: t("editor.blocks.image"),
  imageAlignLeft: t("editor.blocks.image-align-left"),
  imageAlignCenter: t("editor.blocks.image-align-center"),
  imageAlignRight: t("editor.blocks.image-align-right"),
  resetImageSize: t("editor.blocks.reset-image-size"),
  altText: t("editor.blocks.alt-text"),
  altTextPlaceholder: t("editor.blocks.alt-text-placeholder"),
  imageUnavailable: t("editor.blocks.image-unavailable"),
  resizeImage: t("editor.blocks.resize-image"),
  footnotes: t("editor.footnotes"),
  backToReference: t("editor.back-to-reference"),
});

/** Whether a span is literal text for tags: not code, raw HTML, a link, an image, or an extension token. */
const isLiteralSpan = (span: Span): boolean =>
  Boolean(span.link || span.image || span.token || span.marks.includes("code") || span.marks.includes("html"));

function* blockContainers(block: Block): Generator<readonly Span[]> {
  if (block.type === "table") {
    for (const row of block.rows) for (const cell of row) yield cell;
    return;
  }
  if (isTextBlock(block) && !isPlainTextBlock(block)) yield block.content;
}

/** Tags written in a document, as highlighted: `#work/project` gives `work/project`. */
export const collectTags = (blocks: readonly Block[]): string[] => {
  const found = new Set<string>();
  for (const block of blocks) {
    for (const content of blockContainers(block)) {
      for (const span of content) {
        if (isLiteralSpan(span)) continue;
        for (const range of scanTags(span.text, 0, span.text.length)) found.add(span.text.slice(range.from + 1, range.to));
      }
    }
  }
  return [...found];
};

/** Parses a memo the way the composer and the memo view read it. */
export const parseMemoMarkdown = (markdown: string): Doc => parseMarkdown(markdown, { ...MEMO_MARKDOWN, syntax: MEMO_SYNTAX });

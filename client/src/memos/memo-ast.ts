import { footnotes, type MarkdownOptions, type MarkdownSyntax, tags } from "@usememos/editor";

/**
 * The memo Markdown dialect, shared by the composer and the read-only memo view
 * so a memo reads the same while editing and after saving: a single newline is
 * a line break, and setext headings are off, so a line
 * followed by `---` stays a paragraph and a divider.
 */
export const MEMO_MARKDOWN: MarkdownOptions = { breaks: true, setext: false };

/** The syntax the memo extensions add (footnotes and tag escapes), for parsing outside an editor. */
export const MEMO_SYNTAX: readonly MarkdownSyntax[] = [footnotes(), tags()].flatMap((extension) =>
  extension.markdown ? [extension.markdown] : [],
);

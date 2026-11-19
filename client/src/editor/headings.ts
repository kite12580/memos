// memos' heading anchors (components/MemoEditor/view/headings.ts), so links to
// `#heading` land on the same ids.

const RESERVED = ["memo-comments"];

export function slugify(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function headingIds(headings: readonly { readonly text: string }[]): string[] {
  const used = new Set(RESERVED);
  return headings.map(({ text }) => {
    const base = slugify(text.trim()) || "heading";
    let slug = base;
    for (let i = 1; used.has(slug); i++) slug = `${base}-${i}`;
    used.add(slug);
    return slug;
  });
}

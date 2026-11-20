// The composer and in-place editing: memos' editor, loaded when the user
// starts writing. Saving renders the card HTML here, so the server only stores it.

import { Editor, fileHandler, matchToken, scanTags, suggestion } from "@usememos/editor";
import { emoji } from "@usememos/editor/emoji";
import { $, $$, fromHTML, post, request } from "../lib/dom";
import { icon } from "../lib/icon";
import { closeAll, openPopup } from "../lib/popup";
import { formatTimes } from "../lib/time";
import { toastError } from "../lib/toast";
import { articleOf, initClamps, refreshChrome, replaceCard } from "../lib/cards";
import { layoutGrid } from "../lib/list";
import { MEMO_EDITOR_THEME, MEMO_FOCUS_EDITOR_THEME, memoEditorLabels, memoExtensions, memoResolveUrl, memoSanitizeHtml, memoTagOptions } from "../memos/memo-markdown";
import { MEMO_MARKDOWN } from "../memos/memo-ast";
import { renderHTML } from "./render";
import { ready, t } from "./strings";
import { type Uploaded, uploadFile } from "./upload";

declare const RENDER_VERSION: string;


interface Saved {
  content: string;
  attachments: string[];
  relations: string[];
}

export interface Relation {
  uid: string;
  snippet: string;
}

/** Tags the sidebar lists, for `#` autocomplete. */
function knownTags(): string[] {
  return $$<HTMLAnchorElement>('#sidebar a[href*="q=%23"]').map((a) => decodeURIComponent(a.href.split("q=%23")[1] ?? "").split("&")[0]);
}

const rankTags = (tags: readonly string[], query: string) => {
  const typed = query.toLowerCase();
  return tags
    .map((tag) => {
      const i = tag.toLowerCase().indexOf(typed);
      return { tag, rank: i < 0 ? -1 : i === 0 ? 0 : tag[i - 1] === "/" ? 1 : 2 };
    })
    .filter((c) => c.rank >= 0)
    .sort((a, b) => a.rank - b.rank)
    .map((c) => c.tag);
};

const DRAFT_KEY = "memos-lite-draft";

/** One open editor: the composer, a comment composer, or a card being edited. */
export class Session {
  editor!: Editor;
  attachments: Uploaded[] = [];
  relations: Relation[] = [];
  createdTs?: number;
  uid?: string;
  rev?: number;
  saving = false;

  constructor(readonly el: HTMLElement, readonly onDone: (html: string, saved: Saved) => void, readonly onCancel?: () => void) {}

  get extras() {
    return $("[data-composer-extras]", this.el)!;
  }

  mount(markdown: string, focus = true) {
    const holder = $(".memo-editor-root", this.el)!;
    const element = document.createElement("div");
    holder.replaceWith(element);
    this.editor = new Editor({
      element,
      content: markdown,
      editable: true,
      markdown: MEMO_MARKDOWN,
      placeholder: holder.getAttribute("aria-placeholder") ?? "",
      extensions: [
        ...memoExtensions({ tags: memoTagOptions(false) }),
        suggestion({
          name: "tags",
          trigger: ["#", "＃"],
          match: matchToken(scanTags),
          allow: ({ excluded, explicit, query, textBefore }) => !excluded && (explicit || !(query === "" && /(^|\n)[ \t]*$/.test(textBefore))),
          items: ({ query }) => rankTags(knownTags(), query).map((tag) => ({ id: tag, label: `#${tag}`, value: tag })),
        }),
        emoji({ label: t("editor.blocks.emoji") }),
        fileHandler({
          onPaste: ({ files }) => void this.addFiles(files),
          onDrop: ({ files }) => void this.addFiles(files),
        }),
      ],
      theme: MEMO_EDITOR_THEME,
      labels: memoEditorLabels(t),
      resolveUrl: memoResolveUrl,
      referrerPolicy: "no-referrer",
      sanitizeHtml: memoSanitizeHtml,
      attributes: { autocorrect: "on", autocapitalize: "on", spellcheck: "true" },
      onChange: () => this.changed(),
      onSubmit: () => void this.save(),
      autofocus: focus && "end",
    });
    element.classList.add("memo-editor-root");
    this.el.dataset.ready = "1";
    this.renderExtras();
    this.changed();
  }

  get empty() {
    return !this.editor.getMarkdown().trim() && !this.attachments.length;
  }

  changed() {
    const save = $<HTMLButtonElement>("[data-action=save]", this.el);
    if (save) {
      save.toggleAttribute("data-disabled", this.empty);
      save.setAttribute("aria-disabled", String(this.empty));
    }
    if (this.el.dataset.composer === "create") localStorage.setItem(DRAFT_KEY, this.editor.getMarkdown());
  }

  async addFiles(files: File[]) {
    for (const file of files) {
      try {
        this.attachments.push(await uploadFile(file));
        this.renderExtras();
        this.changed();
      } catch (e) {
        toastError(e);
      }
    }
  }

  /** The attachment gallery and file and link rows under the text, each with a remove button. */
  renderExtras() {
    const box = this.extras;
    const visuals = this.attachments.filter((a) => a.kind === "image" || a.kind === "video");
    const files = this.attachments.filter((a) => a.kind !== "image" && a.kind !== "video");
    const remove = (kind: string, uid: string) =>
      `<button type="button" data-remove="${kind}:${uid}" aria-label="${t("common.delete")}" class="mu-button mu-button-ghost mu-button-icon mu-base mu-s-xs mu-focus">${icon("x", "")}</button>`;
    const n = visuals.length;
    const grid = n <= 1 ? "grid-cols-1" : n === 2 ? "grid-cols-2" : n <= 4 ? "grid-cols-2 grid-rows-2" : "grid-cols-3 grid-rows-2";
    let html = "";
    if (n) {
      html += `<div class="w-full grid ${grid} gap-1.5 h-40">${visuals
        .map(
          (a, i) =>
            `<div class="relative overflow-hidden rounded-mu-md border border-mu-line/70 bg-mu-well/30 ${n === 3 && i === 0 ? "row-span-2" : ""}">${a.thumb ? `<img src="${a.thumb}" alt="" class="h-full w-full object-cover">` : `<div class="flex h-full items-center justify-center mu-caption text-mu-text-secondary">${a.filename}</div>`}<div class="absolute end-1 top-1 rounded-mu-sm bg-mu-canvas/80">${remove("a", a.uid)}</div></div>`,
        )
        .join("")}</div>`;
    }
    if (files.length || this.relations.length) {
      html += `<div class="-mx-2 flex w-[calc(100%+1rem)] flex-col gap-0.5">${files
        .map(
          (a) =>
            `<div class="group/row relative flex h-7 w-full min-w-0 items-center gap-1 rounded-mu-md px-2 mu-caption text-mu-text-secondary"><span class="flex size-5 shrink-0 items-center justify-center">${icon(a.kind === "audio" ? "audio-lines" : "file", "mu-icon-sm")}</span><span class="min-w-0 flex-1 truncate text-mu-text"></span>${remove("a", a.uid)}</div>`,
        )
        .join("")}${this.relations
        .map(
          (r) =>
            `<div class="group/row relative flex h-7 w-full min-w-0 items-center gap-1 rounded-mu-md px-2 mu-caption text-mu-text-secondary"><span class="flex size-5 shrink-0 items-center justify-center">${icon("link", "mu-icon-sm")}</span><span class="min-w-0 flex-1 truncate"></span>${remove("r", r.uid)}</div>`,
        )
        .join("")}</div>`;
    }
    box.innerHTML = html;
    const names = $$(".truncate", box);
    [...files.map((a) => a.filename), ...this.relations.map((r) => r.snippet)].forEach((text, i) => {
      if (names[i]) names[i].textContent = text;
    });
    box.onclick = (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-remove]");
      if (!b) return;
      const [kind, uid] = b.dataset.remove!.split(":");
      if (kind === "a") this.attachments = this.attachments.filter((a) => a.uid !== uid);
      else this.relations = this.relations.filter((r) => r.uid !== uid);
      this.renderExtras();
      this.changed();
    };
  }

  async save() {
    if (this.saving || this.empty) return;
    this.saving = true;
    const button = $<HTMLButtonElement>("[data-action=save]", this.el);
    button?.setAttribute("data-disabled", "");
    try {
      const content = this.editor.getMarkdown();
      const html = await renderHTML(content);
      const body = {
        content,
        html,
        ver: RENDER_VERSION,
        attachments: this.attachments.map((a) => a.uid),
        relations: this.relations.map((r) => r.uid),
        createdTs: this.createdTs ?? this.dayTs(),
        rev: this.rev,
        parent: this.el.dataset.parent,
      };
      const inList = this.el.closest("#memo-list") || this.el.dataset.composer === "create" ? "?list=1" : "";
      const res = this.uid ? await post(`/memos/${this.uid}${inList}`, body) : await post(`/memos${inList}`, body);
      const card = await res.text();
      if (this.el.dataset.composer === "create") localStorage.removeItem(DRAFT_KEY);
      this.onDone(card, body);
    } catch (e) {
      toastError(e);
    } finally {
      this.saving = false;
      this.changed();
    }
  }

  /** For a memo composed in a calendar day's panel: that day, at the current time of day. */
  dayTs() {
    const day = this.el.closest<HTMLElement>("[data-day-panel]")?.dataset.dayPanel;
    if (!day) return undefined;
    const [y, m, d] = day.split("-").map(Number);
    const at = new Date();
    at.setFullYear(y, m - 1, d);
    return Math.floor(at.getTime() / 1000);
  }

  /** Clears what was just saved, keeping anything written or attached while the save was in flight. */
  reset(saved: Saved) {
    const now = this.editor.getMarkdown();
    const done = saved.content.trimEnd();
    if (now.trimEnd() === done) this.editor.setMarkdown("");
    else if (now.startsWith(done)) {
      this.editor.setMarkdown(now.slice(done.length).trimStart());
      this.editor.focus();
    }
    this.attachments = this.attachments.filter((a) => !saved.attachments.includes(a.uid));
    this.relations = this.relations.filter((r) => !saved.relations.includes(r.uid));
    this.createdTs = undefined;
    this.renderExtras();
    this.changed();
  }

  toggleSource() {
    this.editor.setOptions({ mode: this.editor.mode === "source" ? "rich" : "source" });
  }

  toggleFocus() {
    const on = !this.el.hasAttribute("data-focus-mode");
    this.el.toggleAttribute("data-focus-mode", on);
    this.el.classList.toggle("fixed", on);
    this.el.classList.toggle("inset-2", on);
    this.el.classList.toggle("z-40", on);
    this.el.classList.toggle("sm:inset-8", on);
    $(".memo-editor-content", this.el)?.toggleAttribute("data-focus-mode", on);
    this.editor.setOptions({ theme: on ? MEMO_FOCUS_EDITOR_THEME : MEMO_EDITOR_THEME });
    this.editor.focus();
  }
}

const sessions = new WeakMap<HTMLElement, Session>();
export const sessionOf = (el: Element) => {
  const composer = el.closest<HTMLElement>("[data-composer]");
  return composer ? sessions.get(composer) : undefined;
};

function insertCard(html: string, composer: HTMLElement) {
  const card = fromHTML(html).firstElementChild as HTMLElement;
  if (composer.dataset.composer === "comment") {
    const list = $("[data-comments]");
    const wrap = document.createElement("div");
    wrap.className = "w-full";
    wrap.id = card.dataset.card ?? "";
    wrap.append(card);
    list?.prepend(wrap);
  } else if (composer.dataset.composer === "day") {
    const holder = composer.closest<HTMLElement>("[data-day-composer]")!;
    const compose = holder.previousElementSibling as HTMLElement;
    compose.before(card);
    holder.hidden = true;
    compose.hidden = false;
  } else {
    const leading = $("#memo-list [data-leading]");
    const firstUnpinned = $$("#memo-list [data-card]")
      .filter((c) => !articleOf(c).hasAttribute("data-pinned"))
      .sort((a, b) => Number(a.dataset.i ?? 0) - Number(b.dataset.i ?? 0))[0];
    $("#memo-list [data-empty]")?.remove();
    if (firstUnpinned) firstUnpinned.before(card);
    else if (leading) leading.after(card);
    layoutGrid();
  }
  formatTimes(card);
  initClamps(card);
}

const activating = new WeakMap<HTMLElement, Promise<Session>>();

/** Turns a server-rendered composer into a live editor, keeping what was typed before it loaded. */
export function activate(composer: HTMLElement, focus = true): Promise<Session> {
  const live = sessions.get(composer);
  if (live) return Promise.resolve(live);
  let session = activating.get(composer);
  if (!session) {
    session = start(composer, focus);
    activating.set(composer, session);
  }
  return session;
}

async function start(composer: HTMLElement, focus: boolean) {
  await ready;
  const typed = $(".memo-editor-root", composer)?.innerText.trim() ?? "";
  const draft = composer.dataset.composer === "create" ? (localStorage.getItem(DRAFT_KEY) ?? "") : "";
  const session = new Session(composer, (html, saved) => {
    insertCard(html, composer);
    session.reset(saved);
    void refreshChrome();
  });
  sessions.set(composer, session);
  session.mount([draft.trim(), typed].filter(Boolean).join("\n\n"), focus || composer.contains(document.activeElement));
  composer.addEventListener("click", (e) => {
    const action = (e.target as HTMLElement).closest<HTMLElement>("[data-action=save]");
    if (action) void session.save();
  });
  return session;
}

/** Edits a card in place, as memos does: the card's body becomes the editor until saved or cancelled. */
export async function editCard(card: HTMLElement) {
  await ready;
  const uid = card.dataset.card!;
  const res = await request(`/f/memos/${uid}/source`).catch(toastError);
  if (!res) return;
  const src = await res.json();
  const article = articleOf(card);
  const saved = [...article.childNodes];
  const composer = document.createElement("div");
  composer.className = "group w-full flex flex-col justify-between items-start gap-2";
  composer.dataset.composer = "edit";
  composer.innerHTML = `<div class="flex w-full items-center gap-1.5 h-6"><button type="button" data-timestamp="" class="shrink-0 whitespace-nowrap rounded-mu-sm text-start mu-caption text-mu-text-secondary transition-colors select-none hover:text-mu-text border border-transparent mu-focus focus-visible:border-mu-focus mu-popover-trigger"></button></div><div class="relative w-full flex flex-col flex-1"><div class="relative flex w-full flex-col items-start justify-start bg-inherit memo-editor-content"><div class="memo-editor-scroller w-full text-base leading-6"><div class="memo-editor-root"></div></div></div></div><div class="w-full flex flex-col gap-2" data-composer-extras=""></div><div class="mu-compact flex w-full min-w-0 flex-row items-center justify-between gap-1"><div class="flex min-w-0 flex-1 flex-row items-center justify-start gap-1"><button type="button" aria-label="${t("common.add")}" aria-haspopup="menu" data-popup="insert-menu" class="mu-button mu-button-neutral mu-button-icon mu-base mu-s-md mu-focus mu-menu-trigger">${icon("plus", "")}</button></div><div class="flex shrink-0 flex-row items-center justify-end gap-1"><button type="button" data-cancel="" class="mu-button mu-button-ghost mu-base mu-s-md mu-focus"><span class="mu-button-label">${t("common.cancel")}</span></button><button type="button" data-action="save" aria-keyshortcuts="Meta+Enter Control+Enter" class="mu-button mu-button-primary mu-base mu-s-md mu-focus"><span class="mu-button-label">${t("common.update")}</span></button></div></div>`;
  const body = document.createElement("div");
  body.className = "w-full";
  body.dataset.slot = "memo-body";
  body.append(composer);
  article.replaceChildren(body);
  const restore = () => {
    article.replaceChildren(...saved);
  };
  const session = new Session(
    composer,
    (html) => {
      replaceCard(card, html);
      void refreshChrome();
    },
    restore,
  );
  session.uid = uid;
  session.rev = src.rev;
  session.createdTs = src.createdTs;
  session.attachments = src.attachments;
  session.relations = src.relations;
  sessions.set(composer, session);
  session.mount(src.content);
  const stamp = $<HTMLButtonElement>("[data-timestamp]", composer)!;
  const showStamp = () => {
    const d = new Date((session.createdTs ?? 0) * 1000);
    const p = (n: number) => String(n).padStart(2, "0");
    stamp.textContent = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  showStamp();
  stamp.addEventListener("click", () => import("./timestamp").then((m) => m.openTimestamp(stamp, session, showStamp)));
  composer.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest("[data-cancel]")) restore();
    else if (target.closest("[data-action=save]")) void session.save();
  });
}

const menuItem = (action: string, iconName: string, label: string, extra = "") =>
  `<div role="menuitem" tabindex="-1" class="mu-menu-item mu-s-sm mu-caption${extra}" data-insert="${action}"><span class="mu-option-icon" aria-hidden="true">${icon(iconName, "")}</span><span class="mu-menu-label">${label}</span></div>`;

function pickFiles(accept: string): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = accept;
    input.addEventListener("change", () => resolve([...(input.files ?? [])]));
    input.click();
  });
}

/** The composer's ＋ menu: files, inline images, drawing, audio, links to memos, focus and Markdown modes. */
export async function openInsertMenu(trigger: HTMLElement) {
  const composer = trigger.closest<HTMLElement>("[data-composer]")!;
  const session = await activate(composer);
  const popup = document.createElement("div");
  popup.className = "mu-menu-popup mu-popup mu-popup-motion mu-base mu-s-sm";
  popup.setAttribute("role", "menu");
  const source = session.editor.mode === "source";
  popup.innerHTML =
    menuItem("attachment", "paperclip", t("editor.insert-menu.add-attachment")) +
    menuItem("image", "image", t("editor.insert-menu.insert-image")) +
    menuItem("draw", "palette", t("editor.insert-menu.drawing")) +
    menuItem("record", "mic", t("editor.audio-recorder.trigger")) +
    menuItem("link", "link", t("editor.insert-menu.link-memo")) +
    '<div role="separator" class="mu-menu-separator"></div>' +
    menuItem("focus", "maximize-2", t("editor.focus-mode")) +
    `<div ${source ? "data-checked" : "data-unchecked"}="" role="menuitemcheckbox" aria-checked="${source}" tabindex="-1" class="mu-menu-item mu-s-sm mu-caption mu-menu-checkbox-item" data-insert="source"><span class="mu-option-icon" aria-hidden="true">${icon("code-xml", "")}</span><span class="mu-menu-label">${t("editor.markdown-mode")}</span><span class="mu-menu-indicator">${source ? icon("check", "") : ""}</span></div>`;
  popup.addEventListener("click", async (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>("[data-insert]");
    if (!item) return;
    closeAll();
    switch (item.dataset.insert) {
      case "attachment":
        return session.addFiles(await pickFiles(""));
      case "image": {
        for (const file of await pickFiles("image/*")) {
          try {
            const a = await uploadFile(file);
            const md = session.editor.getMarkdown();
            session.editor.setMarkdown(`${md}${md && !md.endsWith("\n") ? "\n" : ""}![${a.filename}](${a.url})\n`);
            session.changed();
          } catch (err) {
            toastError(err);
          }
        }
        return;
      }
      case "draw":
        return import("./draw").then((m) => m.openDrawing(session, t));
      case "record":
        return import("./record").then((m) => m.openRecorder(session, t));
      case "link":
        return import("./link-memo").then((m) => m.openLinkMemo(session, t));
      case "focus":
        return session.toggleFocus();
      case "source":
        return session.toggleSource();
    }
  });
  openPopup(trigger, popup, "bottom", "start");
}

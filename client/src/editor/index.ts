// The composer and in-place editing: memos' editor, loaded when the user
// starts writing. Saving renders the card HTML here, so the server only stores it.

import { Editor, fileHandler, matchToken, scanTags, suggestion } from "@usememos/editor";
import { emoji } from "@usememos/editor/emoji";
import { $, $$, fromHTML, post, request } from "../lib/dom";
import { icon } from "../lib/icon";
import { closeAll, closeLayer, openDialog, openPopup } from "../lib/popup";
import { formatTimes } from "../lib/time";
import { toastError } from "../lib/toast";
import { articleOf, fresh, initClamps, markFresh, replaceCard } from "../lib/cards";
import { refreshChrome } from "../lib/actions";
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

const SOURCE_KEY = "memos-lite-source-mode";

const draftKey = (composer: HTMLElement) => {
  const mode = composer.dataset.composer;
  if (mode === "create") return "memos-lite-draft";
  if (mode === "global") return "memos-lite-draft:global";
  return mode === "comment" ? `memos-lite-draft:${composer.dataset.parent}` : null;
};

/** One open editor: the composer, a comment composer, or a card being edited. */
export class Session {
  editor!: Editor;
  attachments: Uploaded[] = [];
  relations: Relation[] = [];
  createdTs?: number;
  updatedTs?: number;
  uid?: string;
  rev?: number;
  saving = false;
  hosted?: () => void;

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
      mode: localStorage.getItem(SOURCE_KEY) ? "source" : "rich",
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
      const blocked = this.empty || this.saving;
      save.toggleAttribute("data-disabled", blocked);
      save.setAttribute("aria-disabled", String(blocked));
      const reason = save.nextElementSibling;
      const required = reason?.classList.contains("mu-visually-hidden") ? reason : null;
      required?.toggleAttribute("hidden", !this.empty);
      if (this.saving) delete save.dataset.tip;
      else save.dataset.tip = (this.empty && required?.textContent) || save.textContent || "";
      if (this.empty) delete save.dataset.tipShortcut;
      else save.dataset.tipShortcut = `${/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl"} Enter`;
    }
    const key = draftKey(this.el);
    if (key) localStorage.setItem(key, this.editor.getMarkdown());
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
    this.changed();
    const button = $<HTMLButtonElement>("[data-action=save]", this.el);
    button?.setAttribute("aria-busy", "true");
    button?.setAttribute("data-loading", "");
    const spinner = setTimeout(() => {
      button?.setAttribute("data-loading-visible", "");
      button?.insertAdjacentHTML("afterbegin", '<span class="mu-spinner" aria-hidden="true"></span>');
    }, 300);
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
        updatedTs: this.updatedTs,
        rev: this.rev,
        parent: this.el.dataset.parent,
      };
      const inList = this.el.closest("#memo-list") || this.el.dataset.composer === "create" ? "?list=1" : "";
      const res = this.uid ? await post(`/memos/${this.uid}${inList}`, body) : await post(`/memos${inList}`, body);
      const card = await res.text();
      const key = draftKey(this.el);
      if (key) localStorage.removeItem(key);
      this.onDone(card, body);
    } catch (e) {
      toastError(e);
    } finally {
      clearTimeout(spinner);
      for (const name of ["aria-busy", "data-loading", "data-loading-visible"]) button?.removeAttribute(name);
      button?.querySelector(".mu-spinner")?.remove();
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
    const source = this.editor.mode !== "source";
    if (source) localStorage.setItem(SOURCE_KEY, "1");
    else localStorage.removeItem(SOURCE_KEY);
    this.editor.setOptions({ mode: source ? "source" : "rich" });
  }

  toggleFocus() {
    const on = !this.el.hasAttribute("data-focus-mode");
    const exit = () => (this.hosted ? this.hosted() : this.toggleFocus());
    const apply = () => {
      this.el.toggleAttribute("data-focus-mode", on);
      if (on) {
        this.el.dataset.frame = this.el.className;
        this.el.classList.remove("relative", "mb-2", "pt-3");
        this.el.classList.add(...FOCUS_FRAME);
      } else this.el.className = this.el.dataset.frame ?? this.el.className;
      $(".memo-editor-content", this.el)?.toggleAttribute("data-focus-mode", on);
      for (const c of ["min-h-0", "flex-1"]) for (const el of $$(".memo-editor-content, .memo-editor-scroller", this.el)) el.classList.toggle(c, on);
      document.body.style.overflow = on ? "hidden" : "";
      if (on) {
        const placeholder = document.createElement("div");
        placeholder.className = "w-full mb-2";
        placeholder.setAttribute("aria-hidden", "true");
        placeholder.dataset.focusPlaceholder = "";
        placeholder.style.height = `${height}px`;
        const backdrop = document.createElement("div");
        backdrop.className = "fixed inset-0 bg-mu-overlay backdrop-blur-sm z-(--mu-layer-overlay)";
        backdrop.setAttribute("aria-label", t("editor.exit-focus-mode"));
        backdrop.dataset.focusBackdrop = "";
        backdrop.addEventListener("click", exit);
        this.el.before(backdrop);
        if (!this.hosted) this.el.before(placeholder);
        const header = $("[data-timestamp]", this.el)?.parentElement;
        if (header) header.classList.replace("h-6", "h-10");
        else {
          const row = document.createElement("div");
          row.className = "flex w-full items-center gap-1.5 h-10";
          row.dataset.focusHeader = "";
          const now = new Intl.RelativeTimeFormat(document.documentElement.lang || undefined, { numeric: "auto" }).format(0, "second");
          row.innerHTML = '<span class="shrink-0 whitespace-nowrap mu-caption text-mu-text-secondary select-none"></span>';
          row.firstElementChild!.textContent = now.charAt(0).toLocaleUpperCase() + now.slice(1);
          this.el.prepend(row);
        }
        const exitRow = (header ?? $("[data-focus-header]", this.el))!;
        exitRow.insertAdjacentHTML(
          "beforeend",
          `<div class="ms-auto -me-2" data-focus-exit=""><button type="button" aria-label="${this.hosted ? t("common.close") : t("editor.exit-focus-mode")}" class="mu-button mu-button-ghost mu-button-icon mu-base mu-s-sm mu-focus">${this.hosted ? icon("x", "") : icon("minimize-2", "")}</button></div>`,
        );
        $("[data-focus-exit] button", this.el)!.addEventListener("click", exit);
      } else {
        for (const el of $$("[data-focus-backdrop], [data-focus-placeholder]")) el.remove();
        $("[data-focus-header]", this.el)?.remove();
        $("[data-focus-exit]", this.el)?.remove();
        $("[data-timestamp]", this.el)?.parentElement?.classList.replace("h-10", "h-6");
      }
      this.editor.setOptions({ theme: on ? MEMO_FOCUS_EDITOR_THEME : MEMO_EDITOR_THEME });
    };
    const height = this.el.getBoundingClientRect().height;
    if (document.startViewTransition && !this.hosted) {
      this.el.style.viewTransitionName = "memo-focus-mode";
      document.startViewTransition(apply).finished.finally(() => (this.el.style.viewTransitionName = ""));
    } else apply();
    this.editor.focus();
  }

  destroy() {
    if (this.el.hasAttribute("data-focus-mode")) this.toggleFocus();
    this.editor.destroy();
  }
}

const FOCUS_FRAME = "bg-mu-surface px-4 pb-4 rounded-mu-lg border border-mu-line/70 fixed z-50 w-auto max-w-3xl mx-auto border-mu-line h-auto overflow-y-auto pt-2 pb-4 sm:px-6 top-2 left-2 right-2 bottom-2 sm:top-4 sm:left-4 sm:right-4 sm:bottom-4 md:top-8 md:left-8 md:right-8 md:bottom-8".split(" ");

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
  } else if (composer.dataset.composer === "create" || $("[data-composer=create]")) {
    $("#memo-list [data-empty]")?.remove();
    card.dataset.i = "0.5";
    $("#memo-list [data-leading]")?.after(card);
    fresh.add(card.dataset.card!);
    layoutGrid();
  }
  formatTimes(card);
  initClamps(card);
  markFresh();
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
  const key = draftKey(composer);
  const draft = key ? (localStorage.getItem(key) ?? "") : "";
  const session = new Session(composer, (html, saved) => {
    insertCard(html, composer);
    session.reset(saved);
    if (composer.dataset.composer === "comment") showCommentComposer(false);
    session.hosted?.();
    void refreshChrome();
  });
  session.hosted = hosts.get(composer);
  sessions.set(composer, session);
  const focused = focus || composer.contains(document.activeElement);
  session.mount([draft.trim(), typed].filter(Boolean).join("\n\n"), focused);
  const [, before = "", query = ""] = /(?:^|\n)([^\n]*?)[#＃]([^\s#＃]*)$/.exec(typed) ?? [];
  const tagging = /(^|[ \t])$/.test(before) && (query || before.trim());
  if (focused && tagging) session.editor.suggestion.open("tags");
  composer.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest("[data-action=save]")) void session.save();
    else if (target.closest("[data-cancel]")) (session.hosted ?? (() => showCommentComposer(false)))();
  });
  return session;
}

function showCommentComposer(on: boolean) {
  const holder = $("[data-comment-composer]");
  if (!holder) return;
  holder.hidden = !on;
  for (const b of $$<HTMLElement>("[data-comments-head] [data-action=write-comment]")) b.hidden = on;
}

export async function openComment() {
  const holder = $("[data-comment-composer]");
  const composer = holder && $("[data-composer]", holder);
  if (!composer) return;
  showCommentComposer(true);
  holder.scrollIntoView({ behavior: "smooth", block: "center" });
  (await activate(composer)).editor.focus();
}

const hosts = new WeakMap<HTMLElement, () => void>();

export async function openGlobal() {
  const res = await request("/f/composer").catch(toastError);
  if (!res) return;
  const frag = fromHTML(
    `<div class="fixed inset-0 z-(--mu-layer-overlay) bg-transparent" role="presentation"></div><div role="dialog" aria-modal="true" aria-labelledby="new-memo-title" class="fixed inset-0 z-(--mu-layer-overlay) outline-none"><h2 id="new-memo-title" class="mu-visually-hidden">${t("editor.new-memo")}</h2>${await res.text()}</div>`,
  );
  const composer = frag.querySelector<HTMLElement>("[data-composer]")!;
  let session: Session | undefined;
  const root = openDialog(frag, undefined, () => session?.destroy());
  if (!root) return;
  hosts.set(composer, () => closeLayer(root));
  session = await activate(composer);
  session.toggleFocus();
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
    session.destroy();
    article.replaceChildren(...saved);
  };
  const session: Session = new Session(
    composer,
    (html) => {
      session.destroy();
      fresh.delete(uid);
      replaceCard(card, html);
      void refreshChrome();
    },
    restore,
  );
  session.uid = uid;
  session.rev = src.rev;
  session.createdTs = src.createdTs;
  session.updatedTs = src.updatedTs;
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

function imageAlt(filename: string) {
  const name = filename.replace(/[\r\n]+/g, " ").trim();
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name || "image").replace(/[\\[\]]/g, "\\$&");
}

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
    (session.hosted ? "" : menuItem("focus", "maximize-2", t("editor.focus-mode"))) +
    `<div ${source ? "data-checked" : "data-unchecked"}="" role="menuitemcheckbox" aria-checked="${source}" tabindex="-1" class="mu-menu-item mu-s-sm mu-caption mu-menu-checkbox-item" data-insert="source"><span class="mu-option-icon" aria-hidden="true">${icon("code-xml", "")}</span><span class="mu-menu-label">${t("editor.markdown-mode")}</span><span class="mu-menu-indicator">${source ? icon("check", "") : ""}</span></div>`;
  popup.addEventListener("click", async (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>("[data-insert]");
    if (!item) return;
    closeAll();
    switch (item.dataset.insert) {
      case "attachment":
        return session.addFiles(await pickFiles(""));
      case "image": {
        const files = await pickFiles("image/*");
        const done: string[] = [];
        for (const file of files) {
          try {
            const a = await uploadFile(file);
            done.push(`![${imageAlt(a.filename)}](${a.url})`);
          } catch (err) {
            toastError(err);
          }
        }
        const { editor } = session;
        if (done.length) editor.commands.insertMarkdown(done.join("\n\n"), { at: editor.getSelection().focus, block: true });
        editor.commands.focus();
        editor.commands.scrollIntoView();
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

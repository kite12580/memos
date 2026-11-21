// memos' useInlineImageUpload and uploadAnchors: images uploaded into the text.

import { type Block, inlineText, type Position, type Widget, type WidgetRender } from "@usememos/editor";
import { icon } from "../lib/icon";
import { toastError } from "../lib/toast";
import { buildManagedAttachmentMarkdown } from "../memos/managed-attachment";
import type { Session } from "./index";
import { t } from "./strings";
import { type LivePart, type Uploaded, uploadFile } from "./upload";

interface Entry {
  file: File;
  live?: LivePart;
  attachment?: Uploaded;
}

interface Job {
  entries: Entry[];
  representatives: number[];
  widget: Widget;
  active: boolean;
}

const isImage = (type: string) => type.startsWith("image/") && !/photoshop|psd/i.test(type);

/** memos' splitInlineLocalFiles: motion groups stay together, and the still is the one written into the text. */
export function splitInline(files: File[], live: Map<File, LivePart>) {
  const inline: Entry[] = [];
  const representatives: number[] = [];
  const attachments: File[] = [];
  const consumed = new Set<string>();
  for (const file of files) {
    const group = live.get(file)?.group;
    if (!group) {
      if (isImage(file.type)) {
        representatives.push(inline.length);
        inline.push({ file });
      } else attachments.push(file);
      continue;
    }
    if (consumed.has(group)) continue;
    consumed.add(group);
    const members = files.filter((candidate) => live.get(candidate)?.group === group);
    const representative = members.find((candidate) => isImage(candidate.type));
    if (!representative) {
      attachments.push(...members);
      continue;
    }
    representatives.push(inline.length + members.indexOf(representative));
    inline.push(...members.map((member) => ({ file: member, live: live.get(member) })));
  }
  return { inline, representatives, attachments };
}

const actionButton = (label: string, onClick: () => void) => {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "mu-button mu-button-ghost mu-base mu-s-sm mu-focus";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
};

function renderAnchor(session: Session, job: Job, status: "uploading" | "failed"): WidgetRender {
  const completed = job.entries.filter((e) => e.attachment).length;
  const total = job.entries.length;
  const text = (status === "uploading" ? t("editor.insert-menu.uploading-images") : t("editor.insert-menu.image-upload-stopped"))
    .replace("{{completed}}", String(completed))
    .replace("{{total}}", String(total));
  return (element) => {
    element.className = "memo-upload-anchor";
    element.dataset.status = status;
    element.setAttribute("role", "status");
    element.setAttribute("aria-live", "polite");
    element.replaceChildren();
    const rail = document.createElement("span");
    rail.className = "memo-upload-anchor-rail";
    const message = document.createElement("span");
    message.className = "memo-upload-anchor-message";
    message.innerHTML = status === "uploading" ? '<span class="mu-spinner mu-icon-sm" aria-hidden="true"></span>' : icon("circle-alert", "");
    message.append(text);
    element.append(rail, message);
    if (status === "failed") {
      const actions = document.createElement("span");
      actions.className = "flex gap-1";
      actions.append(
        actionButton(t("editor.insert-menu.retry-image-upload"), () => void run(session, job)),
        actionButton(completed > 0 ? t("editor.insert-menu.keep-as-attachments") : t("common.cancel"), () => finish(session, job)),
      );
      element.append(actions);
    }
  };
}

function finish(session: Session, job: Job) {
  job.widget.remove();
  session.uploads.delete(job);
  session.changed();
}

const isEmptyParagraph = (block: Block) => block.type === "paragraph" && inlineText(block.content) === "";

async function run(session: Session, job: Job) {
  const { editor } = session;
  if (job.active || editor.isDestroyed) return;
  job.active = true;
  job.widget.update(renderAnchor(session, job, "uploading"));
  let error: unknown;
  for (const entry of job.entries) {
    if (entry.attachment) continue;
    try {
      entry.attachment = await uploadFile(entry.file, undefined, entry.live);
      if (editor.isDestroyed) return;
      session.attachments.push(entry.attachment);
      void session.renderExtras();
      job.widget.update(renderAnchor(session, job, "uploading"));
    } catch (e) {
      error = e;
    }
  }
  job.active = false;
  if (editor.isDestroyed) return;
  if (job.entries.some((e) => !e.attachment)) {
    job.widget.update(renderAnchor(session, job, "failed"));
    toastError(error ?? t("editor.insert-menu.image-upload-failed"));
    return;
  }
  const markdown = job.representatives.map((i) => buildManagedAttachmentMarkdown(job.entries[i].attachment!)).join("\n\n");
  if (!job.widget.isRemoved) {
    const block = editor.state.doc.blocks.find((candidate) => candidate.id === job.widget.blockId);
    editor.commands.insertMarkdown(markdown, { at: block && isEmptyParagraph(block) ? { blockId: block.id, offset: 0 } : job.widget, block: true });
    editor.commands.focus();
    editor.commands.scrollIntoView();
  }
  finish(session, job);
}

/** memos' insertLocalImages: a placeholder where the images go, replaced by them once every file is uploaded. */
export function insertLocalImages(session: Session, entries: Entry[], representatives: number[], position?: Position | null) {
  const { editor } = session;
  if (!entries.length || session.saving) return;
  const job = { entries, representatives, active: false } as Job;
  job.widget = editor.addWidget({ at: position ?? editor.getSelection().focus, render: renderAnchor(session, job, "uploading") });
  session.uploads.add(job);
  session.changed();
  void run(session, job);
}

/** memos' insertRemoteImages: attachments already uploaded, written into the text at the caret. */
export function insertRemoteImages(session: Session, attachments: Uploaded[]) {
  const { editor } = session;
  const markdown = attachments.filter((a) => isImage(a.type)).map(buildManagedAttachmentMarkdown).join("\n\n");
  if (!markdown || session.saving) return;
  editor.commands.insertMarkdown(markdown, { at: editor.getSelection().focus, block: true });
  editor.commands.focus();
  editor.commands.scrollIntoView();
}

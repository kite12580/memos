// memos' web/src/utils/managed-attachment.ts.

import { visit } from "@usememos/editor";
import { base } from "../lib/dom";
import { parseMemoAst } from "./memo-ast";

interface Named {
  uid: string;
  filename: string;
}

const MANAGED_ATTACHMENT_PATH_PREFIX = "/file/attachments/";
const UID_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,34}[a-zA-Z0-9])?$/;

export const parseManagedAttachmentImageURL = (raw: string): string | undefined => {
  if (!raw.startsWith(MANAGED_ATTACHMENT_PATH_PREFIX) || /[?#%]/.test(raw)) return undefined;
  const parts = raw.slice(MANAGED_ATTACHMENT_PATH_PREFIX.length).split("/");
  if ((parts.length !== 1 && parts.length !== 2) || !UID_PATTERN.test(parts[0]) || (parts.length === 2 && !parts[1])) return undefined;
  return parts[0];
};

let cached: [string, ReadonlySet<string>] = ["", new Set()];

export const extractManagedAttachmentUIDs = (source: string): ReadonlySet<string> => {
  if (!source.includes(MANAGED_ATTACHMENT_PATH_PREFIX)) return new Set();
  if (cached[0] === source) return cached[1];
  const uids = new Set<string>();
  visit(parseMemoAst(source), (node) => {
    const uid = node.type === "image" ? parseManagedAttachmentImageURL(node.destination) : undefined;
    if (uid) uids.add(uid);
  });
  cached = [source, uids];
  return uids;
};

const escapeMarkdownAlt = (value: string): string => value.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/]/g, "\\]");

const filenameStem = (filename: string): string => {
  const normalized = filename.replace(/[\r\n]+/g, " ").trim();
  const lastDot = normalized.lastIndexOf(".");
  return lastDot > 0 ? normalized.slice(0, lastDot) : normalized || "image";
};

export const buildManagedAttachmentMarkdown = (attachment: Named): string =>
  `![${escapeMarkdownAlt(filenameStem(attachment.filename))}](${MANAGED_ATTACHMENT_PATH_PREFIX}${attachment.uid})`;

export const resolveManagedAttachmentImageSource = (source: string, attachments: readonly Named[]): string => {
  const uid = parseManagedAttachmentImageURL(source);
  if (!uid) return source;
  const attachment = attachments.find((candidate) => candidate.uid === uid);
  return attachment ? `${base}${MANAGED_ATTACHMENT_PATH_PREFIX}${uid}/${encodeURIComponent(attachment.filename)}` : `${base}${source}`;
};

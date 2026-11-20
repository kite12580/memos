import { createCanvas, drawingFileName, readScenePng, type ToolName } from "@usememos/canvas";
import { icon } from "../lib/icon";
import { closeLayer, openDialog } from "../lib/popup";
import { toast, toastError } from "../lib/toast";
import type { Session } from "./index";
import { type Uploaded, uploadFile } from "./upload";

const TOOLS: [ToolName, string, string][] = [
  ["select", "mouse-pointer-2", "editor.drawing.tool-select"],
  ["pen", "pencil", "editor.drawing.tool-pen"],
  ["eraser", "eraser", "editor.drawing.tool-eraser"],
  ["rectangle", "square", "editor.drawing.tool-rectangle"],
  ["ellipse", "circle", "editor.drawing.tool-ellipse"],
  ["arrow", "move-up-right", "editor.drawing.tool-arrow"],
  ["text", "type", "editor.drawing.tool-text"],
];

const button = (attrs: string, iconName: string, label: string) =>
  `<button type="button" ${attrs} aria-label="${label}" title="${label}" class="mu-button mu-button-ghost mu-button-icon mu-base mu-s-md mu-focus">${icon(iconName, "")}</button>`;

async function readSource(source: Uploaded) {
  const res = await fetch(source.url);
  if (!res.ok) throw new Error(res.statusText);
  const blob = await res.blob();
  const { scene } = await readScenePng(blob);
  return { scene, blob };
}

/** A drawing sheet on @usememos/canvas; saving attaches the drawing as a PNG. */
export async function openDrawing(session: Session, t: (k: string) => string, source?: Uploaded) {
  let content: Awaited<ReturnType<typeof readSource>> | undefined;
  if (source) {
    try {
      content = await readSource(source);
    } catch {
      return toast(t("editor.drawing.open-failed"), "danger");
    }
  }
  let template = document.getElementById("tpl-draw") as HTMLTemplateElement | null;
  if (!template) {
    template = document.createElement("template");
    template.id = "tpl-draw";
    template.innerHTML = `<div class="mu-dialog-backdrop" data-open="" role="presentation"></div><div data-open="" role="presentation" class="mu-dialog-viewport mu-dialog-full"><div data-open="" role="dialog" class="mu-dialog-popup mu-dialog-bare mu-popup mu-base mu-s-md flex h-full w-full flex-col"><div class="flex items-center justify-between gap-2 border-b border-mu-line px-3 py-2"><div class="flex items-center gap-1" data-tools=""></div><div class="flex items-center gap-1"><button type="button" data-draw="cancel" class="mu-button mu-button-ghost mu-base mu-s-md mu-focus"><span class="mu-button-label"></span></button><button type="button" data-draw="save" class="mu-button mu-button-primary mu-base mu-s-md mu-focus"><span class="mu-button-label"></span></button></div></div><div class="relative min-h-0 flex-1" data-surface=""></div></div></div>`;
    document.body.append(template);
  }
  let handle: ReturnType<typeof createCanvas> | null = null;
  openDialog(
    "tpl-draw",
    (root) => {
      root.querySelector("[data-draw=cancel] span")!.textContent = t("common.cancel");
      root.querySelector("[data-draw=save] span")!.textContent = t("editor.save");
      root.querySelector("[data-tools]")!.innerHTML =
        TOOLS.map(([tool, ic, key]) => button(`data-tool="${tool}"`, ic, t(key))).join("") +
        button('data-draw="undo"', "undo-2", t("editor.drawing.undo")) +
        button('data-draw="redo"', "redo-2", t("editor.drawing.redo"));
      requestAnimationFrame(() => {
        handle = createCanvas(root.querySelector<HTMLElement>("[data-surface]")!, {
          autoFocus: true,
          dir: document.documentElement.dir === "rtl" ? "rtl" : "ltr",
          onToolChange: (tool) => {
            for (const b of root.querySelectorAll<HTMLElement>("[data-tool]")) b.toggleAttribute("data-pressed", b.dataset.tool === tool);
          },
        });
        handle.setTool("pen");
        if (content?.scene) handle.setScene(content.scene);
        else if (content) void handle.insertImage(content.blob, { background: true });
      });
      root.addEventListener("click", async (e) => {
        const el = (e.target as HTMLElement).closest<HTMLElement>("[data-tool], [data-draw]");
        if (!el || !handle) return;
        if (el.dataset.tool) return handle.setTool(el.dataset.tool as ToolName);
        switch (el.dataset.draw) {
          case "undo":
            return handle.undo();
          case "redo":
            return handle.redo();
          case "cancel":
            return closeLayer(root);
          case "save": {
            handle.commitText();
            if (handle.isEmpty()) return closeLayer(root);
            try {
              const png = await handle.exportPng();
              const drawing = await uploadFile(png, drawingFileName());
              const at = source ? session.attachments.indexOf(source) : -1;
              if (at < 0) session.attachments.push(drawing);
              else if (content?.scene) session.attachments[at] = drawing;
              else session.attachments.splice(at + 1, 0, drawing);
              session.renderExtras();
              session.changed();
              closeLayer(root);
            } catch (err) {
              toastError(err);
            }
          }
        }
      });
    },
    () => handle?.destroy(),
  );
}

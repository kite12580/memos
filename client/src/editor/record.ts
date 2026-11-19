import { icon } from "../lib/icon";
import { closeDialog, openDialog } from "../lib/popup";
import { toastError } from "../lib/toast";
import type { Session } from "./index";
import { uploadFile } from "./upload";

const pad = (n: number) => String(n).padStart(2, "0");

/** Records a voice note in the browser and attaches it. */
export async function openRecorder(session: Session, t: (k: string) => string) {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    return toastError(e);
  }
  const type = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
  const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const chunks: Blob[] = [];
  recorder.addEventListener("dataavailable", (e) => chunks.push(e.data));
  let keep = false;
  let timer = 0;
  const started = Date.now();
  let template = document.getElementById("tpl-recorder") as HTMLTemplateElement | null;
  if (!template) {
    template = document.createElement("template");
    template.id = "tpl-recorder";
    template.innerHTML = `<div class="mu-dialog-backdrop" data-open="" role="presentation"></div><div data-open="" role="presentation" class="mu-dialog-viewport mu-dialog-sheet"><div data-open="" role="dialog" class="mu-dialog-popup mu-popup mu-base mu-s-md"><h2 class="mu-dialog-title mu-title flex items-center gap-2">${icon("mic", "mu-icon text-mu-danger")}<span></span></h2><p class="mu-dialog-description mu-heading tabular-nums" data-time="">0:00</p><div class="mu-dialog-footer"><button type="button" data-stop="cancel" class="mu-button mu-button-ghost mu-base mu-s-md mu-focus"><span class="mu-button-label"></span></button><button type="button" data-stop="keep" class="mu-button mu-button-primary mu-base mu-s-md mu-focus"><span class="mu-button-label"></span></button></div></div></div>`;
    document.body.append(template);
  }
  const root = openDialog(
    "tpl-recorder",
    (r) => {
      r.querySelector("h2 span")!.textContent = t("editor.audio-recorder.recording");
      r.querySelector("[data-stop=cancel] span")!.textContent = t("common.cancel");
      r.querySelector("[data-stop=keep] span")!.textContent = t("editor.audio-recorder.stop");
      r.addEventListener("click", (e) => {
        const b = (e.target as HTMLElement).closest<HTMLElement>("[data-stop]");
        if (!b) return;
        keep = b.dataset.stop === "keep";
        closeDialog(r);
      });
      timer = window.setInterval(() => {
        const s = Math.floor((Date.now() - started) / 1000);
        r.querySelector("[data-time]")!.textContent = `${Math.floor(s / 60)}:${pad(s % 60)}`;
      }, 500);
    },
    () => {
      clearInterval(timer);
      recorder.stop();
    },
  );
  recorder.addEventListener("stop", async () => {
    for (const track of stream.getTracks()) track.stop();
    if (!keep || !root) return;
    const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
    const d = new Date();
    const ext = blob.type.includes("mp4") ? "m4a" : "webm";
    const name = `recording-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${ext}`;
    try {
      session.attachments.push(await uploadFile(blob, name));
      session.renderExtras();
      session.changed();
    } catch (e) {
      toastError(e);
    }
  });
  recorder.start(1000);
}

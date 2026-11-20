import { base } from "../lib/dom";

export interface Uploaded {
  uid: string;
  filename: string;
  type: string;
  kind: "image" | "video" | "audio" | "file";
  size: number;
  url: string;
  thumb: string;
}

const THUMB_SIDE = 640;

/** A WebP thumbnail made here, so the server never decodes images. */
async function imageThumb(file: Blob): Promise<{ blob: Blob | null; width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;
  const scale = Math.min(1, THUMB_SIDE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/webp", 0.8));
  return { blob, width, height };
}

interface VideoInfo {
  blob: Blob | null;
  width?: number;
  height?: number;
  duration?: number;
}

/** A frame from early in a video, for its poster, with the size and length memos saves. */
function videoThumb(file: Blob): Promise<VideoInfo> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    const done = (blob: Blob | null) => {
      URL.revokeObjectURL(url);
      resolve({
        blob,
        width: video.videoWidth || undefined,
        height: video.videoHeight || undefined,
        duration: Number.isFinite(video.duration) && video.duration >= 0 ? video.duration : undefined,
      });
    };
    video.muted = true;
    video.preload = "metadata";
    video.src = url;
    video.addEventListener("loadeddata", () => (video.currentTime = Math.min(1, video.duration / 2 || 0)));
    video.addEventListener("seeked", async () => {
      try {
        const frame = await imageThumb(await new Promise<Blob>((r, j) => {
          const c = document.createElement("canvas");
          c.width = video.videoWidth;
          c.height = video.videoHeight;
          c.getContext("2d")!.drawImage(video, 0, 0);
          c.toBlob((b) => (b ? r(b) : j()), "image/png");
        }));
        done(frame.blob);
      } catch {
        done(null);
      }
    });
    video.addEventListener("error", () => done(null));
    setTimeout(() => done(null), 8000);
  });
}

export async function uploadFile(file: File | Blob, name = (file as File).name || "file"): Promise<Uploaded> {
  const type = file.type || "application/octet-stream";
  let thumb: Blob | null = null;
  const params = new URLSearchParams({ name, type });
  const saveMedia = document.cookie.split("; ").includes("media=1");
  let media: object | undefined;
  if (type.startsWith("image/") && type !== "image/svg+xml") {
    try {
      const t = await imageThumb(file);
      thumb = t.blob;
      params.set("w", String(t.width));
      params.set("h", String(t.height));
    } catch {
      thumb = null;
    }
    if (saveMedia) {
      const photo = await (await import("./media")).photoMetadata(file);
      media = photo ? { photo } : {};
    }
  } else if (type.startsWith("video/")) {
    const v = await videoThumb(file);
    thumb = v.blob;
    if (v.width && v.height) {
      params.set("w", String(v.width));
      params.set("h", String(v.height));
    }
    if (saveMedia) media = v.duration === undefined ? {} : { video: { durationSeconds: v.duration } };
  }
  if (media) params.set("media", JSON.stringify(media));
  const res = await fetch(`${base}/attachments?${params}`, { method: "POST", body: file });
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  const a: Uploaded = await res.json();
  if (thumb && (thumb.size < file.size || type.startsWith("video/"))) {
    const t = await fetch(`${base}/attachments/${a.uid}/thumb`, { method: "POST", body: thumb });
    if (t.ok) a.thumb = `${base}/thumb/${a.uid}`;
  }
  return a;
}

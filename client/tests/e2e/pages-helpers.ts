import type { APIRequestContext } from "@playwright/test";
import { deflateSync } from "node:zlib";

export const auth = { authorization: "Bearer e2e-token" };

/** A 4×4 PNG of one color. */
export function png(rgb: [number, number, number] = [128, 128, 128]): Buffer {
  const crc = (buf: Buffer) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0);
  ihdr.writeUInt32BE(4, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.from([0, ...Array.from({ length: 4 }, () => rgb).flat()]);
  const raw = Buffer.concat(Array.from({ length: 4 }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** A JPEG holding only an EXIF segment: camera, capture time and aperture. */
export function exifJpeg(): Buffer {
  const ascii = (s: string) => Buffer.from(`${s}\0`, "latin1");
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const ifd = (at: number, entries: [number, number, number, Buffer][]) => {
    const head = Buffer.alloc(2 + entries.length * 12 + 4);
    head.writeUInt16LE(entries.length);
    let data = Buffer.alloc(0);
    entries.forEach(([tag, type, count, value], i) => {
      const e = 2 + i * 12;
      head.writeUInt16LE(tag, e);
      head.writeUInt16LE(type, e + 2);
      head.writeUInt32LE(count, e + 4);
      if (value.length <= 4) value.copy(head, e + 8);
      else {
        head.writeUInt32LE(at + head.length + data.length, e + 8);
        data = Buffer.concat([data, value]);
      }
    });
    return Buffer.concat([head, data]);
  };
  const make = ascii("Canon");
  const model = ascii("Canon EOS R6");
  const ifd0 = (exifAt: number) => ifd(8, [[0x010f, 2, make.length, make], [0x0110, 2, model.length, model], [0x8769, 4, 1, u32(exifAt)]]);
  const exifAt = 8 + ifd0(0).length;
  const date = ascii("2024:05:01 14:23:45");
  const exif = ifd(exifAt, [[0x9003, 2, date.length, date], [0x829d, 5, 1, Buffer.concat([u32(28), u32(10)])]]);
  const app1 = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), Buffer.from("II*\0", "latin1"), u32(8), ifd0(exifAt), exif]);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(app1.length + 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), len, app1, Buffer.from([0xff, 0xd9])]);
}

export async function upload(request: APIRequestContext, name: string, type: string, data: Buffer): Promise<string> {
  const res = await request.post(`/api/memos/attachments?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`, { headers: auth, data });
  if (!res.ok()) throw new Error(`upload ${res.status()}`);
  return (await res.json()).uid;
}

export async function memo(request: APIRequestContext, content: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await request.post("/api/memos", { headers: auth, data: { content, ...extra } });
  if (!res.ok()) throw new Error(`memo ${res.status()}`);
  return (await res.json()).uid;
}

/** `YYYY-MM-DD` and `YYYY-MM` of today in UTC, the server's zone in these tests. */
export const today = () => new Date().toISOString().slice(0, 10);
export const thisMonth = () => today().slice(0, 7);

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

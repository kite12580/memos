/** memos' mediaMetadataService for photos: the EXIF fields it saves, read from a JPEG's APP1 segment. */

type Tags = Map<number, unknown>;

const GPS = 0x10000;
const SIZES = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8];

function readTiff(v: DataView, start: number, tags: Tags) {
  const le = v.getUint16(start) === 0x4949;
  const u16 = (o: number) => v.getUint16(start + o, le);
  const u32 = (o: number) => v.getUint32(start + o, le);
  const i32 = (o: number) => v.getInt32(start + o, le);
  const ifd = (off: number, base: number) => {
    const n = u16(off);
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      const type = u16(e + 2);
      const count = u32(e + 4);
      const size = SIZES[type] ?? 0;
      if (!size) continue;
      const at = size * count > 4 ? u32(e + 8) : e + 8;
      const read = (k: number) => {
        const o = at + k * size;
        if (type === 3 || type === 8) return u16(o);
        if (type === 4) return u32(o);
        if (type === 9) return i32(o);
        if (type === 5) return u32(o) / u32(o + 4);
        if (type === 10) return i32(o) / i32(o + 4);
        return v.getUint8(start + o);
      };
      tags.set(
        base + u16(e),
        type === 2
          ? new TextDecoder().decode(new Uint8Array(v.buffer, start + at, count)).replace(/\0[\s\S]*$/, "")
          : count === 1
            ? read(0)
            : Array.from({ length: Math.min(count, 3) }, (_, k) => read(k)),
      );
    }
  };
  ifd(u32(4), 0);
  const exif = tags.get(0x8769);
  const gps = tags.get(0x8825);
  if (typeof exif === "number") ifd(exif, 0);
  if (typeof gps === "number") ifd(gps, GPS);
}

async function readTags(file: Blob): Promise<Tags> {
  const tags: Tags = new Map();
  try {
    const v = new DataView(await file.slice(0, 1 << 17).arrayBuffer());
    if (v.getUint16(0) !== 0xffd8) return tags;
    for (let p = 2; p + 10 < v.byteLength; p += 2 + v.getUint16(p + 2)) {
      const marker = v.getUint16(p);
      if (marker === 0xffe1 && v.getUint32(p + 4) === 0x45786966) {
        readTiff(v, p + 10, tags);
        break;
      }
      if (marker === 0xffda || marker >> 8 !== 0xff) break;
    }
  } catch {
    // A truncated or malformed segment keeps the tags read before it.
  }
  return tags;
}

const first = (x: unknown) => (Array.isArray(x) ? x[0] : x);
const num = (x: unknown) => {
  const n = first(x);
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
};
const str = (x: unknown) => (typeof x === "string" ? x.replace(/\p{Cc}/gu, "").trim() || undefined : undefined);

function captureTime(date: unknown, subsec: unknown, offset: unknown) {
  const m = str(date)?.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}:\d{2}:\d{2})$/);
  if (!m) return undefined;
  const sub = str(subsec);
  return { localDateTime: `${m[1]}-${m[2]}-${m[3]}T${m[4]}${sub && /^\d{1,9}$/.test(sub) ? `.${sub}` : ""}`, utcOffset: str(offset) };
}

function coordinate(dms: unknown, ref: unknown, negative: string) {
  if (!Array.isArray(dms) || dms.length < 3 || !dms.every((n) => typeof n === "number" && Number.isFinite(n))) return undefined;
  const [d, m, s] = dms as number[];
  return (str(ref)?.toUpperCase() === negative ? -1 : 1) * (d + m / 60 + s / 3600);
}

export async function photoMetadata(file: Blob) {
  const t = await readTags(file);
  const latitude = coordinate(t.get(GPS + 2), t.get(GPS + 1), "S");
  const longitude = coordinate(t.get(GPS + 4), t.get(GPS + 3), "W");
  const altitude = first(t.get(GPS + 6));
  const photo = {
    captureTime: captureTime(t.get(0x9003), t.get(0x9291), t.get(0x9011)) ?? captureTime(t.get(0x9004), t.get(0x9292), t.get(0x9012)),
    location:
      latitude === undefined || longitude === undefined
        ? undefined
        : { latitude, longitude, altitudeMeters: typeof altitude === "number" && Number.isFinite(altitude) ? (first(t.get(GPS + 5)) === 1 ? -altitude : altitude) : undefined },
    sourceExifOrientation: num(t.get(0x0112)),
    cameraMake: str(t.get(0x010f)),
    cameraModel: str(t.get(0x0110)),
    lensModel: str(t.get(0xa434)),
    fNumber: num(t.get(0x829d)),
    exposureTimeSeconds: num(t.get(0x829a)),
    iso: num(t.get(0x8827)),
    focalLengthMm: num(t.get(0x920a)),
  };
  return Object.values(photo).some((v) => v !== undefined) ? photo : undefined;
}

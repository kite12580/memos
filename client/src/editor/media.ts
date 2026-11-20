/** memos' mediaMetadataService for photos: the EXIF fields it saves, read from the TIFF block of a JPEG, TIFF, PNG, WebP or HEIF/AVIF file. */

type Tags = Map<number, unknown>;

const GPS = 0x10000;
const SIZES = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

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
        if (type === 11) return v.getFloat32(start + o, le);
        if (type === 12) return v.getFloat64(start + o, le);
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

const HEAD = 1 << 18;
const fourcc = (v: DataView, o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
const isTiff = (v: DataView, o: number) => [0x49492a00, 0x4d4d002a].includes(v.getUint32(o));

function jpegExif(v: DataView) {
  for (let p = 2; p + 10 < v.byteLength; p += 2 + v.getUint16(p + 2)) {
    const marker = v.getUint16(p);
    if (marker === 0xffe1 && v.getUint32(p + 4) === 0x45786966) return p + 10;
    if (marker === 0xffda || marker >> 8 !== 0xff) return;
  }
}

async function chunkExif(file: Blob, first: number, want: string, little: boolean) {
  for (let p = first, n = 0; p + 8 <= file.size && n < 512; n++) {
    const h = new DataView(await file.slice(p, p + 14).arrayBuffer());
    const size = little ? h.getUint32(4, true) : h.getUint32(0);
    const type = fourcc(h, little ? 0 : 4);
    if (type === want) return p + 8 + (h.byteLength >= 14 && fourcc(h, 8) === "Exif" ? 6 : 0);
    if (!little && type === "IEND") return;
    p += 8 + size + (little ? size & 1 : 4);
  }
}

function boxes(v: DataView, from: number, to: number) {
  const out = new Map<string, [number, number]>();
  for (let p = from; p + 8 <= to; ) {
    let size = v.getUint32(p);
    let head = 8;
    if (size === 1) {
      size = Number(v.getBigUint64(p + 8));
      head = 16;
    } else if (size === 0) size = to - p;
    if (size < head) break;
    out.set(fourcc(v, p + 4), [p + head, Math.min(p + size, to)]);
    p += size;
  }
  return out;
}

function heifExif(v: DataView) {
  const meta = boxes(v, 0, v.byteLength).get("meta");
  if (!meta) return;
  const inner = boxes(v, meta[0] + 4, meta[1]);
  const iinf = inner.get("iinf");
  const iloc = inner.get("iloc");
  if (!iinf || !iloc) return;
  let p = iinf[0] + 4 + (v.getUint8(iinf[0]) ? 4 : 2);
  let id: number | undefined;
  for (let q = p; q + 8 <= iinf[1]; q += v.getUint32(q)) {
    if (fourcc(v, q + 4) !== "infe" || v.getUint32(q) < 8) break;
    const version = v.getUint8(q + 8);
    if (version < 2) continue;
    const item = version === 2 ? v.getUint16(q + 12) : v.getUint32(q + 12);
    if (fourcc(v, q + 12 + (version === 2 ? 4 : 6)) === "Exif") id = item;
  }
  if (id === undefined) return;
  const version = v.getUint8(iloc[0]);
  p = iloc[0] + 4;
  const sizes = v.getUint16(p);
  const [offSize, lenSize, baseSize, indexSize] = [sizes >> 12, (sizes >> 8) & 15, (sizes >> 4) & 15, version ? sizes & 15 : 0];
  const read = (n: number) => {
    const x = n === 8 ? Number(v.getBigUint64(p)) : n === 4 ? v.getUint32(p) : n === 2 ? v.getUint16(p) : 0;
    p += n;
    return x;
  };
  p += 2;
  const count = read(version < 2 ? 2 : 4);
  for (let i = 0; i < count; i++) {
    const item = read(version < 2 ? 2 : 4);
    if (version) p += 2;
    p += 2;
    const base = read(baseSize);
    const extents = read(2);
    let start: number | undefined;
    for (let e = 0; e < extents; e++) {
      p += indexSize;
      const off = read(offSize);
      read(lenSize);
      start ??= base + off;
    }
    if (item === id && start !== undefined) return start;
  }
}

async function tiffOffset(file: Blob) {
  const v = new DataView(await file.slice(0, HEAD).arrayBuffer());
  if (v.byteLength < 16) return;
  if (isTiff(v, 0)) return 0;
  if (v.getUint16(0) === 0xffd8) return jpegExif(v);
  if (v.getUint32(0) === 0x89504e47) return chunkExif(file, 8, "eXIf", false);
  if (fourcc(v, 0) === "RIFF" && fourcc(v, 8) === "WEBP") return chunkExif(file, 12, "EXIF", true);
  if (fourcc(v, 4) === "ftyp") {
    const item = heifExif(v);
    if (item === undefined) return;
    const h = new DataView(await file.slice(item, item + 4).arrayBuffer());
    return item + 4 + h.getUint32(0);
  }
}

async function readTags(file: Blob): Promise<Tags> {
  const tags: Tags = new Map();
  try {
    const at = await tiffOffset(file);
    if (at === undefined) return tags;
    const v = new DataView(await file.slice(at, at + HEAD).arrayBuffer());
    if (isTiff(v, 0)) readTiff(v, 0, tags);
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

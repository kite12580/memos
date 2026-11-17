import { readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

const COMPRESSIBLE_EXTENSIONS = new Set([".js", ".mjs", ".css", ".svg", ".json", ".webmanifest", ".txt", ".xml", ".map", ".wasm"]);

const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

const encoders = {
  ".br": (data) =>
    brotliAsync(data, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
        [constants.BROTLI_PARAM_SIZE_HINT]: data.length,
      },
    }),
  ".gz": (data) => gzipAsync(data, { level: constants.Z_BEST_COMPRESSION }),
};

const [dir] = process.argv.slice(2);
if (!dir) {
  throw new Error("Usage: node scripts/precompress-dist.mjs <dir>");
}

const entries = await readdir(dir, { recursive: true, withFileTypes: true });
await Promise.all(
  entries
    .filter((entry) => entry.isFile() && COMPRESSIBLE_EXTENSIONS.has(extname(entry.name)))
    .map(async (entry) => {
      const file = join(entry.parentPath, entry.name);
      const data = await readFile(file);
      for (const [suffix, encode] of Object.entries(encoders)) {
        const compressed = await encode(data);
        if (compressed.length < data.length) {
          await writeFile(file + suffix, compressed);
        }
      }
    }),
);

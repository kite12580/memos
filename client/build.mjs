// Builds the client into dist/: hashed, pre-compressed assets under assets/,
// the icon sprite the server inlines into every page, and manifest.json,
// which tells the server the asset names.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import * as esbuild from "esbuild";

const root = dirname(new URL(import.meta.url).pathname);
const dist = join(root, "dist");
const assets = join(dist, "assets");
rmSync(dist, { recursive: true, force: true });
mkdirSync(assets, { recursive: true });

const pkg = (name) => JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8"));
const hash = (data) => createHash("sha256").update(data).digest("base64url").slice(0, 10);

// The HTML a browser renders for a memo depends on the editor and on render.ts;
// a change to either makes stored HTML stale, and browsers render it again.
const renderVersion = hash(
  pkg("@usememos/editor").version +
    pkg("@pierre/highlights").version +
    ["src/editor/render.ts", "src/memos/memo-markdown.ts", "src/memos/markdownStyles.ts", "src/memos/code-highlight.ts"]
      .map((f) => readFileSync(join(root, f), "utf8"))
      .join(""),
);

const result = await esbuild.build({
  absWorkingDir: root,
  entryPoints: { boot: "src/boot.ts" },
  bundle: true,
  splitting: true,
  format: "esm",
  target: ["chrome111", "safari16.4"],
  minify: true,
  legalComments: "none",
  outdir: assets,
  entryNames: "[name]-[hash]",
  chunkNames: "c-[hash]",
  assetNames: "a-[hash]",
  loader: { ".css": "empty", ".wasm": "file" },
  define: { RENDER_VERSION: JSON.stringify(renderVersion) },
  metafile: true,
  logLevel: "warning",
});
const outputs = Object.entries(result.metafile.outputs);
const [bootPath, bootOutput] = outputs.find(([, o]) => o.entryPoint === "src/boot.ts");
const boot = bootPath.split("/").pop();
// The chunks boot imports statically, so pages can preload them alongside it.
const preload = bootOutput.imports.filter((i) => i.kind === "import-statement").map((i) => `assets/${i.path.split("/").pop()}`);

// The UI package ships every component's styles. Rules whose selectors only name `mu-` classes no
// source mentions are dropped; a class built at runtime (`mu-toast-${type}`) keeps its whole prefix.
function pruneUiStyles() {
  const css = readFileSync(join(root, "node_modules/@usememos/ui/dist/styles.css"), "utf8");
  const sources = [
    ...readdirSync(join(root, "../server/templates"), { recursive: true }).filter((f) => f.endsWith(".html")).map((f) => join(root, "../server/templates", f)),
    ...readdirSync(join(root, "../server/src"), { recursive: true }).filter((f) => f.endsWith(".rs")).map((f) => join(root, "../server/src", f)),
    ...readdirSync(join(root, "src"), { recursive: true }).filter((f) => f.endsWith(".ts") || f.endsWith(".css")).map((f) => join(root, "src", f)),
  ].map((f) => readFileSync(f, "utf8")).join("\n");
  const used = new Set(sources.match(/mu-[a-z0-9-]+/g));
  const prefixes = [...sources.matchAll(/(mu-[a-z0-9-]*-)\$\{/g)].map((m) => m[1]);
  const known = (cls) => used.has(cls) || prefixes.some((p) => cls.startsWith(p));
  const keepSelector = (sel) => sel.split(",").some((one) => (one.match(/\.mu-[a-z0-9-]+/g) ?? []).every((c) => known(c.slice(1))));
  let i = 0;
  const block = (depth) => {
    let text = "";
    while (i < css.length) {
      while (/\s/.test(css[i] ?? "")) i++;
      if (i >= css.length) break;
      if (css[i] === "}") {
        i++;
        return text;
      }
      const open = css.indexOf("{", i);
      const close = css.indexOf("}", i);
      if (open === -1 || close < open) {
        text += css.slice(i, close);
        i = close;
        continue;
      }
      const semi = css.indexOf(";", i);
      if (css[i] === "@" && semi !== -1 && semi < open) {
        text += css.slice(i, semi + 1);
        i = semi + 1;
        continue;
      }
      const head = css.slice(i, open);
      i = open + 1;
      if (head.startsWith("@media") || head.startsWith("@supports") || head.startsWith("@layer")) {
        const inner = block(depth + 1);
        if (inner) text += `${head}{${inner}}`;
      } else if (head.startsWith("@")) {
        const end = css.indexOf("}", i);
        const inner = head.startsWith("@keyframes") ? block(depth + 1) : css.slice(i, end);
        if (!head.startsWith("@keyframes")) i = end + 1;
        text += `${head}{${inner}}`;
      } else {
        const end = css.indexOf("}", i);
        const body = css.slice(i, end);
        i = end + 1;
        if (keepSelector(head)) text += `${head}{${body}}`;
      }
    }
    return text;
  };
  const out = block(0);
  mkdirSync(join(root, ".build"), { recursive: true });
  writeFileSync(join(root, ".build/ui-styles.css"), out);
}
pruneUiStyles();

execFileSync(join(root, "node_modules/.bin/tailwindcss"), ["-i", "src/styles/app.css", "-o", "dist/app.css", "--minify"], {
  cwd: root,
  stdio: ["ignore", "ignore", "inherit"],
});
const css = readFileSync(join(dist, "app.css"));
const cssName = `app-${hash(css)}.css`;
writeFileSync(join(assets, cssName), css);
rmSync(join(dist, "app.css"));

// Every string literal in a template, the server or a script that names a Lucide icon, plus the ones
// icons.txt lists for names built at runtime. A literal that only looks like an icon name costs a symbol.
const iconDir = join(root, "node_modules/lucide-static/icons");
const sources = (dir, exts) =>
  readdirSync(dir, { recursive: true })
    .filter((f) => exts.some((e) => f.endsWith(e)))
    .map((f) => readFileSync(join(dir, f), "utf8"));
const lucide = new Set(readdirSync(iconDir).map((f) => f.replace(/\.svg$/, "")));
const names = new Set(readFileSync(join(root, "icons.txt"), "utf8").split(/\s+/).filter(Boolean));
for (const src of [...sources(join(root, "../server/templates"), [".html"]), ...sources(join(root, "../server/src"), [".rs"]), ...sources(join(root, "src"), [".ts"])]) {
  for (const m of src.matchAll(/"([a-z][a-z0-9-]*)"/g)) if (lucide.has(m[1])) names.add(m[1]);
}
const iconNames = [...names].sort();
for (const name of iconNames) {
  try {
    readFileSync(join(iconDir, `${name}.svg`));
  } catch {
    throw new Error(`no Lucide icon named ${name}`);
  }
}
const symbols = iconNames.map((name) => {
  const svg = readFileSync(join(iconDir, `${name}.svg`), "utf8");
  const inner = svg
    .replace(/^[\s\S]*?<svg[^>]*>/, "")
    .replace(/<\/svg>\s*$/, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s*\n\s*/g, "")
    .replace(/<(path|circle|rect|line|polyline|polygon|ellipse)\b/g, '<$1 vector-effect="non-scaling-stroke"');
  return `<symbol id="i-${name}" viewBox="0 0 24 24">${inner}</symbol>`;
});
const mark = readFileSync(join(root, "src/memos-mark.svg"), "utf8").trim();
const sprite = `<svg xmlns="http://www.w3.org/2000/svg">${symbols.join("")}${mark}</svg>`;
const spriteName = `icons-${hash(sprite)}.svg`;
writeFileSync(join(assets, spriteName), sprite);
writeFileSync(join(dist, "favicon.svg"), readFileSync(join(root, "public/favicon.svg")));

for (const name of readdirSync(assets)) {
  if (!/\.(js|css|svg|json|wasm|map)$/.test(name)) continue;
  const data = readFileSync(join(assets, name));
  writeFileSync(join(assets, `${name}.gz`), gzipSync(data, { level: 9 }));
  writeFileSync(
    join(assets, `${name}.br`),
    brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } }),
  );
}

writeFileSync(join(dist, "manifest.json"), JSON.stringify({ boot: `assets/${boot}`, preload, css: `assets/${cssName}`, sprite: `assets/${spriteName}`, renderVersion }, null, 2));
console.log(`built boot=${boot} css=${cssName} render=${renderVersion}`);

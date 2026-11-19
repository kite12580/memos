# AGENTS.md

memos-lite: a single-user clone of memos' UI. The `lite` branch shares nothing with the
memos branches in this repository; never merge between them.

## Layout

- `server/` — Rust. `server.rs` the hyper listener, `app.rs` routes, `pages/` GET handlers (full pages and HTML fragments
  under `/f/`), `actions.rs` POST handlers, `api.rs` JSON API, `files.rs` attachments,
  `db/` SQLite (schema in `db/schema.rs`, append-only migrations; writes go through
  `Db::tx`), `query.rs` the search
  syntax, `content.rs` stored-HTML handling, `views.rs` view models, `templates/` Askama.
- `client/` — TypeScript, no framework. `src/boot.ts` is the only script every page loads;
  everything else is a lazy chunk (`src/editor/`, `src/reactions.ts`). `src/memos/` holds
  files adapted from memos' `web/src/lib`. `build.mjs` builds into `dist/`.

## Rules

- Markup comes only from the server templates. The client fetches HTML fragments and swaps
  them in; it never builds cards.
- A memo's stored HTML is what memos' editor renders read-only in the browser
  (`client/src/editor/render.ts`). The server only sanitizes it (`content::sanitize`) and
  reads facts back out of it (`content::derive`). Memos created through the API get
  `content::fallback_html` until a browser renders them again.
- Match memos' DOM and class strings exactly; copy them from memos' source or a captured
  page rather than writing new styles. Tailwind scans `server/templates`, `server/src` and
  `client/src`, so class names must appear there literally.
- Strings come from memos' locales in `client/locales/`. Use `c.t.s("key")` in templates,
  `t("key")` in client code; `server/build.rs` fails the build on a key missing from
  `en.json`.
- Any string literal naming a Lucide icon is added to the sprite; names built at runtime go
  in `client/icons.txt`.
- Keep `boot.ts` and its chunks under 10 KB gzipped and the first page under 30 KB
  (`client/scripts/size-check.mjs`).

## Checks

```sh
cd server && cargo test && cargo clippy
cd client && npx tsc --noEmit && node build.mjs && npx playwright test
```

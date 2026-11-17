# Fork changes

The `selfhost` branch tracks upstream `main` and carries the changes below,
aimed at a single small server (about 300 MB of memory, one CPU). Each entry
lists the files it touches and what to check when an upstream merge conflicts
with it. Keep this file current when a fork change is added, reworked, or
dropped because upstream solved it.

## Schema

**Memo list indexes** — each driver's `store/migration/{sqlite,mysql,postgres}/LATEST.sql`.

Adds `idx_memo_list_created` and `idx_memo_list_pinned_created`. On SQLite
they also cover the list predicates (`creator_id`, `visibility`, `space_id`,
`pinned`, `updated_ts`), so a page is chosen from the index alone.

There is deliberately no migration file: the fork had no data to upgrade when
the indexes were added, and the schema version stays upstream's, so upstream
migrations apply in order. A database created before this change, or by
upstream Memos, does not get the indexes; create them by hand with the
statements from `LATEST.sql`. If upstream edits the `memo` index block of a
`LATEST.sql`, keep both index lines.

## Backend

**Auto sign-in when `MEMOS_DISABLE_LOGIN=true`** — `server/api/auth_service_autologin.go`,
`server/api/connect_services.go` (`RefreshToken` calls `refreshTokenOrAutoLogin`),
`server/api/test/auth_disable_login_test.go`. A refresh without a usable token
signs in as the oldest active admin. Conflicts are most likely in
`connect_services.go` if upstream changes the `RefreshToken` handler.

**Precompressed frontend assets** — `server/frontend/frontend.go`
(`precompressedVariant`, `acceptsEncoding`), `server/frontend/frontend_test.go`,
`web/scripts/precompress-dist.mjs`, and the `release` script in
`web/package.json`. `pnpm release` writes `.br` and `.gz` copies of text assets
into `server/frontend/dist`; the handler serves the best one the browser
accepts and adds `Vary: Accept-Encoding`. HTML is never compressed. If upstream
rewrites the static handler or the `release` script, carry both halves over.

**Local link-preview hostnames rejected early** — `internal/linkmeta/html_meta.go`
(`ErrLocalHostname`, `isLocalHostname`), `internal/linkmeta/html_meta_test.go`.
Hosts under `localhost`, `local`, `home.arpa` and `internal` fail before DNS.

**SQLite memo list sorts narrow rows** — `store/db/sqlite/memo.go` (`ListMemos`).
The query picks the page in a subquery over id and sort keys, then joins the
full rows. Upstream edits to the field list, `WHERE` clauses or `ORDER BY` must
be applied to the right half: filters and ordering go in `pageQuery`, selected
columns in `fields`, and the outer `ORDER BY` uses `page.` columns.

**SQLite access predicate looks memos up by ID** — `store/db/sqlite/memo_access.go`
(the unary `+` on `row_status` in `validState`). Without it SQLite reads
`idx_memo_list_*` by `row_status` for queries that name more than about ten
memo IDs, such as related memos and comments in a list. Keep the `+` if
upstream edits the predicate.

**Memo snippets cached** — `server/api/memo_service_snippet.go` (`snippetCache`),
`server/api/memo_service_snippet_test.go`, the `snippets` field in
`server/api/api.go`, and `getMemoContentSnippet` in
`server/api/memo_service_webhooks.go`. Snippets are cached by a hash of the
content, so a changed memo misses on its own. If upstream changes the snippet
length or `GenerateSnippet`, nothing else needs to change; if it moves
`getMemoContentSnippet`, carry the lookup along.

**SQLite idle connections** — `store/db/sqlite/sqlite.go` (`SetMaxIdleConns(4)`,
`SetConnMaxIdleTime`).

**Checked filter expressions cached** — `internal/recent/` (generic cache, tests),
`internal/README.md`, `filter/engine.go` (`Engine.parsed`, used in `Compile`),
`filter/time_test.go` (`TestCompileRepeatedFilterFoldsCurrentClock`),
`filter/engine_test.go` (`BenchmarkCompileRepeatedFilter`). Only the CEL
expression is cached; the condition is rebuilt each time because it folds
`now`. If upstream changes `Compile`, keep the type check behind the cache.

**User stats read in one query** — `server/api/user_service_stats.go`.
`GetUserStats` and `ListUserStats` call `ListMemos` once instead of paging by
1,000 with `OFFSET`. Conflicts here are usually upstream edits inside the
removed paging loop; keep the single query.

**ASCII fast path for SQLite case folding** — `store/db/sqlite/functions.go`
(`foldCase`), `store/db/sqlite/functions_test.go`.

**Markdown scan shortcuts** — `markdown/parser/tag.go` (`emoji17FirstRunes`,
early return in `matchFullyQualifiedEmoji`), `markdown/extensions/gfm.go`
(`hasGFMURLPrefix`). If upstream regenerates the emoji table, the first-rune
set rebuilds itself. If upstream widens `hasValidGFMDomain` to more prefixes,
widen `hasGFMURLPrefix` to match.

**Lossless JPEG metadata stripping on upload** — `internal/jpegmeta/`
(`Strip`, `Orientation`, tests and fixtures), `internal/README.md`,
`server/api/attachment_service_image.go` (`stripImageExif`). JPEGs keep their
compressed data and only a non-default EXIF orientation; other formats, and
JPEGs that do not parse, still decode and re-encode. Uploaded JPEGs are
therefore stored unrotated with an orientation tag, unlike upstream, which
stores rotated pixels.

**Cheaper thumbnails** — `server/fileserver/fileserver.go` (`generateThumbnail`,
`probeThumbnailSource`, `resizeThumbnail`, `shrinkYCbCr`, `orientImage`, the
ASCII lowering in `hasThumbnailSensitiveMetadata`, the `GOMAXPROCS` cap on
`thumbnailSemaphore`), `server/fileserver/fileserver_test.go`,
`server/fileserver/README.md`. Decoding happens without auto-orientation;
the orientation from `jpegmeta` is applied to the 600px result. Thumbnails
must keep applying it, because fork uploads are stored unrotated.

## Frontend

**Inline JPEGs shown as thumbnails** — `web/src/components/MemoView/components/MemoBody.tsx`,
`web/src/components/MemoView/hooks/useMemoHandlers.ts`,
`web/src/utils/managed-attachment.ts` (`findInlineImageAttachment`),
`web/tests/managed-attachment.test.ts`. Clicking an inline image opens the
attachment's preview with the original.

**Settings sections loaded on demand** — `web/src/components/Settings/settingSections.ts`
(`component` is a lazy import), `web/src/pages/Setting.tsx` (`Suspense`, section
switch in `startTransition`). The sidebar imports the section list for its labels,
so eager section imports would put every section in the entry chunk. A section
added by upstream must use `lazyWithReload` too.

**Emoji catalog loaded on demand** — `web/src/hooks/useEmojiCatalog.ts`,
`web/src/components/MemoReactionListView/ReactionSelector.tsx` (the grid suspends
on the catalog and focuses its search when it mounts),
`web/src/components/MemoReactionListView/ReactionView.tsx` (`useEmojiName`), and
the `openPicker` helpers in `web/tests/reaction-selector.test.tsx` and
`web/tests/reaction-picker-window.test.tsx`. New code must import `@/lib/emoji`
through the hook, not directly, or the catalog returns to the memo list chunk.

**Fewer live-refresh refetches** — `web/src/hooks/useLiveMemoRefresh.ts`
(`handleEvent` coalesces `memo.changed` for 250 ms; `liveQueryKeys` get a
`refetchOnWindowFocus` default that is off once the stream has connected),
`web/src/hooks/useMemoQueries.ts` (`memoKeys.linkMetadata` is outside the
`memos` root, so memo events do not refetch link previews),
`web/tests/live-memo-refresh.test.tsx`. If upstream adds a key to
`invalidateAllLiveQueries`, add it to `liveQueryKeys` too.

## CI

**Fork image** — `.github/workflows/fork-image.yml`. Builds the frontend and
publishes `ghcr.io/<owner>/<repo>` for amd64 and arm64 on every push to
`selfhost`.

## Docs

**This file** and one line in `AGENTS.md` (Documentation) that points to it.

## Not in code

Set `GOMEMLIMIT` (for example `200MiB`) in the deployment environment. Go
returns freed heap to the OS slowly after bursts such as uploads; a soft limit
makes it collect before memory gets tight.

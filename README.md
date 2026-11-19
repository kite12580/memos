# memos-lite

A single-user notes app that looks like [memos](https://github.com/usememos/memos) and opens
instantly on a weak server and an old phone.

- The server (Rust, hyper, SQLite) sends finished HTML: the first page of memos is in the
  first response, and nothing waits on startup requests.
- Memo cards are HTML rendered once, when the memo is saved, by memos' own editor in the
  browser. Reading a memo runs no Markdown code anywhere.
- The always-loaded script is under 10 KB. memos' editor (about 100 KB) loads when you start
  writing.
- One static binary of about 10 MB that idles at a few MB of memory.

SQLite is the only database: search, backup and the single-connection design rely on it,
so memos' MySQL and PostgreSQL drivers have no counterpart here.

There is no login. Put it behind a reverse proxy that authenticates (Caddy, Authelia,
Tailscale, Cloudflare Access, …).

## Run with Docker

```sh
mkdir -p data
docker compose up -d   # pulls ghcr.io/kite12580/memos:latest, serves on :5230
```

To build the image from source instead:

```sh
docker compose -f docker-compose.local.yml up -d --build
```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `5230` | Listening port |
| `HOST` | `0.0.0.0` | Listening address |
| `DATA_DIR` | `data` (`/data` in Docker) | SQLite database and attachment files |
| `CLIENT_DIR` | `../client/dist` (`/client` in Docker) | Built client |
| `BASE_PATH` | empty | Sub-path the proxy serves the app under, such as `/notes`; the proxy must not strip it |
| `API_TOKEN` | empty | Enables the JSON API under `/api/memos` for this bearer token |
| `TZ` | system zone or UTC | Time zone for dates until a browser reports its own |
| `COMPRESS` | `1` | `0` leaves compressing HTML to the proxy |
| `MAX_UPLOAD_MB` | `64` | Largest attachment |

Writes from the browser must be same-origin (`Sec-Fetch-Site`), so another site cannot post
through your proxy's login cookie. If the proxy requires login for every path, let `/api/`
through with the bearer token when you use the API.

## JSON API

With `API_TOKEN` set, send `Authorization: Bearer <token>`:

- `POST /api/memos` `{"content": "…", "pinned": false, "attachments": ["uid"]}`
- `GET /api/memos?q=<search>&cursor=&limit=` — search uses the app's syntax:
  `#tag -#tag is:pinned has:task has:todo has:link has:code has:image after:2026-01 "words"`
- `GET`, `PATCH` (`content`, `pinned`, `archived`, `rev`), `DELETE /api/memos/<uid>`
- `POST /api/memos/attachments?name=<file>&type=<mime>` with the file as the body

## Backup

```sh
docker exec memos-lite /memos-lite backup /data/backup.tar
```

The archive holds a consistent copy of the database (`memos.db`) and the `attachments/`
directory. Schedule it with cron and copy it elsewhere.

## Development

```sh
cd client && npm ci && npm run build          # dist/: hashed assets, manifest.json
cd server && cargo run                         # http://localhost:5230
cd server && cargo test
cd client && npm run test:e2e                  # Playwright against a fresh server (build the server first)
cd client && node scripts/size-check.mjs       # page and asset size budgets (server running)
cd client && node scripts/trace.mjs URL 6      # load timing with the CPU slowed 6x
```

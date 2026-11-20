use crate::assets::Assets;
use crate::config::Config;
use crate::db::{Db, DbError};
use crate::http::{MIN_COMPRESS_BYTES, Request, Response, accepts, decode_path, gzip_fast};
use crate::profile::Profile;
use crate::views::{Ctx, Prefs, Search, TagStyles};
use crate::{api, actions, files, i18n, pages};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

pub struct App {
    pub db: Db,
    pub cfg: Config,
    pub assets: Assets,
    /// Bumped on every write; part of every page's ETag.
    data_version: AtomicU64,
    tags: Mutex<Option<(u64, Arc<Vec<(String, i64)>>)>>,
    tag_styles: Mutex<Arc<TagStyles>>,
    profile: Mutex<Arc<Profile>>,
    pub now: fn() -> i64,
}

pub fn server_error(e: impl std::fmt::Display) -> Response {
    eprintln!("error: {e}");
    Response::internal_error()
}

impl From<DbError> for Response {
    fn from(e: DbError) -> Response {
        server_error(e)
    }
}

impl App {
    pub fn new(db: Db, cfg: Config, assets: Assets) -> App {
        crate::h::set_sprite(format!("{}/{}", cfg.base, assets.sprite));
        let mut seed = [0u8; 4];
        let _ = getrandom::fill(&mut seed);
        let meta = db.blocking(|c| crate::db::views::tag_meta(c)).unwrap_or_default();
        let profile = db.blocking(|c| Profile::load(c)).unwrap_or_default();
        App {
            db,
            cfg,
            assets,
            data_version: AtomicU64::new(u32::from_le_bytes(seed) as u64),
            tags: Mutex::new(None),
            tag_styles: Mutex::new(Arc::new(TagStyles::new(meta))),
            profile: Mutex::new(Arc::new(profile)),
            now: crate::http::now_secs,
        }
    }

    pub fn data_version(&self) -> u64 {
        self.data_version.load(Ordering::Relaxed)
    }

    pub fn changed(&self) {
        self.data_version.fetch_add(1, Ordering::Relaxed);
    }

    /// Tag counts, recomputed only after a write.
    pub fn tag_counts(&self, c: &rusqlite::Connection) -> Result<Arc<Vec<(String, i64)>>, DbError> {
        let v = self.data_version();
        let mut cache = self.tags.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((cv, tags)) = cache.as_ref()
            && *cv == v
        {
            return Ok(tags.clone());
        }
        let tags = Arc::new(crate::db::memos::tag_counts(c)?);
        *cache = Some((v, tags.clone()));
        Ok(tags)
    }

    pub fn tag_styles(&self) -> Arc<TagStyles> {
        self.tag_styles.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    pub fn set_tag_meta(&self, meta: Vec<crate::db::views::TagMeta>) {
        *self.tag_styles.lock().unwrap_or_else(|p| p.into_inner()) = Arc::new(TagStyles::new(meta));
    }

    pub fn profile(&self) -> Arc<Profile> {
        self.profile.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    pub fn set_profile(&self, profile: Profile) {
        *self.profile.lock().unwrap_or_else(|p| p.into_inner()) = Arc::new(profile);
    }

    pub fn ctx(&self, req: &Request) -> Ctx<'_> {
        let prefs = Prefs::from_request(req, &self.cfg.tz);
        let t = i18n::T::pick(req.cookie("lang").as_deref(), req.header("accept-language"));
        Ctx {
            t,
            base: &self.cfg.base,
            css: &self.assets.css,
            boot: &self.assets.boot,
            sprite: &self.assets.sprite,
            preload: &self.assets.preload,
            render_version: &self.assets.render_version,
            theme: prefs.theme_attr(),
            system_theme: prefs.theme == "system",
            prefs,
            search: Search::default(),
            now: (self.now)(),
            tags: self.tag_styles(),
            profile: self.profile(),
        }
    }

    /// Weak validator for a page: same build, data, preferences, language and day.
    pub fn etag(&self, c: &Ctx, path: &str, query: &str) -> String {
        let day = crate::views::today(c.now, &c.prefs.tz);
        let mut h: u64 = 0xcbf29ce484222325;
        for b in path.bytes().chain(query.bytes()).chain(c.prefs.key().bytes()) {
            h = (h ^ b as u64).wrapping_mul(0x100000001b3);
        }
        format!(
            "W/\"{}-{}-{}-{}-{:x}\"",
            self.assets.render_version,
            self.data_version(),
            c.t.lang,
            day,
            h
        )
    }

    pub async fn handle(self: &Arc<App>, mut req: Request) -> Response {
        let start = Instant::now();
        let Some(rel) = req
            .path
            .strip_prefix(self.cfg.base.as_str())
            .filter(|r| r.is_empty() || r.starts_with('/'))
            .map(|r| if r.is_empty() { "/".to_string() } else { r.to_string() })
        else {
            return Response::not_found();
        };
        req.path = rel;
        let method = req.method.clone();
        let ae = req.header("accept-encoding").map(str::to_string);
        let mut res = if method != "GET" && method != "HEAD" && !req.path.starts_with("/api/") && !same_origin(&req) {
            Response::text(403, "Cross-site request refused")
        } else {
            self.route(req).await
        };
        res.set("server-timing", &format!("app;dur={:.1}", start.elapsed().as_secs_f64() * 1000.0));
        if self.cfg.compress {
            compress(&mut res, ae.as_deref());
        }
        if method == "HEAD" {
            res.body = bytes::Bytes::new();
            res.stream = None;
        }
        res
    }

    async fn route(self: &Arc<App>, mut req: Request) -> Response {
        let segs: Vec<String> = req.path.split('/').skip(1).map(decode_path).collect();
        let segs: Vec<&str> = segs.iter().map(String::as_str).collect();
        let get = req.method == "GET" || req.method == "HEAD";
        let post = req.method == "POST";
        let upload = post && matches!(segs.as_slice(), ["attachments"] | ["attachments", _, "thumb"] | ["api", "memos", "attachments"]);
        if !upload && let Err(res) = req.buffer().await {
            return res;
        }
        match (get, post, segs.as_slice()) {
            (true, _, [""]) => pages::home(self, &req, pages::Scope::Home).await,
            (true, _, ["archived"]) => pages::home(self, &req, pages::Scope::Archived).await,
            (true, _, ["memos", uid]) => pages::memo(self, &req, uid).await,
            (true, _, ["calendar"]) => pages::calendar(self, &req, None).await,
            (true, _, ["calendar", month]) => pages::calendar(self, &req, Some(month)).await,
            (true, _, ["attachments"]) => pages::attachments(self, &req).await,
            (true, _, ["views"]) => pages::views(self, &req).await,
            (true, _, ["settings"]) => pages::settings(self, &req).await,
            (true, _, ["f", "memos"]) => pages::list_fragment(self, &req).await,
            (true, _, ["f", "month"]) => pages::month_fragment(self, &req).await,
            (true, _, ["f", "composer"]) => pages::composer_fragment(self, &req),
            (true, _, ["f", "day"]) => pages::day_fragment(self, &req).await,
            (true, _, ["f", "memos", uid]) => pages::card_fragment(self, &req, uid).await,
            (true, _, ["f", "memos", uid, "source"]) => pages::source(self, uid).await,
            (true, _, ["f", "links"]) => pages::link_search(self, &req).await,
            (true, _, ["f", "attachments"]) => pages::attachments_fragment(self, &req).await,
            (true, _, ["f", "strings"]) => {
                let c = self.ctx(&req);
                Response::new(200)
                    .with("content-type", "application/json")
                    .body(c.t.client_json())
                    .with("cache-control", "private, no-cache")
                    .with("vary", "Cookie, Accept-Language")
            }
            (_, true, ["memos"]) => actions::create(self, &req).await,
            (_, true, ["memos", uid]) => actions::update(self, &req, uid).await,
            (_, true, ["memos", uid, "html"]) => actions::set_html(self, &req, uid).await,
            (_, true, ["memos", uid, "pin"]) => actions::flag(self, &req, uid, crate::db::memos::Flag::Pinned).await,
            (_, true, ["memos", uid, "archive"]) => actions::flag(self, &req, uid, crate::db::memos::Flag::Archived).await,
            (_, true, ["memos", uid, "delete"]) => actions::delete(self, uid).await,
            (_, true, ["memos", uid, "task"]) => actions::task(self, &req, uid).await,
            (_, true, ["memos", uid, "tasks"]) => actions::all_tasks(self, &req, uid).await,
            (_, true, ["memos", uid, "react"]) => actions::react(self, &req, uid).await,
            (_, true, ["attachments"]) => files::upload(self, req).await,
            (_, true, ["attachments", uid, "thumb"]) => files::upload_thumb(self, req, uid).await,
            (_, true, ["attachments", uid, "delete"]) => files::delete(self, uid).await,
            (_, true, ["views"]) => actions::save_view(self, &req).await,
            (_, true, ["views", "order"]) => actions::order_views(self, &req).await,
            (_, true, ["views", id, "delete"]) => actions::delete_view(self, id).await,
            (_, true, ["tags"]) => actions::tag_meta(self, &req).await,
            (_, true, ["prefs"]) => actions::prefs(self, &req),
            (_, true, ["profile"]) => actions::profile(self, &req).await,
            (true, _, ["avatar"]) => files::avatar(self),
            (true, _, ["thumb", uid]) => files::serve(self, &req, uid, true).await,
            (true, _, ["file", uid, _name]) => files::serve(self, &req, uid, false).await,
            (true, _, ["assets", name]) => self
                .assets
                .serve(&req, &format!("assets/{name}"))
                .unwrap_or_else(Response::not_found),
            (true, _, ["favicon.svg"]) => Response::new(200)
                .with("content-type", "image/svg+xml")
                .with("cache-control", "public, max-age=86400")
                .body(self.assets.favicon.clone()),
            (true, _, ["apple-touch-icon.png"]) => Response::new(200)
                .with("content-type", "image/png")
                .with("cache-control", "public, max-age=86400")
                .body(self.assets.touch_icon.clone()),
            (true, _, ["healthz"]) => Response::text(200, "ok"),
            (_, _, ["api", "memos", ..]) => api::handle(self, req).await,
            (true, _, _) => pages::not_found(self, &req),
            _ => Response::not_found(),
        }
    }
}

/// Writes must come from the app's own pages: browsers mark same-origin
/// requests, and the reverse proxy's login cookie must not let another site
/// post here.
fn same_origin(req: &Request) -> bool {
    if let Some(site) = req.header("sec-fetch-site") {
        return site == "same-origin";
    }
    let Some(origin) = req.header("origin") else {
        return false;
    };
    let host = req
        .header("x-forwarded-host")
        .or_else(|| req.header("host"))
        .unwrap_or("");
    origin
        .split_once("://")
        .is_some_and(|(_, h)| h.eq_ignore_ascii_case(host))
}

fn compress(res: &mut Response, accept: Option<&str>) {
    if res.stream.is_some()
        || res.body.len() < MIN_COMPRESS_BYTES
        || res.header("content-encoding").is_some()
        || !res
            .header("content-type")
            .is_some_and(|t| t.starts_with("text/html") || t.starts_with("application/json"))
    {
        return;
    }
    let vary = match res.header("vary") {
        Some(v) => format!("{v}, Accept-Encoding"),
        None => "Accept-Encoding".to_string(),
    };
    res.set("vary", &vary);
    if !accepts(accept, "gzip") {
        return;
    }
    if let Ok(gz) = gzip_fast(&res.body) {
        res.body = gz.into();
        res.set("content-encoding", "gzip");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(headers: &[(&str, &str)]) -> Request {
        let mut r = Request::get("POST", "/memos");
        r.headers = headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        r
    }

    #[test]
    fn origin_checks() {
        assert!(same_origin(&req(&[("sec-fetch-site", "same-origin")])));
        assert!(!same_origin(&req(&[("sec-fetch-site", "cross-site")])));
        assert!(!same_origin(&req(&[("sec-fetch-site", "same-site")])));
        assert!(same_origin(&req(&[("origin", "https://memo.example"), ("host", "memo.example")])));
        assert!(same_origin(&req(&[("origin", "https://a.b"), ("host", "internal:5230"), ("x-forwarded-host", "a.b")])));
        assert!(!same_origin(&req(&[("origin", "https://evil.example"), ("host", "memo.example")])));
        assert!(!same_origin(&req(&[("host", "memo.example")])));
    }
}

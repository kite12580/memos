//! GET handlers: full pages and the HTML fragments the client swaps in.

mod attachments;
mod calendar;
mod settings;
mod views;

pub use attachments::{attachments, attachments_fragment};
pub use calendar::{calendar, day_fragment};
pub use settings::settings;
pub use views::views;

use crate::app::App;
use crate::db::memos::{self, Cursor, ListQuery, Memo, Order};
use crate::db::{DbResult, attachments as atts};
use crate::h;
use crate::http::{Request, Response, encode_component};
use crate::query::{self, Atom, Has, Term};
use crate::views::{self as v, Card, CardData, Ctx, FilterChip, ListView, MonthView, Sidebar, ViewRow};
use askama::Template;
use rusqlite::Connection;
use std::collections::HashMap;
use std::sync::Arc;

pub const PAGE_SIZE: usize = 16;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    Home,
    Archived,
}

pub struct Composer {
    pub mode: &'static str,
    pub parent: String,
    pub placeholder: &'static str,
    pub save_label: &'static str,
}

impl Composer {
    pub fn new(c: &Ctx) -> Composer {
        Composer {
            mode: "create",
            parent: String::new(),
            placeholder: c.t.s("editor.any-thoughts"),
            save_label: c.t.s("editor.save"),
        }
    }

    pub fn global(c: &Ctx) -> Composer {
        Composer { mode: "global", ..Composer::new(c) }
    }

    pub fn comment(c: &Ctx, parent: &str) -> Composer {
        Composer {
            mode: "comment",
            parent: parent.to_string(),
            placeholder: c.t.s("editor.add-your-comment-here"),
            save_label: c.t.s("editor.comment"),
        }
    }
}

#[derive(Template)]
#[template(path = "pages/home.html")]
struct HomePage<'a> {
    c: Ctx<'a>,
    sb: Sidebar,
    title: String,
    heading: String,
    composer: Option<Composer>,
    filters: Vec<FilterChip>,
    list: ListView,
    list_url: String,
    clear_href: String,
    highlight: String,
}

#[derive(Template)]
#[template(path = "pages/memo.html")]
struct MemoPage<'a> {
    c: Ctx<'a>,
    sb: Sidebar,
    title: String,
    card: Card,
    comments: Vec<Card>,
    composer: Option<Composer>,
}

#[derive(Template)]
#[template(path = "pages/stub.html")]
struct StubPage<'a> {
    c: Ctx<'a>,
    sb: Sidebar,
    title: &'static str,
}

/// The app's own page for a path or memo that does not exist.
pub fn not_found(app: &App, req: &Request) -> Response {
    let c = app.ctx(req);
    let title = c.t.s("error.not-found");
    let mut res = html(&StubPage { c, sb: Sidebar::default(), title });
    res.status = 404;
    res.with("cache-control", "no-store")
}

#[derive(Template)]
#[template(source = "{% include \"partials/memo_list.html\" %}", ext = "html")]
struct ListFragment<'a> {
    c: Ctx<'a>,
    list: ListView,
}

#[derive(Template)]
#[template(source = "{% let m = card %}{% include \"partials/card.html\" %}", ext = "html")]
struct CardFragment<'a> {
    c: Ctx<'a>,
    card: Card,
}

#[derive(Template)]
#[template(source = "{% include \"partials/composer.html\" %}", ext = "html")]
struct ComposerFragment<'a> {
    c: Ctx<'a>,
    composer: Composer,
}

pub fn composer_fragment(app: &Arc<App>, req: &Request) -> Response {
    let c = app.ctx(req);
    let composer = Composer::global(&c);
    html(&ComposerFragment { c, composer })
}

#[derive(Template)]
#[template(source = "{% include \"partials/month.html\" %}", ext = "html")]
struct MonthFragment<'a> {
    c: Ctx<'a>,
    month: MonthView,
}

pub fn html(t: &impl Template) -> Response {
    match t.render() {
        Ok(s) => Response::html(s),
        Err(e) => crate::app::server_error(e),
    }
}

/// The page's ETag, or a 304 when the browser's copy is current.
pub fn validator(app: &App, req: &Request, c: &Ctx) -> Result<String, Response> {
    let etag = app.etag(c, &req.path, &req.query);
    if req.header("if-none-match") == Some(etag.as_str()) {
        return Err(Response::new(304).with("etag", &etag));
    }
    Ok(etag)
}

pub fn page(etag: &str, t: &impl Template) -> Response {
    html(t)
        .with("etag", etag)
        .with("cache-control", "private, no-cache")
        .with("vary", "Cookie, Accept-Language")
}

/// Everything the cards on a page show besides the memos themselves.
pub struct Extras {
    pub attachments: HashMap<i64, Vec<atts::Attachment>>,
    pub reactions: HashMap<i64, Vec<String>>,
    pub relations: HashMap<i64, memos::Links>,
    pub comments: HashMap<i64, Vec<Memo>>,
}

impl Extras {
    pub fn load(c: &Connection, ms: &[Memo], comment_previews: bool) -> DbResult<Extras> {
        let ids: Vec<i64> = ms.iter().map(|m| m.id).collect();
        let with_comments: Vec<i64> = ms.iter().filter(|m| m.comment_count > 0).map(|m| m.id).collect();
        Ok(Extras {
            attachments: atts::for_memos(c, &ids)?,
            reactions: memos::reactions(c, &ids)?,
            relations: memos::relations(c, &ids)?,
            comments: if comment_previews {
                memos::latest_comments(c, &with_comments, 3)?
            } else {
                HashMap::new()
            },
        })
    }

    pub fn data(&self) -> CardData<'_> {
        CardData {
            attachments: &self.attachments,
            reactions: &self.reactions,
            relations: &self.relations,
            comments: &self.comments,
        }
    }
}

pub struct Collection {
    pub memos: Vec<Memo>,
    pub next: Option<Cursor>,
    pub extras: Extras,
    pub tags: Arc<Vec<(String, i64)>>,
    pub month: Vec<i64>,
    pub views: Vec<crate::db::views::View>,
    pub view: Option<crate::db::views::View>,
}

/// The saved view `?view=` names, if any, and the search text with it.
pub fn view_and_query(req: &Request) -> (Option<i64>, String) {
    (
        req.query("view").and_then(|v| v.parse().ok()),
        req.query("q").unwrap_or_default(),
    )
}

pub fn list_query(c: &Ctx, scope: Scope, terms: Vec<Term>, cursor: Option<Cursor>) -> ListQuery {
    ListQuery {
        scope: match scope {
            Scope::Home => memos::Scope::Normal,
            Scope::Archived => memos::Scope::Archived,
        },
        terms,
        order: Order {
            by_updated: c.prefs.by_updated,
            asc: c.prefs.asc,
        },
        cursor,
        limit: PAGE_SIZE,
        tz: c.prefs.tz.clone(),
    }
}

pub fn month_start_of(c: &Ctx, terms: &[Term]) -> jiff::civil::Date {
    for t in terms {
        if let Atom::On(d) | Atom::After(d) | Atom::Before(d) = &t.atom {
            let mut parts = d.split('-').map(|p| p.parse::<i32>().ok());
            if let (Some(Some(y)), Some(Some(m))) = (parts.next(), parts.next()) {
                return v::month_start(y as i16, m as i8);
            }
        }
    }
    let today = v::today(c.now, &c.prefs.tz);
    v::month_start(today.year(), today.month())
}

/// The day an `on:` search narrows to, which the sidebar calendar marks.
pub fn selected_day(terms: &[Term]) -> Option<&str> {
    terms.iter().find_map(|t| match &t.atom {
        Atom::On(d) if !t.neg && d.len() == 10 => Some(d.as_str()),
        _ => None,
    })
}

pub fn view_rows(views: &[crate::db::views::View], links: &Filters) -> Vec<ViewRow> {
    views
        .iter()
        .map(|w| ViewRow {
            id: w.id,
            name: w.name.clone(),
            icon: w.icon.clone(),
            href: links.view(w.id),
        })
        .collect()
}

fn chips(c: &Ctx, base_href: &str, view: Option<&crate::db::views::View>, terms: &[Term]) -> Vec<FilterChip> {
    let mut out = vec![];
    if let Some(w) = view {
        out.push(FilterChip {
            icon: "funnel",
            label: w.name.clone(),
            remove_href: with_query(base_href, None, &query::format(terms)),
        });
    }
    for (i, term) in terms.iter().enumerate() {
        let rest: Vec<Term> = terms
            .iter()
            .enumerate()
            .filter(|(j, _)| *j != i)
            .map(|(_, t)| t.clone())
            .collect();
        let (icon, label) = match &term.atom {
            Atom::Tag(t) => ("hash", t.clone()),
            Atom::Pinned => ("bookmark", c.t.s("memo.pinned").to_string()),
            Atom::Has(h) => (
                match h {
                    Has::Task | Has::Todo => "square-check",
                    Has::Link => "link",
                    Has::Code => "code",
                    Has::Image | Has::Media => "image",
                    Has::Attachment => "paperclip",
                    Has::Tag => "hash",
                    Has::Comment => "message-circle",
                    Has::Ref => "milestone",
                    Has::Reaction => "smile",
                },
                term.source(),
            ),
            Atom::Before(_) | Atom::After(_) | Atom::On(_) => ("calendar", term.source()),
            Atom::Text(t) => ("search", t.clone()),
        };
        let label = if term.neg && !label.starts_with('-') { format!("-{label}") } else { label };
        out.push(FilterChip {
            icon,
            label,
            remove_href: with_query(base_href, view.map(|w| w.id), &query::format(&rest)),
        });
    }
    out
}

pub fn with_query(path: &str, view: Option<i64>, q: &str) -> String {
    let mut parts = vec![];
    if let Some(id) = view {
        parts.push(format!("view={id}"));
    }
    if !q.is_empty() {
        parts.push(format!("q={}", encode_component(q)));
    }
    if parts.is_empty() { path.to_string() } else { format!("{path}?{}", parts.join("&")) }
}

fn scope_path(scope: Scope) -> &'static str {
    match scope {
        Scope::Home => "/",
        Scope::Archived => "/archived",
    }
}

pub fn active_tag(terms: &[Term]) -> Option<String> {
    let mut tags = terms.iter().filter_map(|t| match &t.atom {
        Atom::Tag(tag) if !t.neg => Some(tag),
        _ => None,
    });
    match (tags.next(), tags.next()) {
        (Some(tag), None) => Some(tag.clone()),
        _ => None,
    }
}

/// The words of a search, for the client to highlight in memo bodies.
fn search_words(terms: &[Term]) -> String {
    let words: Vec<&str> = terms
        .iter()
        .filter_map(|t| match &t.atom {
            Atom::Text(w) if !t.neg => Some(w.as_str()),
            _ => None,
        })
        .collect();
    if words.is_empty() { String::new() } else { serde_json::to_string(&words).unwrap_or_default() }
}

pub struct Filters {
    pub path: String,
    pub view: Option<i64>,
    pub terms: Vec<Term>,
}

impl Filters {
    pub fn home(base: &str) -> Filters {
        Filters { path: format!("{base}/"), view: None, terms: vec![] }
    }

    fn with(&self, keep: impl Fn(&Atom) -> bool, add: Option<Atom>) -> String {
        let mut terms: Vec<Term> = self.terms.iter().filter(|t| t.neg || keep(&t.atom)).cloned().collect();
        terms.extend(add.map(|atom| Term { neg: false, atom }));
        with_query(&self.path, self.view, &query::format(&terms))
    }

    pub fn tag(&self, tag: &str) -> String {
        let on = active_tag(&self.terms).as_deref() == Some(tag);
        self.with(|a| !matches!(a, Atom::Tag(_)), (!on).then(|| Atom::Tag(tag.to_string())))
    }

    pub fn view(&self, id: i64) -> String {
        let view = (self.view != Some(id)).then_some(id);
        with_query(&self.path, view, &query::format(&self.terms))
    }

    pub fn day(&self, day: &str) -> String {
        self.with(|a| !matches!(a, Atom::On(_)), Some(Atom::On(day.to_string())))
    }
}

pub fn collection_sidebar(c: &Ctx, data: &Collection, active: &'static str, stats: Option<jiff::civil::Date>, links: &Filters) -> Sidebar {
    let terms = &links.terms;
    Sidebar {
        active,
        stats: stats.map(|start| v::month_view(&c.t, start, &data.month, &c.prefs.tz, c.now, selected_day(terms), &|d| links.day(d))),
        views: Some(view_rows(&data.views, links)),
        active_view: data.view.as_ref().map(|w| w.id),
        tags: Some(v::tag_rows(&data.tags, c.prefs.tag_tree, active_tag(terms).as_deref(), &|t| links.tag(t))),
        ..Default::default()
    }
}

pub fn cards(c: &Ctx, ms: &[Memo], extras: &Extras, in_list: bool) -> Vec<Card> {
    let d = extras.data();
    ms.iter().map(|m| v::card(c, m, &d, in_list)).collect()
}

pub async fn home(app: &Arc<App>, req: &Request, scope: Scope) -> Response {
    let mut c = app.ctx(req);
    let etag = match validator(app, req, &c) {
        Ok(etag) => etag,
        Err(not_modified) => return not_modified,
    };
    let (view_id, q) = view_and_query(req);
    let terms = query::parse(&q);
    c.search.q = q.clone();
    let month = month_start_of(&c, &terms);
    let (from, to) = v::month_range(month, &c.prefs.tz);
    let lq = list_query(&c, scope, terms.clone(), None);
    let archived = scope == Scope::Archived;
    let app2 = app.clone();
    let data = app
        .db
        .with(move |conn| {
            let views = crate::db::views::list(conn)?;
            let view = view_id.and_then(|id| views.iter().find(|w| w.id == id).cloned());
            let mut lq = lq;
            if let Some(w) = &view {
                let mut all = query::parse(&w.query);
                all.extend(lq.terms);
                lq.terms = all;
            }
            let (ms, next) = memos::list(conn, &lq)?;
            let extras = Extras::load(conn, &ms, true)?;
            Ok(Collection {
                extras,
                memos: ms,
                next,
                tags: if archived { app2.archived_tag_counts(conn)? } else { app2.tag_counts(conn)? },
                month: memos::created_between(conn, from, to, archived)?,
                views,
                view,
            })
        })
        .await;
    let data = match data {
        Ok(d) => d,
        Err(e) => return e.into(),
    };
    let path = format!("{}{}", c.base, scope_path(scope));
    let view_q = with_query("", view_id, &q);
    let list_url = format!(
        "{}/f/memos?scope={}{}",
        c.base,
        if scope == Scope::Archived { "archived" } else { "home" },
        view_q.strip_prefix('?').map(|s| format!("&{s}")).unwrap_or_default()
    );
    let links = Filters { path: path.clone(), view: view_id, terms: terms.clone() };
    let sb = collection_sidebar(&c, &data, if scope == Scope::Home { "timeline" } else { "" }, Some(month), &links);
    c.search.path = scope_path(scope);
    c.search.view = data.view.as_ref().map(|w| (w.id, w.name.clone()));
    let filters = chips(&c, &path, data.view.as_ref(), &terms);
    let list = ListView {
        cards: cards(&c, &data.memos, &data.extras, true),
        next: data.next.map(|cur| format!("{list_url}&cursor={}", cur.encode())),
    };
    let composer = (scope == Scope::Home).then(|| Composer::new(&c));
    let heading = if scope == Scope::Archived { c.t.s("common.archived").to_string() } else { String::new() };
    let title = if heading.is_empty() { c.title().to_string() } else { c.page_title(&heading) };
    let p = HomePage {
        sb,
        title,
        heading,
        composer,
        filters,
        list,
        list_url,
        clear_href: path,
        highlight: search_words(&terms),
        c,
    };
    page(&etag, &p)
}

pub async fn list_fragment(app: &Arc<App>, req: &Request) -> Response {
    let c = app.ctx(req);
    let scope = if req.query("scope").as_deref() == Some("archived") { Scope::Archived } else { Scope::Home };
    let (view_id, q) = view_and_query(req);
    let cursor = req.query("cursor").and_then(|s| Cursor::decode(&s));
    let lq = list_query(&c, scope, query::parse(&q), cursor);
    let data = app
        .db
        .with(move |conn| {
            let mut lq = lq;
            if let Some(w) = view_id.map(|id| crate::db::views::get(conn, id)).transpose()?.flatten() {
                let mut all = query::parse(&w.query);
                all.extend(lq.terms);
                lq.terms = all;
            }
            let (ms, next) = memos::list(conn, &lq)?;
            let extras = Extras::load(conn, &ms, true)?;
            Ok((ms, next, extras))
        })
        .await;
    let (ms, next, extras) = match data {
        Ok(d) => d,
        Err(e) => return e.into(),
    };
    let base_url = format!("{}{}?{}", c.base, req.path, strip_cursor(&req.query));
    let list = ListView {
        cards: cards(&c, &ms, &extras, true),
        next: next.map(|cur| format!("{base_url}&cursor={}", cur.encode())),
    };
    html(&ListFragment { c, list }).with("cache-control", "private, no-cache")
}

fn strip_cursor(query: &str) -> String {
    query
        .split('&')
        .filter(|p| !p.starts_with("cursor="))
        .collect::<Vec<_>>()
        .join("&")
}

pub async fn month_fragment(app: &Arc<App>, req: &Request) -> Response {
    let c = app.ctx(req);
    let month = req
        .query("m")
        .and_then(|m| {
            let (y, mo) = m.split_once('-')?;
            Some(v::month_start(y.parse().ok()?, mo.parse().ok()?))
        })
        .unwrap_or_else(|| month_start_of(&c, &[]));
    let q = req.query("q").unwrap_or_default();
    let terms = query::parse(&q);
    let scope = if req.query("scope").as_deref() == Some("archived") { Scope::Archived } else { Scope::Home };
    let links = Filters {
        path: format!("{}{}", c.base, scope_path(scope)),
        view: req.query("view").and_then(|v| v.parse().ok()),
        terms: terms.clone(),
    };
    let (from, to) = v::month_range(month, &c.prefs.tz);
    let created = match app.db.with(move |conn| memos::created_between(conn, from, to, scope == Scope::Archived)).await {
        Ok(v) => v,
        Err(e) => return e.into(),
    };
    let month = v::month_view(&c.t, month, &created, &c.prefs.tz, c.now, selected_day(&terms), &|d| links.day(d));
    html(&MonthFragment { c, month })
}

pub async fn card_fragment(app: &Arc<App>, req: &Request, uid: &str) -> Response {
    let c = app.ctx(req);
    let in_list = req.query("list").as_deref() == Some("1");
    let uid = uid.to_string();
    let data = app
        .db
        .with(move |conn| {
            let Some(m) = memos::get(conn, &uid)? else {
                return Ok(None);
            };
            let ms = vec![m];
            let extras = Extras::load(conn, &ms, in_list)?;
            Ok(Some((ms, extras)))
        })
        .await;
    match data {
        Ok(Some((ms, extras))) => {
            let card = v::card(&c, &ms[0], &extras.data(), in_list);
            html(&CardFragment { c, card }).with("cache-control", "no-store")
        }
        Ok(None) => Response::not_found(),
        Err(e) => e.into(),
    }
}

/// What the editor needs to edit a memo.
pub async fn source(app: &Arc<App>, uid: &str) -> Response {
    let uid = uid.to_string();
    let base = app.cfg.base.clone();
    let data = app
        .db
        .with(move |conn| {
            let Some(m) = memos::get(conn, &uid)? else {
                return Ok(None);
            };
            let a = atts::for_memos(conn, &[m.id])?.remove(&m.id).unwrap_or_default();
            let r = memos::relations(conn, &[m.id])?.remove(&m.id).unwrap_or_default().0;
            Ok(Some((m, a, r)))
        })
        .await;
    match data {
        Ok(Some((m, a, r))) => Response::json(
            200,
            &serde_json::json!({
                "uid": m.uid,
                "rev": m.rev,
                "content": m.content,
                "createdTs": m.created_ts,
                "updatedTs": m.updated_ts,
                "attachments": a.iter().map(|x| attachment_json(&base, x)).collect::<Vec<_>>(),
                "relations": r.iter().map(|l| serde_json::json!({"uid": l.uid, "snippet": l.snippet})).collect::<Vec<_>>(),
            }),
        )
        .with("cache-control", "no-store"),
        Ok(None) => Response::not_found(),
        Err(e) => e.into(),
    }
}

pub fn attachment_json(base: &str, a: &atts::Attachment) -> serde_json::Value {
    serde_json::json!({
        "uid": a.uid,
        "filename": a.filename,
        "type": a.mime,
        "kind": a.kind.as_str(),
        "size": a.size,
        "url": v::file_url(base, a),
        "thumb": v::thumb_url(base, a),
        "width": a.width,
        "height": a.height,
    })
}

pub async fn link_search(app: &Arc<App>, req: &Request) -> Response {
    let q = req.query("q").unwrap_or_default();
    let exclude = req.query("exclude");
    let data = app
        .db
        .with(move |conn| {
            let ex = match exclude {
                Some(uid) => memos::get(conn, &uid)?.map(|m| m.id),
                None => None,
            };
            memos::search_links(conn, &q, ex, 20)
        })
        .await;
    match data {
        Ok(links) => Response::json(
            200,
            &serde_json::Value::Array(
                links
                    .iter()
                    .map(|l| serde_json::json!({"uid": l.uid, "snippet": l.snippet, "createdTs": l.created_ts}))
                    .collect(),
            ),
        ),
        Err(e) => e.into(),
    }
}

pub async fn memo(app: &Arc<App>, req: &Request, uid: &str) -> Response {
    let c = app.ctx(req);
    let etag = match validator(app, req, &c) {
        Ok(etag) => etag,
        Err(not_modified) => return not_modified,
    };
    let uid_owned = uid.to_string();
    let data = app
        .db
        .with(move |conn| {
            let Some(m) = memos::get(conn, &uid_owned)? else {
                return Ok(None);
            };
            let comments = memos::comments(conn, m.id)?;
            let mut all = vec![m];
            all.extend(comments);
            let extras = Extras::load(conn, &all, false)?;
            Ok(Some((all, extras)))
        })
        .await;
    let (all, extras) = match data {
        Ok(Some(d)) => d,
        Ok(None) => return not_found(app, req),
        Err(e) => return e.into(),
    };
    let mut cards = cards(&c, &all, &extras, false);
    let card = cards.remove(0);
    let title = c.page_title(all[0].snippet.chars().take(60).collect::<String>().trim());
    cards.reverse();
    let sb = Sidebar {
        active: "memo",
        memo: Some(v::MemoSide::new(&card, &all[0].html, cards.len())),
        ..Default::default()
    };
    let composer = (!card.archived).then(|| Composer::comment(&c, &card.uid));
    let p = MemoPage {
        sb,
        title,
        card,
        comments: cards,
        composer,
        c,
    };
    page(&etag, &p)
}

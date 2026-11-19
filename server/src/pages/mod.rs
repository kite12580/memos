//! GET handlers: full pages and the HTML fragments the client swaps in.

mod attachments;
mod calendar;
mod settings;
mod views;

pub use attachments::{attachments, attachments_fragment};
pub use calendar::calendar;
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

pub const PAGE_SIZE: usize = 20;

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

    pub fn comment(c: &Ctx, parent: &str) -> Composer {
        Composer {
            mode: "comment",
            parent: parent.to_string(),
            placeholder: c.t.s("editor.any-thoughts"),
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

/// A page response, or 304 when the browser's copy is current.
pub fn page(app: &App, req: &Request, c: &Ctx, t: &impl Template) -> Response {
    let etag = app.etag(c, &req.path, &req.query);
    if req.header("if-none-match") == Some(etag.as_str()) {
        return Response::new(304).with("etag", &etag);
    }
    html(t)
        .with("etag", &etag)
        .with("cache-control", "private, no-cache")
        .with("vary", "Cookie, Accept-Language")
}

/// Everything the cards on a page show besides the memos themselves.
pub struct Extras {
    pub attachments: HashMap<i64, Vec<atts::Attachment>>,
    pub reactions: HashMap<i64, Vec<String>>,
    pub relations: HashMap<i64, (Vec<memos::MemoLink>, Vec<memos::MemoLink>)>,
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

pub fn view_rows(views: &[crate::db::views::View]) -> Vec<ViewRow> {
    views
        .iter()
        .map(|w| ViewRow {
            id: w.id,
            name: w.name.clone(),
            icon: w.icon.clone(),
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
    match terms {
        [Term { neg: false, atom: Atom::Tag(t) }] => Some(t.clone()),
        _ => None,
    }
}

pub fn collection_sidebar(c: &Ctx, data: &Collection, active: &'static str, stats: Option<jiff::civil::Date>, active_tag: Option<&str>) -> Sidebar {
    Sidebar {
        active,
        stats: stats.map(|start| v::month_view(&c.t, c.base, start, &data.month, &c.prefs.tz, c.now)),
        views: Some(view_rows(&data.views)),
        active_view: data.view.as_ref().map(|w| w.id),
        tags: Some(v::tag_rows(c.base, &data.tags, c.prefs.tag_tree, active_tag)),
        sections: None,
    }
}

pub fn cards(c: &Ctx, ms: &[Memo], extras: &Extras, in_list: bool) -> Vec<Card> {
    let d = extras.data();
    ms.iter().map(|m| v::card(c, m, &d, in_list)).collect()
}

pub async fn home(app: &Arc<App>, req: &Request, scope: Scope) -> Response {
    let mut c = app.ctx(req);
    let (view_id, q) = view_and_query(req);
    let terms = query::parse(&q);
    c.q = q.clone();
    let month = month_start_of(&c, &terms);
    let (from, to) = v::month_range(month, &c.prefs.tz);
    let lq = list_query(&c, scope, terms.clone(), None);
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
                tags: app2.tag_counts(conn)?,
                month: memos::created_between(conn, from, to)?,
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
    let tag = active_tag(&terms);
    let sb = collection_sidebar(&c, &data, if scope == Scope::Home { "timeline" } else { "" }, Some(month), tag.as_deref());
    let filters = chips(&c, &path, data.view.as_ref(), &terms);
    let list = ListView {
        cards: cards(&c, &data.memos, &data.extras, true),
        next: data.next.map(|cur| format!("{list_url}&cursor={}", cur.encode())),
    };
    let composer = (scope == Scope::Home).then(|| Composer::new(&c));
    let heading = if scope == Scope::Archived { c.t.s("common.archived").to_string() } else { String::new() };
    let title = if heading.is_empty() { "Memos".to_string() } else { format!("{heading} · Memos") };
    let p = HomePage {
        sb,
        title,
        heading,
        composer,
        filters,
        list,
        list_url,
        clear_href: path,
        c,
    };
    page(app, req, &p.c, &p)
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
    let (from, to) = v::month_range(month, &c.prefs.tz);
    let created = match app.db.with(move |conn| memos::created_between(conn, from, to)).await {
        Ok(v) => v,
        Err(e) => return e.into(),
    };
    let month = v::month_view(&c.t, c.base, month, &created, &c.prefs.tz, c.now);
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
    let uid_owned = uid.to_string();
    let today = v::today(c.now, &c.prefs.tz);
    let month = v::month_start(today.year(), today.month());
    let (from, to) = v::month_range(month, &c.prefs.tz);
    let app2 = app.clone();
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
            Ok(Some((
                all,
                extras,
                app2.tag_counts(conn)?,
                memos::created_between(conn, from, to)?,
                crate::db::views::list(conn)?,
            )))
        })
        .await;
    let (all, extras, tags, created, views) = match data {
        Ok(Some(d)) => d,
        Ok(None) => return Response::not_found(),
        Err(e) => return e.into(),
    };
    let mut cards = cards(&c, &all, &extras, false);
    let card = cards.remove(0);
    let title = format!(
        "{} · Memos",
        all[0].snippet.chars().take(60).collect::<String>().trim()
    );
    let sb = Sidebar {
        active: "",
        stats: Some(v::month_view(&c.t, c.base, month, &created, &c.prefs.tz, c.now)),
        views: Some(view_rows(&views)),
        active_view: None,
        tags: Some(v::tag_rows(c.base, &tags, c.prefs.tag_tree, None)),
        sections: None,
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
    page(app, req, &p.c, &p)
}

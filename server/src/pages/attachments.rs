use crate::app::App;
use crate::db::attachments::{self as atts, Attachment, Kind, Section};
use crate::h::{self, Html};
use crate::http::{Request, Response, encode_component};
use crate::views::{self as v, Ctx, NavGroup, NavRow, Sidebar};
use askama::Template;
use jiff::Timestamp;
use std::sync::Arc;

const PAGE_SIZE: usize = 50;
const UNUSED_LIMIT: usize = 1000;
const MONTHS_SHORT: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

pub struct Item {
    pub uid: String,
    pub name: String,
    pub href: String,
    pub thumb: String,
    pub kind: Kind,
    pub memo: Option<String>,
    type_label: String,
    size_label: String,
    date_iso: String,
    date: String,
}

impl Item {
    pub fn is_video(&self) -> bool {
        self.kind == Kind::Video
    }

    pub fn is_image(&self) -> bool {
        self.kind == Kind::Image
    }

    pub fn is_audio(&self) -> bool {
        self.kind == Kind::Audio
    }

    fn date_html(&self) -> String {
        format!(r#"<time data-fmt="date" datetime="{}">{}</time>"#, self.date_iso, self.date)
    }

    /// memos' AttachmentMetadataLine: the values with dots between.
    fn meta_line(items: &[String], class: &str) -> Html {
        let mut s = format!(
            r#"<div class="flex items-center gap-1.5 overflow-x-auto whitespace-nowrap mu-caption text-mu-text-secondary [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden {class}">"#
        );
        for (i, item) in items.iter().enumerate() {
            s.push_str(r#"<span class="contents">"#);
            if i > 0 {
                s.push_str(r#"<span class="shrink-0 text-mu-text-secondary/50">•</span>"#);
            }
            s.push_str(&format!(r#"<span class="shrink-0">{item}</span></span>"#));
        }
        s.push_str("</div>");
        Html(s)
    }

    pub fn media_meta(&self) -> Html {
        Item::meta_line(&[h::escape(&self.type_label), self.date_html()], "min-w-0")
    }

    pub fn file_meta(&self) -> Html {
        Item::meta_line(&[h::escape(&self.type_label), h::escape(&self.size_label), self.date_html()], "min-w-0 max-w-full")
    }

    pub fn date_meta(&self) -> Html {
        Item::meta_line(&[self.date_html()], "min-w-0 max-w-full")
    }
}

pub struct MonthGroup {
    pub key: String,
    pub label: String,
    pub items: Vec<Item>,
}

#[derive(Default)]
pub struct Library {
    pub media: Vec<MonthGroup>,
    pub documents: Vec<Item>,
    pub audio: Vec<Item>,
    pub unused: Vec<Item>,
    pub next: Option<String>,
}

#[derive(Template)]
#[template(path = "pages/attachments.html")]
struct AttachmentsPage<'a> {
    c: Ctx<'a>,
    sb: Sidebar,
    title: String,
    tab: Section,
    counts: [i64; 4],
    lib: Library,
}

impl AttachmentsPage<'_> {
    fn is(&self, tab: &str) -> bool {
        self.tab.as_str() == tab
    }

    fn n(&self, i: usize) -> i64 {
        self.counts[i]
    }

    fn total(&self) -> i64 {
        self.counts[0] + self.counts[1] + self.counts[2]
    }
}

#[derive(Template)]
#[template(path = "partials/attachment_page.html")]
struct AttachmentsFragment<'a> {
    c: Ctx<'a>,
    lib: Library,
}

/// memos' formatFileSize: bytes, then one decimal of the largest unit.
pub(super) fn file_size(bytes: i64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    if bytes <= 0 {
        return "0 B".into();
    }
    let i = ((bytes as f64).ln() / 1024f64.ln()).floor().min(4.0) as usize;
    if i == 0 {
        return format!("{bytes} B");
    }
    format!("{:.1} {}", bytes as f64 / 1024f64.powi(i as i32), UNITS[i])
}

/// memos' getFileTypeLabel.
fn type_label(mime: &str) -> String {
    let mime = mime.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    if mime.is_empty() {
        return "File".into();
    }
    let special = match mime.as_str() {
        "application/pdf" => Some("PDF"),
        "application/zip" | "application/x-zip-compressed" => Some("ZIP"),
        "application/json" => Some("JSON"),
        "application/xml" => Some("XML"),
        "text/plain" => Some("TXT"),
        "text/html" => Some("HTML"),
        "text/css" => Some("CSS"),
        "text/javascript" | "application/javascript" => Some("JS"),
        "image/jpeg" | "image/jpg" => Some("JPEG"),
        "image/webp" => Some("WebP"),
        "image/svg+xml" => Some("SVG"),
        "video/quicktime" => Some("MOV"),
        "audio/mpeg" => Some("MP3"),
        _ => None,
    };
    if let Some(s) = special {
        return s.into();
    }
    let (category, subtype) = mime.split_once('/').unwrap_or((&mime, ""));
    if subtype.is_empty() { category.to_uppercase() } else { subtype.to_uppercase() }
}

fn item(c: &Ctx, a: &Attachment, memo: Option<String>) -> Item {
    let (date, date_iso) = Timestamp::from_second(a.created_ts)
        .map(|t| {
            let d = t.to_zoned_datetime(c.prefs.tz.clone()).date();
            (format!("{} {}, {}", MONTHS_SHORT[d.month() as usize - 1], d.day(), d.year()), h::iso(a.created_ts))
        })
        .unwrap_or_default();
    Item {
        uid: a.uid.clone(),
        name: a.filename.clone(),
        href: v::file_url(c.base, a),
        thumb: v::thumb_url(c.base, a),
        kind: a.kind,
        memo,
        type_label: type_label(&a.mime),
        size_label: file_size(a.size),
        date_iso,
        date,
    }
}

fn library(c: &Ctx, tab: Section, rows: Vec<(Attachment, Option<String>)>, limit: usize) -> Library {
    let mut lib = Library::default();
    if rows.len() > limit {
        lib.next = rows.get(limit - 1).map(|(a, _)| {
            format!("{}/f/attachments?tab={}&before={}", c.base, tab.as_str(), a.id)
        });
    }
    for (a, memo) in rows.into_iter().take(limit) {
        if tab == Section::Unused {
            lib.unused.push(item(c, &a, memo));
            continue;
        }
        let key = Timestamp::from_second(a.created_ts)
            .map(|t| t.to_zoned_datetime(c.prefs.tz.clone()).date())
            .ok();
        let it = item(c, &a, memo);
        match a.kind {
            Kind::Image | Kind::Video => {
                let (k, label) = key.map_or((String::new(), String::new()), |d| {
                    (d.strftime("%Y-%m").to_string(), format!("{} {}", MONTHS_SHORT[d.month() as usize - 1], d.year()))
                });
                match lib.media.last_mut() {
                    Some(g) if g.key == k => g.items.push(it),
                    _ => lib.media.push(MonthGroup { key: k, label, items: vec![it] }),
                }
            }
            Kind::Audio => lib.audio.push(it),
            Kind::File => lib.documents.push(it),
        }
    }
    lib
}

fn sidebar(c: &Ctx, tab: Section, counts: [i64; 4]) -> Sidebar {
    let rows = [
        (Section::All, "list", c.t.s("common.all"), counts[0] + counts[1] + counts[2]),
        (Section::Media, "image", c.t.s("attachment-library.tabs.media"), counts[0]),
        (Section::Audio, "file-headphone", c.t.s("attachment-library.tabs.audio"), counts[1]),
        (Section::Documents, "file-text", c.t.s("attachment-library.tabs.documents"), counts[2]),
        (Section::Unused, "trash-2", c.t.s("attachment-library.labels.unused"), counts[3]),
    ];
    Sidebar {
        active: "attachments",
        sections: Some(vec![NavGroup {
            title: c.t.s("common.attachments"),
            rows: rows
                .into_iter()
                .map(|(s, icon, label, n)| NavRow {
                    href: if s == Section::All {
                        format!("{}/attachments", c.base)
                    } else {
                        format!("{}/attachments?tab={}", c.base, encode_component(s.as_str()))
                    },
                    icon,
                    label: label.to_string(),
                    title: String::new(),
                    count: (n > 0).then_some(n),
                    active: s == tab,
                })
                .collect(),
        }]),
        ..Default::default()
    }
}

fn limit_for(tab: Section) -> usize {
    if tab == Section::Unused { UNUSED_LIMIT } else { PAGE_SIZE }
}

pub async fn attachments(app: &Arc<App>, req: &Request) -> Response {
    let c = app.ctx(req);
    let etag = match super::validator(app, req, &c) {
        Ok(etag) => etag,
        Err(not_modified) => return not_modified,
    };
    let tab = Section::parse(&req.query("tab").unwrap_or_default());
    let limit = limit_for(tab);
    let data = app
        .db
        .with(move |conn| Ok((atts::section_counts(conn)?, atts::library(conn, tab, None, limit + 1)?)))
        .await;
    let (counts, rows) = match data {
        Ok(d) => d,
        Err(e) => return e.into(),
    };
    let p = AttachmentsPage {
        title: c.page_title(c.t.s("common.attachments")),
        sb: sidebar(&c, tab, counts),
        lib: library(&c, tab, rows, limit),
        tab,
        counts,
        c,
    };
    super::page(&etag, &p)
}

/// The next page of a library section, as the parts the page appends.
pub async fn attachments_fragment(app: &Arc<App>, req: &Request) -> Response {
    let c = app.ctx(req);
    let tab = Section::parse(&req.query("tab").unwrap_or_default());
    let before = req.query("before").and_then(|b| b.parse().ok());
    let limit = limit_for(tab);
    let rows = match app.db.with(move |conn| atts::library(conn, tab, before, limit + 1)).await {
        Ok(r) => r,
        Err(e) => return e.into(),
    };
    let lib = library(&c, tab, rows, limit);
    super::html(&AttachmentsFragment { c, lib }).with("cache-control", "private, no-cache")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels() {
        assert_eq!(file_size(10), "10 B");
        assert_eq!(file_size(30515), "29.8 KB");
        assert_eq!(file_size(32 * 1024 * 1024), "32.0 MB");
        assert_eq!(type_label("image/png"), "PNG");
        assert_eq!(type_label("text/plain; charset=utf-8"), "TXT");
        assert_eq!(type_label("application/octet-stream"), "OCTET-STREAM");
    }
}

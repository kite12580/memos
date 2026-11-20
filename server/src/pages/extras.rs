use super::html;
use crate::app::App;
use crate::db::attachments::{self as atts, Attachment, Kind};
use crate::db::memos::{self, MemoLink};
use crate::h;
use crate::http::{Request, Response};
use crate::views::{self as v, Ctx};
use askama::Template;
use jiff::Timestamp;
use jiff::tz::TimeZone;
use std::sync::Arc;

pub struct Tile {
    pub uid: String,
    pub name: String,
    pub preview_label: String,
    pub thumb: String,
    pub full: String,
    pub video: bool,
    pub live: Option<v::Live>,
    pub drawing: bool,
    pub image: bool,
    pub new: bool,
    pub cell: &'static str,
}

pub struct Row {
    pub uid: String,
    pub name: String,
    pub label: String,
    pub reorder_label: String,
    pub href: String,
    pub audio: bool,
    pub voice: bool,
    pub detail: Vec<String>,
}

pub struct Link {
    pub uid: String,
    pub snippet: String,
    pub date: String,
    pub date_iso: String,
    pub date_fmt: &'static str,
}

#[derive(Template)]
#[template(path = "partials/composer_extras.html")]
struct Extras<'a> {
    c: Ctx<'a>,
    gallery: &'static str,
    tiles: Vec<Tile>,
    rows: Vec<Row>,
    refs: Vec<Link>,
    backlinks: Vec<Link>,
}

const DRAWING_SUFFIX: &str = ".canvas.png";

/// memos' `resolveEditorGalleryLayout`.
fn gallery(n: usize) -> &'static str {
    match n {
        0 | 1 => "grid grid-cols-1 gap-1.5 h-40",
        2 => "grid grid-cols-2 gap-1.5 h-40",
        3 | 4 => "grid grid-cols-2 grid-rows-2 gap-1.5 h-40",
        5 | 6 => "grid grid-cols-3 grid-rows-2 gap-1.5 h-40",
        _ => "grid grid-cols-3 auto-rows-[4.875rem] gap-1.5",
    }
}

/// memos' `formatFileSize`.
pub fn file_size(bytes: i64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    if bytes <= 0 {
        return "0 B".into();
    }
    let i = ((bytes as f64).ln() / 1024f64.ln()).floor() as usize;
    let i = i.min(UNITS.len() - 1);
    if i == 0 {
        return format!("{bytes} B");
    }
    format!("{:.1} {}", bytes as f64 / 1024f64.powi(i as i32), UNITS[i])
}

/// memos' `getFileTypeLabel`.
pub fn type_label(mime: &str) -> String {
    let mime = mime.to_ascii_lowercase();
    let mime = mime.split(';').next().unwrap_or("").trim();
    if mime.is_empty() {
        return "File".into();
    }
    let special = match mime {
        "application/pdf" => Some("PDF"),
        "application/zip" | "application/x-zip-compressed" => Some("ZIP"),
        "application/json" => Some("JSON"),
        "application/xml" => Some("XML"),
        "text/plain" => Some("TXT"),
        "text/html" => Some("HTML"),
        "text/css" => Some("CSS"),
        "text/javascript" | "application/javascript" => Some("JS"),
        _ => None,
    };
    if let Some(s) = special {
        return s.into();
    }
    let (category, subtype) = mime.split_once('/').unwrap_or((mime, ""));
    let known = match (category, subtype) {
        ("image", "jpeg" | "jpg") => Some("JPEG"),
        ("image", "webp") => Some("WebP"),
        ("image", "svg" | "svg+xml") => Some("SVG"),
        ("video", "quicktime") => Some("MOV"),
        ("audio", "mpeg") => Some("MP3"),
        _ => None,
    };
    if let Some(s) = known {
        return s.into();
    }
    if subtype.is_empty() { category.to_ascii_uppercase() } else { subtype.to_ascii_uppercase() }
}

fn recording_time(name: &str) -> Option<Option<String>> {
    let lower = name.to_ascii_lowercase();
    let rest = ["voice-recording-", "voice-note-", "audio-recording-"]
        .iter()
        .find_map(|p| lower.strip_prefix(p))?;
    let (date, rest) = rest.split_at_checked(8)?;
    if !date.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let digits: String = rest.strip_prefix('-')?.chars().take_while(char::is_ascii_digit).take(6).collect();
    if !(4..=6).contains(&digits.len()) {
        return None;
    }
    Some(match digits.len() {
        4 => Some(format!("{}:{}", &digits[..2], &digits[2..])),
        6 => Some(format!("{}:{}:{}", &digits[..2], &digits[2..4], &digits[4..])),
        _ => None,
    })
}

fn link(l: &MemoLink, now: i64, tz: &TimeZone) -> Link {
    let year = |ts: i64| Timestamp::from_second(ts).map(|t| t.to_zoned_datetime(tz.clone()).year()).unwrap_or_default();
    let same_year = year(l.created_ts) == year(now);
    let mut date = v::short_date(l.created_ts, tz);
    if !same_year {
        date.push_str(&format!(", {}", year(l.created_ts)));
    }
    Link {
        uid: l.uid.clone(),
        snippet: l.snippet.clone(),
        date,
        date_iso: h::iso(l.created_ts),
        date_fmt: if same_year { "short" } else { "date" },
    }
}

fn split(c: &Ctx, list: &[Attachment], memo_id: Option<i64>) -> (Vec<Tile>, Vec<Row>) {
    let is_new = |a: &Attachment| a.memo_id.is_none() || a.memo_id != memo_id;
    let visuals: Vec<&Attachment> = list.iter().filter(|a| matches!(a.kind, Kind::Image | Kind::Video)).collect();
    let items = v::visual_items(c.base, &visuals);
    let count = items.len();
    let mut tiles = vec![];
    for item in items {
        let a = item.a;
        let plain = a.kind == Kind::Image && item.live.is_none();
        tiles.push(Tile {
            uid: a.uid.clone(),
            name: a.filename.clone(),
            preview_label: c.t.f("common.preview-name", &[("name", &a.filename)]),
            thumb: v::thumb_url(c.base, a),
            full: v::file_url(c.base, a),
            video: a.kind == Kind::Video && item.live.is_none(),
            drawing: plain && a.filename.to_ascii_lowercase().ends_with(DRAWING_SUFFIX),
            image: a.kind == Kind::Image,
            live: item.live,
            new: is_new(a),
            cell: if count == 3 && tiles.is_empty() { " row-span-2" } else { "" },
        });
    }
    let mut rows = vec![];
    for a in list {
        let new = is_new(a);
        if matches!(a.kind, Kind::Image | Kind::Video) {
            continue;
        }
        let voice = if a.kind == Kind::Audio { recording_time(&a.filename) } else { None };
        let label = match &voice {
            Some(Some(time)) => c.t.f("editor.audio-recorder.attachment-label-with-time", &[("time", time)]),
            Some(None) => c.t.s("editor.audio-recorder.attachment-label").to_string(),
            None => a.filename.clone(),
        };
        let mut detail = vec![];
        if new {
            detail.push(c.t.s("editor.attachments.new").to_string());
        }
        detail.push(type_label(&a.mime));
        if a.size > 0 {
            detail.push(file_size(a.size));
        }
        rows.push(Row {
            uid: a.uid.clone(),
            name: a.filename.clone(),
            reorder_label: c.t.f("editor.attachments.reorder", &[("name", &label)]),
            label,
            href: v::file_url(c.base, a),
            audio: a.kind == Kind::Audio,
            voice: voice.is_some(),
            detail,
        });
    }
    (tiles, rows)
}

fn uids(req: &Request, key: &str) -> Vec<String> {
    req.query(key)
        .unwrap_or_default()
        .split(',')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

pub async fn extras(app: &Arc<App>, req: &Request) -> Response {
    let c = app.ctx(req);
    let memo = req.query("memo").filter(|s| !s.is_empty());
    let (a, r) = (uids(req, "a"), uids(req, "r"));
    let data = app
        .db
        .with(move |conn| {
            let m = match memo {
                Some(uid) => memos::get(conn, &uid)?,
                None => None,
            };
            let back = match &m {
                Some(m) => memos::relations(conn, &[m.id])?.remove(&m.id).unwrap_or_default().1,
                None => vec![],
            };
            Ok((m.map(|m| m.id), atts::by_uids(conn, &a)?, memos::links(conn, &r)?, back))
        })
        .await;
    let (memo_id, list, refs, back) = match data {
        Ok(d) => d,
        Err(e) => return e.into(),
    };
    let (tiles, rows) = split(&c, &list, memo_id);
    let tz = c.prefs.tz.clone();
    let refs = refs.iter().map(|l| link(l, c.now, &tz)).collect();
    let backlinks = back.iter().map(|l| link(l, c.now, &tz)).collect();
    html(&Extras { gallery: gallery(tiles.len()), tiles, rows, refs, backlinks, c }).with("cache-control", "no-store")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_and_types() {
        assert_eq!(file_size(600), "600 B");
        assert_eq!(file_size(3009), "2.9 KB");
        assert_eq!(file_size(15 * 1024), "15.0 KB");
        assert_eq!(file_size(5 * 1024 * 1024), "5.0 MB");
        assert_eq!(type_label("application/pdf"), "PDF");
        assert_eq!(type_label("image/svg+xml"), "SVG");
        assert_eq!(type_label("audio/webm;codecs=opus"), "WEBM");
        assert_eq!(type_label("application/vnd.ms-excel"), "VND.MS-EXCEL");
        assert_eq!(type_label(""), "File");
    }

    #[test]
    fn voice_notes() {
        assert_eq!(recording_time("voice-note-20261120-143005.webm"), Some(Some("14:30:05".into())));
        assert_eq!(recording_time("audio-recording-20261120-1430.m4a"), Some(Some("14:30".into())));
        assert_eq!(recording_time("song.mp3"), None);
    }
}

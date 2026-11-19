//! What the templates render: the page frame, the sidebar and memo cards,
//! built from store rows.

use crate::db::attachments::{Attachment, Kind};
use crate::db::memos::{Memo, MemoLink};
use crate::h::{self, Html};
use crate::http::{Request, encode_component};
use crate::i18n::T;
use jiff::Timestamp;
use jiff::civil::Date;
use jiff::tz::TimeZone;
use std::collections::HashMap;

/// Display preferences, kept in cookies so the server renders them.
#[derive(Debug, Clone)]
pub struct Prefs {
    pub theme: String,
    pub layout: String,
    pub by_updated: bool,
    pub asc: bool,
    pub compact: bool,
    pub full_width: bool,
    pub tag_tree: bool,
    pub sidebar_width: u32,
    pub tz: TimeZone,
}

pub const THEMES: [&str; 4] = ["system", "default", "default-dark", "paper"];
pub const LAYOUTS: [&str; 4] = ["list", "2", "3", "auto"];

impl Prefs {
    pub fn from_request(req: &Request, default_tz: &TimeZone) -> Prefs {
        let cookie = |k: &str| req.cookie(k);
        Prefs {
            theme: cookie("theme")
                .filter(|t| THEMES.contains(&t.as_str()))
                .unwrap_or_else(|| "system".into()),
            layout: cookie("layout")
                .filter(|t| LAYOUTS.contains(&t.as_str()))
                .unwrap_or_else(|| "list".into()),
            by_updated: cookie("order").as_deref() == Some("updated"),
            asc: cookie("dir").as_deref() == Some("asc"),
            compact: cookie("compact").as_deref() == Some("1"),
            full_width: cookie("wide").as_deref() == Some("1"),
            tag_tree: cookie("tags").as_deref() == Some("tree"),
            sidebar_width: cookie("sw")
                .and_then(|w| w.parse().ok())
                .map_or(256, |w: u32| w.clamp(224, 400)),
            tz: cookie("tz")
                .and_then(|z| TimeZone::get(&z).ok())
                .unwrap_or_else(|| default_tz.clone()),
        }
    }

    pub fn is_theme(&self, v: &str) -> bool {
        self.theme == v
    }

    pub fn is_layout(&self, v: &str) -> bool {
        self.layout == v
    }

    /// Grid layouts collapse long memos whatever the compact setting says.
    pub fn compact_effective(&self) -> bool {
        self.compact || self.layout != "list"
    }

    pub fn wide_list(&self) -> bool {
        self.layout != "list" || self.full_width
    }

    pub fn theme_attr(&self) -> &'static str {
        match self.theme.as_str() {
            "default-dark" => "dark",
            "paper" => "paper",
            _ => "light",
        }
    }

    pub fn theme_label(&self, t: &T) -> &'static str {
        match self.theme.as_str() {
            "default" => t.s("setting.preference.theme-light"),
            "default-dark" => t.s("setting.preference.theme-dark"),
            "paper" => t.s("setting.preference.theme-paper"),
            _ => t.s("setting.preference.theme-system"),
        }
    }

    /// A short key of everything that changes rendered HTML, for ETags.
    pub fn key(&self) -> String {
        format!(
            "{}{}{}{}{}{}{}{}{}",
            self.theme,
            self.layout,
            u8::from(self.by_updated),
            u8::from(self.asc),
            u8::from(self.compact),
            u8::from(self.full_width),
            u8::from(self.tag_tree),
            self.sidebar_width,
            self.tz.iana_name().unwrap_or("")
        )
    }
}

/// Everything every page needs.
pub struct Ctx<'a> {
    pub t: T,
    pub base: &'a str,
    pub css: &'a str,
    pub boot: &'a str,
    pub sprite: &'a str,
    pub preload: &'a [String],
    pub render_version: &'a str,
    pub prefs: Prefs,
    pub theme: &'static str,
    pub system_theme: bool,
    /// The search box's text.
    pub q: String,
    pub now: i64,
}

pub const SEARCH_HINTS: [&str; 9] = ["#", "is:pinned", "has:task", "has:todo", "has:link", "has:code", "has:image", "after:", "before:"];

impl Ctx<'_> {
    pub fn nav_links(&self) -> [(&'static str, &'static str, &'static str, &'static str); 2] {
        [
            ("calendar", "calendar-days", self.t.s("common.calendar"), "/calendar"),
            ("attachments", "paperclip", self.t.s("common.attachments"), "/attachments"),
        ]
    }

    pub fn theme_options(&self) -> [(&'static str, &'static str); 4] {
        [
            ("system", self.t.s("setting.preference.theme-system")),
            ("default", self.t.s("setting.preference.theme-light")),
            ("default-dark", self.t.s("setting.preference.theme-dark")),
            ("paper", self.t.s("setting.preference.theme-paper")),
        ]
    }

    pub fn layout_options(&self) -> [(&'static str, &'static str, String, String); 4] {
        let cols = |n: &str| self.t.f("memo.layout-columns", &[("n", n)]);
        [
            ("list", "rows-3", self.t.s("memo.layout-list").to_string(), self.t.s("memo.layout-list").to_string()),
            ("2", "columns-2", "2".into(), cols("2")),
            ("3", "columns-3", "3".into(), cols("3")),
            ("auto", "infinity", self.t.s("memo.layout-auto").to_string(), self.t.s("memo.layout-auto").to_string()),
        ]
    }

    /// Strings the always-loaded script shows, as JSON safe inside `<script>`.
    pub fn strings_json(&self) -> String {
        let t = &self.t;
        serde_json::json!({
            "lang": t.lang,
            "deleteConfirm": t.s("memo.delete-confirm"),
            "deleteDescription": t.s("memo.delete-confirm-description"),
            "delete": t.s("common.delete"),
            "copied": t.s("message.copied"),
            "linkCopied": t.s("message.succeed-copy-link"),
            "contentCopied": t.s("message.succeed-copy-content"),
            "deleted": t.s("message.deleted-successfully"),
            "error": t.s("error.title"),
            "close": t.s("common.close"),
            "showMore": t.s("memo.show-more"),
            "showLess": t.s("memo.show-less"),
        })
        .to_string()
        .replace('<', "\\u003c")
    }
}

#[derive(Default)]
pub struct Sidebar {
    pub active: &'static str,
    pub stats: Option<MonthView>,
    pub views: Option<Vec<ViewRow>>,
    pub active_view: Option<i64>,
    pub tags: Option<Vec<TagRow>>,
    pub sections: Option<Vec<NavGroup>>,
}

impl Sidebar {
    pub fn is_active(&self, id: &str) -> bool {
        self.active == id
    }

    pub fn is_view(&self, id: &i64) -> bool {
        self.active_view == Some(*id)
    }
}

pub struct ViewRow {
    pub id: i64,
    pub name: String,
    pub icon: String,
}

impl ViewRow {
    /// A view's icon is an emoji, or a Lucide icon name from the picker.
    pub fn icon_html(&self) -> Html {
        match self.icon.strip_prefix("lucide:") {
            Some(name) if VIEW_ICONS.contains(&name) => h::row_icon(name),
            _ if !self.icon.is_empty() => Html(format!(
                r#"<span class="flex size-5 shrink-0 items-center justify-center text-base leading-none" aria-hidden="true">{}</span>"#,
                h::escape(&self.icon)
            )),
            _ => h::row_icon("funnel"),
        }
    }
}

/// The Lucide icons a view can pick; the sprite carries each of them.
pub const VIEW_ICONS: &[&str] = &[
    "funnel", "star", "bookmark", "briefcase", "book-open", "lightbulb", "heart", "flag", "inbox",
    "calendar", "clock", "list-todo", "code", "image", "link", "music", "camera", "map-pin", "pen-line",
    "sparkles", "flame", "leaf", "coffee", "house", "graduation-cap", "rocket", "target", "archive",
];

pub struct TagRow {
    pub path: String,
    pub segments: Vec<String>,
    pub count: i64,
    pub href: String,
    pub active: bool,
    pub depth: usize,
}

pub struct NavGroup {
    pub title: &'static str,
    pub rows: Vec<NavRow>,
}

pub struct NavRow {
    pub href: String,
    pub icon: &'static str,
    pub label: String,
    pub title: String,
    pub count: Option<i64>,
    pub active: bool,
}

/// Tag rows in name order: every tag with its full path, or as a tree with
/// parents inserted and children indented.
pub fn tag_rows(base: &str, counts: &[(String, i64)], tree: bool, active: Option<&str>) -> Vec<TagRow> {
    let row = |path: &str, count: i64, depth: usize| {
        let segments: Vec<String> = if tree {
            vec![path.rsplit('/').next().unwrap_or(path).to_string()]
        } else {
            path.split('/').map(str::to_string).collect()
        };
        TagRow {
            path: path.to_string(),
            segments,
            count,
            href: if active == Some(path) {
                format!("{base}/")
            } else {
                format!("{base}/?q={}", encode_component(&format!("#{path}")))
            },
            active: active == Some(path),
            depth,
        }
    };
    if !tree {
        return counts.iter().map(|(t, n)| row(t, *n, 0)).collect();
    }
    let mut totals: std::collections::BTreeMap<String, i64> = Default::default();
    for (tag, n) in counts {
        let mut prefix = String::new();
        for seg in tag.split('/') {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(seg);
            *totals.entry(prefix.clone()).or_default() += if prefix == *tag { *n } else { 0 };
        }
    }
    totals
        .iter()
        .map(|(path, n)| row(path, *n, path.matches('/').count()))
        .collect()
}

pub struct MonthView {
    pub key: String,
    pub aria: String,
    pub title: String,
    pub prev: String,
    pub next: String,
    pub weekdays: Vec<String>,
    pub days: Vec<DayCell>,
}

pub struct DayCell {
    pub in_month: bool,
    pub day: i8,
    pub href: String,
    pub label: String,
    pub today: bool,
    pub fill: &'static str,
}

const MONTHS: [&str; 12] = [
    "January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
    "November", "December",
];

/// The quarter of the month's busiest day a count falls in, GitHub style.
fn level(count: usize, max: usize) -> u8 {
    if count == 0 {
        return 0;
    }
    let ratio = count as f64 / max.max(1) as f64;
    if ratio > 0.75 {
        4
    } else if ratio > 0.5 {
        3
    } else if ratio > 0.25 {
        2
    } else {
        1
    }
}

pub fn month_start(year: i16, month: i8) -> Date {
    Date::new(year, month, 1).unwrap_or(Date::constant(2000, 1, 1))
}

/// `[start, end)` of a month in `tz`, as Unix seconds.
pub fn month_range(start: Date, tz: &TimeZone) -> (i64, i64) {
    let end = start.checked_add(jiff::Span::new().months(1)).unwrap_or(start);
    let secs = |d: Date| d.to_zoned_datetime(tz.clone()).map_or(0, |z| z.timestamp().as_second());
    (secs(start), secs(end))
}

pub fn today(now: i64, tz: &TimeZone) -> Date {
    Timestamp::from_second(now)
        .map(|t| t.to_zoned_datetime(tz.clone()).date())
        .unwrap_or(Date::constant(2000, 1, 1))
}

pub fn month_view(t: &T, base: &str, start: Date, created: &[i64], tz: &TimeZone, now: i64) -> MonthView {
    let mut counts: HashMap<i8, usize> = HashMap::new();
    for ts in created {
        if let Ok(t) = Timestamp::from_second(*ts) {
            let d = t.to_zoned_datetime(tz.clone()).date();
            if d.year() == start.year() && d.month() == start.month() {
                *counts.entry(d.day()).or_default() += 1;
            }
        }
    }
    let max = counts.values().copied().max().unwrap_or(1);
    let today = today(now, tz);
    let lead = start.weekday().to_sunday_zero_offset() as i64;
    let first = start.checked_sub(jiff::Span::new().days(lead)).unwrap_or(start);
    let days_in_month = start.days_in_month() as i64;
    let total = ((lead + days_in_month + 6) / 7) * 7;
    let days = (0..total)
        .filter_map(|i| first.checked_add(jiff::Span::new().days(i)).ok())
        .map(|d| {
            let in_month = d.month() == start.month();
            let count = if in_month { counts.get(&d.day()).copied().unwrap_or(0) } else { 0 };
            let key = d.strftime("%Y-%m-%d").to_string();
            DayCell {
                in_month,
                day: d.day(),
                href: format!("{base}/?q={}", encode_component(&format!("on:{key}"))),
                label: if count == 0 {
                    key.clone()
                } else {
                    t.f(
                        "memo.count-memos-in-date",
                        &[
                            ("count", &count.to_string()),
                            ("memos", if count == 1 { t.s("common.memo") } else { t.s("common.memos") }),
                            ("date", &key),
                        ],
                    )
                    .to_lowercase()
                },
                today: d == today,
                fill: match level(count, max) {
                    0 => "bg-transparent text-mu-text/75 group-hover/day:bg-mu-well/40",
                    1 => "bg-mu-primary/12 text-mu-text/75",
                    2 => "bg-mu-primary/22 text-mu-text/80",
                    3 => "bg-mu-primary/34 text-mu-text/80",
                    _ => "bg-mu-primary/48 text-mu-text/85",
                },
            }
        })
        .collect();
    let shift = |months: i64| {
        start
            .checked_add(jiff::Span::new().months(months))
            .map(|d| d.strftime("%Y-%m").to_string())
            .unwrap_or_default()
    };
    let key = start.strftime("%Y-%m").to_string();
    MonthView {
        aria: t.f("common.calendar-for-month", &[("month", &key)]),
        key,
        title: format!("{} {}", MONTHS[start.month() as usize - 1], start.year()),
        prev: shift(-1),
        next: shift(1),
        weekdays: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
            .iter()
            .map(|d| {
                let s = match *d {
                    "sun" => t.s("common.days.sun"),
                    "mon" => t.s("common.days.mon"),
                    "tue" => t.s("common.days.tue"),
                    "wed" => t.s("common.days.wed"),
                    "thu" => t.s("common.days.thu"),
                    "fri" => t.s("common.days.fri"),
                    _ => t.s("common.days.sat"),
                };
                s.chars().next().map(String::from).unwrap_or_default()
            })
            .collect(),
        days,
    }
}

// ───── Cards ─────

pub struct Visual {
    pub thumb: String,
    pub full: String,
    pub alt: String,
    pub video: bool,
    pub size: Option<(i64, i64)>,
    pub class: &'static str,
    pub overlay: String,
}

pub struct Gallery {
    pub class: &'static str,
    pub cells: Vec<Visual>,
}

pub struct FileRow {
    pub href: String,
    pub name: String,
    pub ext: String,
    pub size: String,
}

pub struct RefRow {
    pub uid: String,
    pub snippet: String,
    pub icon: &'static str,
    pub title: &'static str,
    pub date: String,
    pub date_iso: String,
}

pub struct CommentRow {
    pub uid: String,
    pub snippet: String,
}

pub struct Card {
    pub uid: String,
    pub rev: i64,
    pub pinned: bool,
    pub archived: bool,
    pub stale: bool,
    pub has_todo: bool,
    pub has_task: bool,
    pub html: Html,
    pub time_iso: String,
    pub time_text: String,
    /// `rel` for a relative time, `date` for a weekday and date.
    pub time_mode: &'static str,
    pub time_title: String,
    pub updated_label: bool,
    pub clamp: bool,
    pub estimate: i64,
    pub gallery_single: Option<Visual>,
    pub gallery: Option<Gallery>,
    pub audio: Vec<FileRow>,
    pub files: Vec<FileRow>,
    pub refs: Vec<RefRow>,
    pub reactions: Vec<String>,
    pub comments: Vec<CommentRow>,
    pub comment_count: i64,
    pub in_list: bool,
}

impl Card {
    pub fn comments_strip(&self) -> bool {
        self.in_list && self.comment_count > 0
    }
}

const WEEKDAYS: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS_SHORT: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// The English text the browser's formatter replaces: "5 minutes ago"
/// within a day, else "Tue, Nov 17".
pub fn time_text(ts: i64, now: i64, tz: &TimeZone) -> (&'static str, String) {
    let diff = now - ts;
    if (0..86400).contains(&diff) {
        let text = match diff {
            0..60 => "now".to_string(),
            60..3600 => plural(diff / 60, "minute"),
            _ => plural(diff / 3600, "hour"),
        };
        return ("rel", text);
    }
    ("date", date_text(ts, now, tz))
}

pub fn date_text(ts: i64, now: i64, tz: &TimeZone) -> String {
    let Ok(t) = Timestamp::from_second(ts) else {
        return String::new();
    };
    let d = t.to_zoned_datetime(tz.clone()).date();
    let wd = WEEKDAYS[d.weekday().to_monday_zero_offset() as usize];
    let mon = MONTHS_SHORT[d.month() as usize - 1];
    if d.year() == today(now, tz).year() {
        format!("{wd}, {mon} {}", d.day())
    } else {
        format!("{wd}, {mon} {}, {}", d.day(), d.year())
    }
}

fn plural(n: i64, unit: &str) -> String {
    if n == 1 { format!("1 {unit} ago") } else { format!("{n} {unit}s ago") }
}

fn local(ts: i64, tz: &TimeZone) -> String {
    Timestamp::from_second(ts)
        .map(|t| t.to_zoned_datetime(tz.clone()).strftime("%Y-%m-%d %H:%M:%S").to_string())
        .unwrap_or_default()
}

pub fn file_url(base: &str, a: &Attachment) -> String {
    format!("{base}/file/{}/{}", a.uid, encode_component(&a.filename))
}

pub fn thumb_url(base: &str, a: &Attachment) -> String {
    if a.has_thumb {
        format!("{base}/thumb/{}", a.uid)
    } else if a.kind == Kind::Image {
        file_url(base, a)
    } else {
        String::new()
    }
}

fn extension(name: &str) -> String {
    name.rsplit_once('.')
        .map(|(_, e)| e.to_ascii_uppercase())
        .unwrap_or_default()
}

pub fn file_row(base: &str, a: &Attachment) -> FileRow {
    FileRow {
        href: file_url(base, a),
        name: a.filename.clone(),
        ext: extension(&a.filename),
        size: h::human_size(a.size),
    }
}

fn visual(base: &str, a: &Attachment, class: &'static str) -> Visual {
    Visual {
        thumb: thumb_url(base, a),
        full: file_url(base, a),
        alt: a.filename.clone(),
        video: a.kind == Kind::Video,
        size: a.width.zip(a.height),
        class,
        overlay: String::new(),
    }
}

/// memos' gallery: one item alone, two side by side, three as a mosaic,
/// four in a square, and up to six in two rows with `+N` on the last.
fn gallery(base: &str, items: &[&Attachment]) -> (Option<Visual>, Option<Gallery>) {
    match items.len() {
        0 => (None, None),
        1 => (Some(visual(base, items[0], "")), None),
        2 => (
            None,
            Some(Gallery {
                class: "grid grid-cols-2 gap-2 h-[11rem] sm:h-[13rem] md:h-[15rem]",
                cells: items.iter().map(|a| visual(base, a, "")).collect(),
            }),
        ),
        3 => (
            None,
            Some(Gallery {
                class: "grid grid-cols-2 grid-rows-2 gap-2 h-[13rem] sm:h-[16rem] md:h-[18rem]",
                cells: items
                    .iter()
                    .enumerate()
                    .map(|(i, a)| visual(base, a, if i == 0 { "row-span-2" } else { "" }))
                    .collect(),
            }),
        ),
        4 => (
            None,
            Some(Gallery {
                class: "grid grid-cols-2 grid-rows-2 gap-2 h-[13rem] sm:h-[16rem] md:h-[18rem]",
                cells: items.iter().map(|a| visual(base, a, "")).collect(),
            }),
        ),
        n => {
            let mut cells: Vec<Visual> = items.iter().take(6).map(|a| visual(base, a, "")).collect();
            if n > 6
                && let Some(last) = cells.last_mut()
            {
                last.overlay = format!("+{}", n - 6);
            }
            (
                None,
                Some(Gallery {
                    class: "grid grid-cols-3 grid-rows-2 gap-2 h-[14rem] sm:h-[17rem] md:h-[20rem]",
                    cells,
                }),
            )
        }
    }
}

/// Memos taller than this fold behind "Show more" in compact mode.
const CLAMP_TRIGGER_PX: i64 = 420;

/// A rough card height for laying out grid columns before the browser has
/// measured anything.
fn estimate(m: &Memo, visuals: usize, rows: usize) -> i64 {
    let lines: i64 = m
        .content
        .lines()
        .map(|l| 1 + l.chars().count() as i64 / 70)
        .sum();
    let body = lines * 24 + if visuals > 0 { 200 } else { 0 } + rows as i64 * 30;
    60 + body
}

pub struct CardData<'a> {
    pub attachments: &'a HashMap<i64, Vec<Attachment>>,
    pub reactions: &'a HashMap<i64, Vec<String>>,
    pub relations: &'a HashMap<i64, (Vec<MemoLink>, Vec<MemoLink>)>,
    pub comments: &'a HashMap<i64, Vec<Memo>>,
}

pub fn card(c: &Ctx, m: &Memo, d: &CardData, in_list: bool) -> Card {
    let tz = &c.prefs.tz;
    let empty = vec![];
    let atts = d.attachments.get(&m.id).unwrap_or(&empty);
    let visuals: Vec<&Attachment> = atts
        .iter()
        .filter(|a| matches!(a.kind, Kind::Image | Kind::Video))
        .collect();
    let (gallery_single, gallery) = gallery(c.base, &visuals);
    let audio: Vec<FileRow> = atts
        .iter()
        .filter(|a| a.kind == Kind::Audio)
        .map(|a| file_row(c.base, a))
        .collect();
    let files: Vec<FileRow> = atts
        .iter()
        .filter(|a| a.kind == Kind::File)
        .map(|a| file_row(c.base, a))
        .collect();
    let mut refs = vec![];
    if let Some((out, back)) = d.relations.get(&m.id) {
        for (links, icon, title) in [
            (out, "link", c.t.s("common.referencing")),
            (back, "milestone", c.t.s("common.referenced-by")),
        ] {
            for l in links {
                let ts = l.created_ts;
                refs.push(RefRow {
                    uid: l.uid.clone(),
                    snippet: l.snippet.clone(),
                    icon,
                    title,
                    date: short_date(ts, tz),
                    date_iso: h::iso(ts),
                });
            }
        }
    }
    let shown_ts = if c.prefs.by_updated { m.updated_ts } else { m.created_ts };
    let (time_mode, time_text) = if m.archived {
        ("date", date_text(shown_ts, c.now, tz))
    } else {
        time_text(shown_ts, c.now, tz)
    };
    let mut time_title = format!("{}: {}", c.t.s("common.created-at"), local(m.created_ts, tz));
    if m.updated_ts != m.created_ts {
        time_title.push_str(&format!("\n{}: {}", c.t.s("common.last-updated-at"), local(m.updated_ts, tz)));
    }
    let estimate = estimate(m, visuals.len(), audio.len() + files.len() + refs.len());
    let mut comments: Vec<CommentRow> = d
        .comments
        .get(&m.id)
        .map(|v| {
            v.iter()
                .map(|cm| CommentRow {
                    uid: cm.uid.clone(),
                    snippet: cm.snippet.clone(),
                })
                .collect()
        })
        .unwrap_or_default();
    comments.reverse();
    Card {
        uid: m.uid.clone(),
        rev: m.rev,
        pinned: m.pinned,
        archived: m.archived,
        stale: m.html_ver != c.render_version,
        has_todo: m.has_todo,
        has_task: m.has_task,
        html: Html(m.html.clone()),
        time_iso: h::iso(shown_ts),
        time_text,
        time_mode,
        time_title,
        updated_label: c.prefs.by_updated && m.updated_ts != m.created_ts,
        clamp: in_list && c.prefs.compact_effective() && estimate > CLAMP_TRIGGER_PX,
        estimate,
        gallery_single,
        gallery,
        audio,
        files,
        refs,
        reactions: d.reactions.get(&m.id).cloned().unwrap_or_default(),
        comments,
        comment_count: m.comment_count,
        in_list,
    }
}

/// "Nov 19", as memos dates its reference rows.
pub fn short_date(ts: i64, tz: &TimeZone) -> String {
    Timestamp::from_second(ts)
        .map(|t| {
            let d = t.to_zoned_datetime(tz.clone()).date();
            format!("{} {}", MONTHS_SHORT[d.month() as usize - 1], d.day())
        })
        .unwrap_or_default()
}

pub struct ListView {
    pub cards: Vec<Card>,
    pub next: Option<String>,
}

pub struct FilterChip {
    pub icon: &'static str,
    pub label: String,
    pub remove_href: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn times() {
        let tz = TimeZone::UTC;
        let now = 1_763_576_986;
        assert_eq!(time_text(now - 5, now, &tz), ("rel", "now".into()));
        assert_eq!(time_text(now - 90, now, &tz), ("rel", "1 minute ago".into()));
        assert_eq!(time_text(now - 5 * 3600, now, &tz), ("rel", "5 hours ago".into()));
        assert_eq!(time_text(now - 2 * 86400, now, &tz), ("date", "Mon, Nov 17".into()));
        assert_eq!(time_text(now - 400 * 86400, now, &tz).1, "Tue, Oct 15, 2024");
    }

    #[test]
    fn tag_tree() {
        let counts = vec![("a".to_string(), 1), ("b/c".to_string(), 2)];
        let rows = tag_rows("", &counts, true, Some("b/c"));
        let summary: Vec<(String, i64, usize, bool)> =
            rows.iter().map(|r| (r.path.clone(), r.count, r.depth, r.active)).collect();
        assert_eq!(
            summary,
            vec![("a".into(), 1, 0, false), ("b".into(), 0, 0, false), ("b/c".into(), 2, 1, true)]
        );
        let flat = tag_rows("/x", &counts, false, None);
        assert_eq!(flat[1].segments, vec!["b", "c"]);
        assert_eq!(flat[1].href, "/x/?q=%23b%2Fc");
    }

    #[test]
    fn calendar() {
        let t = T::english();
        let m = month_view(&t, "", Date::constant(2026, 11, 1), &[1_763_576_986 + 365 * 86400], &TimeZone::UTC, 1_795_112_986);
        assert_eq!(m.title, "November 2026");
        assert_eq!(m.days.len(), 35);
        assert_eq!(m.days[0].day, 1);
        assert_eq!(m.weekdays[0], "S");
        assert!(m.days.iter().any(|d| d.today));
    }
}

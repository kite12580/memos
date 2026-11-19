use crate::app::App;
use crate::content;
use crate::db::attachments::{self as atts, Kind};
use crate::h;
use crate::http::{Request, Response, encode_component};
use crate::views::{self as v, Ctx, Sidebar};
use askama::Template;
use jiff::Timestamp;
use jiff::civil::Date;
use std::collections::BTreeMap;
use std::sync::Arc;

const MONTHS: [&str; 12] = [
    "January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
    "November", "December",
];
const MONTHS_SHORT: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// memos' DAY_CELL_FILLS: an empty day, then the quarter of the busiest day a count reaches.
const DAY_CELL_FILLS: [&str; 5] = [
    "bg-mu-surface hover:bg-mu-hover",
    "bg-mu-primary/8 hover:bg-mu-primary/12",
    "bg-mu-primary/16 hover:bg-mu-primary/20",
    "bg-mu-primary/26 hover:bg-mu-primary/30",
    "bg-mu-primary/38 hover:bg-mu-primary/42",
];
const CELL: &str = "group/day relative flex min-h-14 min-w-0 flex-col overflow-hidden px-1.5 py-2 text-start no-underline transition-colors sm:px-3 sm:min-h-20 md:min-h-[5.5rem]";
const CELL_BORDER: &str = "border border-mu-line/70 border-s-transparent border-t-transparent mu-focus focus-visible:border-mu-focus";
const TODAY_BADGE: &str = "inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-mu-md px-[5px] bg-mu-primary text-mu-on-primary";
/// Excerpt lines a wide cell shows, alone and above photos; the page script fits them to the cell.
const TEXT_LINES: usize = 3;
const TEXT_LINES_WITH_IMAGES: usize = 2;
const MAX_IMAGES: usize = 2;

pub struct Day {
    pub date: String,
    pub href: String,
    pub label: String,
    pub day: i8,
    pub in_month: bool,
    pub focus: bool,
    pub class: String,
    pub numeral: &'static str,
    pub has_memos: bool,
    pub excerpt: Option<String>,
    pub code: bool,
    pub images: Vec<String>,
}

impl Day {
    pub fn clamp(&self) -> usize {
        if self.images.is_empty() { TEXT_LINES } else { TEXT_LINES_WITH_IMAGES }
    }
}

pub struct Calendar {
    pub key: String,
    pub title: String,
    pub year: i16,
    pub prev: String,
    pub next: String,
    pub today_href: String,
    pub current: String,
    pub weekdays: [&'static str; 7],
    pub days: Vec<Day>,
    /// The "no memos" sentence around the month's name, when the month is empty.
    pub empty: Option<(String, String)>,
}

pub struct MonthLink {
    pub key: String,
    pub name: &'static str,
    pub shown: bool,
    pub current: bool,
}

impl Calendar {
    /// The month picker's months of the shown year.
    pub fn months(&self) -> Vec<MonthLink> {
        (1..=12)
            .map(|m| {
                let key = format!("{}-{m:02}", self.year);
                MonthLink {
                    shown: key == self.key,
                    current: key == self.current,
                    name: MONTHS_SHORT[m - 1],
                    key,
                }
            })
            .collect()
    }
}

#[derive(Template)]
#[template(path = "pages/calendar.html")]
struct CalendarPage<'a> {
    c: Ctx<'a>,
    sb: Sidebar,
    title: String,
    cal: Calendar,
}

struct DayMemo {
    ts: i64,
    content: String,
    html: String,
    files: Vec<atts::Attachment>,
}

#[derive(Default)]
struct Summary {
    count: usize,
    excerpt: Option<(String, bool)>,
    file: Option<String>,
    images: Vec<String>,
}

fn parse_month(s: &str) -> Option<Date> {
    let (y, m) = s.split_once('-')?;
    if y.len() != 4 || m.is_empty() || m.len() > 2 {
        return None;
    }
    Date::new(y.parse().ok()?, m.parse().ok()?, 1).ok()
}

fn month_key(d: Date) -> String {
    d.strftime("%Y-%m").to_string()
}

fn shift(d: Date, months: i64) -> Date {
    d.checked_add(jiff::Span::new().months(months)).unwrap_or(d)
}

fn level(count: usize, max: usize) -> usize {
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

/// Each day's count, first excerpt and up to two photos, one per memo. A
/// blurred memo counts but shows nothing.
fn summarize(c: &Ctx, memos: &[DayMemo]) -> BTreeMap<String, Summary> {
    let mut out: BTreeMap<String, Summary> = BTreeMap::new();
    for m in memos {
        let Ok(t) = Timestamp::from_second(m.ts) else { continue };
        let date = t.to_zoned_datetime(c.prefs.tz.clone()).date().strftime("%Y-%m-%d").to_string();
        let s = out.entry(date).or_default();
        s.count += 1;
        if c.tags.blurs(&m.html) {
            continue;
        }
        if s.excerpt.is_none() {
            s.excerpt = content::excerpt(&m.content);
        }
        if s.file.is_none() {
            s.file = m.files.iter().find(|a| a.kind != Kind::Image).map(|a| a.filename.clone());
        }
        if s.images.len() < MAX_IMAGES {
            let attached = m.files.iter().filter(|a| a.kind == Kind::Image).map(|a| v::thumb_url(c.base, a));
            if let Some(src) = content::image_sources(&m.html).into_iter().chain(attached).find(|src| !s.images.contains(src)) {
                s.images.push(src);
            }
        }
    }
    out
}

fn day_label(c: &Ctx, count: usize, date: &str) -> String {
    if count == 0 {
        return date.to_string();
    }
    let t = &c.t;
    let count = count.to_string();
    let memos = if count == "1" { t.s("common.memo") } else { t.s("common.memos") };
    let args = [("count", count.as_str()), ("memos", memos), ("date", date)];
    let s = if c.prefs.by_updated {
        t.f("memo.count-memos-updated-in-date", &args)
    } else {
        t.f("memo.count-memos-in-date", &args)
    };
    s.to_lowercase()
}

fn build(c: &Ctx, start: Date, memos: &[DayMemo]) -> Calendar {
    let t = &c.t;
    let summaries = summarize(c, memos);
    let max = summaries.values().map(|s| s.count).max().unwrap_or(1);
    let today = v::today(c.now, &c.prefs.tz);
    let today_key = today.strftime("%Y-%m-%d").to_string();
    let key = month_key(start);
    let current = month_key(today);
    let focus = if current == key { today_key.clone() } else { format!("{key}-01") };
    let lead = start.weekday().to_sunday_zero_offset() as i64;
    let first = start.checked_sub(jiff::Span::new().days(lead)).unwrap_or(start);
    let total = (lead + start.days_in_month() as i64 + 6) / 7 * 7;
    let days = (0..total)
        .filter_map(|i| first.checked_add(jiff::Span::new().days(i)).ok().map(|d| (i, d)))
        .map(|(i, d)| {
            let date = d.strftime("%Y-%m-%d").to_string();
            let in_month = d.month() == start.month();
            let s = if in_month { summaries.get(&date) } else { None };
            let count = s.map_or(0, |s| s.count);
            let mut class = CELL.to_string();
            class.push_str(match i {
                0 => " rounded-ss-mu-lg",
                6 => " rounded-se-mu-lg",
                _ if i == total - 7 => " rounded-es-mu-lg",
                _ if i == total - 1 => " rounded-ee-mu-lg",
                _ => "",
            });
            class.push(' ');
            class.push_str(CELL_BORDER);
            if i % 7 == 6 {
                class.push_str(" border-e-transparent");
            }
            if i >= total - 7 {
                class.push_str(" border-b-transparent");
            }
            class.push(' ');
            class.push_str(if in_month { DAY_CELL_FILLS[level(count, max)] } else { "bg-mu-well/25 hover:bg-mu-hover" });
            let excerpt = s.and_then(|s| s.excerpt.clone().or_else(|| s.file.clone().map(|f| (f, false))));
            Day {
                href: format!("{}/?q={}", c.base, encode_component(&format!("on:{date}"))),
                label: day_label(c, count, &date),
                focus: date == focus,
                numeral: if date == today_key {
                    TODAY_BADGE
                } else if !in_month {
                    "text-mu-text-secondary/40"
                } else if count > 0 {
                    "text-mu-text"
                } else {
                    "text-mu-text-secondary/70"
                },
                day: d.day(),
                in_month,
                class,
                has_memos: count > 0,
                code: excerpt.as_ref().is_some_and(|e| e.1),
                excerpt: excerpt.map(|e| e.0),
                images: s.map(|s| s.images.clone()).unwrap_or_default(),
                date,
            }
        })
        .collect();
    let empty = summaries.is_empty().then(|| {
        let s = t.s("calendar.no-memos-in-month");
        let (a, b) = s.split_once("{{month}}").unwrap_or((s, ""));
        (a.to_string(), b.to_string())
    });
    let cal_href = |d: Date| format!("{}/calendar/{}", c.base, month_key(d));
    Calendar {
        title: format!("{} {}", MONTHS[start.month() as usize - 1], start.year()),
        prev: cal_href(shift(start, -1)),
        next: cal_href(shift(start, 1)),
        today_href: if current == key {
            format!("{}/?q={}", c.base, encode_component(&format!("on:{today_key}")))
        } else {
            format!("{}/calendar", c.base)
        },
        year: start.year(),
        weekdays: [
            t.s("common.days.sun"),
            t.s("common.days.mon"),
            t.s("common.days.tue"),
            t.s("common.days.wed"),
            t.s("common.days.thu"),
            t.s("common.days.fri"),
            t.s("common.days.sat"),
        ],
        key,
        current,
        days,
        empty,
    }
}

pub async fn calendar(app: &Arc<App>, req: &Request, month: Option<&str>) -> Response {
    let c = app.ctx(req);
    let start = match month {
        Some(m) => match parse_month(m) {
            Some(d) => d,
            None => return Response::redirect(&format!("{}/calendar", c.base)),
        },
        None => {
            let today = v::today(c.now, &c.prefs.tz);
            v::month_start(today.year(), today.month())
        }
    };
    let (from, to) = v::month_range(start, &c.prefs.tz);
    let ts = if c.prefs.by_updated { "updated_ts" } else { "created_ts" };
    let app2 = app.clone();
    let data = app
        .db
        .with(move |conn| {
            let rows = conn
                .prepare_cached(&format!(
                    "SELECT m.id, m.{ts}, m.content, m.html FROM memo m
                     WHERE m.parent_id IS NULL AND m.archived = 0 AND m.{ts} >= ? AND m.{ts} < ?
                     ORDER BY m.{ts}, m.uid"
                ))?
                .query_map([from, to], |r| Ok((r.get::<_, i64>(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
                .collect::<rusqlite::Result<Vec<(i64, i64, String, String)>>>()?;
            let ids: Vec<i64> = rows.iter().map(|r| r.0).collect();
            let mut files = atts::for_memos(conn, &ids)?;
            let memos: Vec<DayMemo> = rows
                .into_iter()
                .map(|(id, ts, content, html)| DayMemo {
                    ts,
                    content,
                    html,
                    files: files.remove(&id).unwrap_or_default(),
                })
                .collect();
            Ok((memos, crate::db::views::list(conn)?, app2.tag_counts(conn)?))
        })
        .await;
    let (memos, views, tags) = match data {
        Ok(d) => d,
        Err(e) => return e.into(),
    };
    let sb = Sidebar {
        active: "calendar",
        views: Some(super::view_rows(&views)),
        tags: Some(v::tag_rows(c.base, &tags, c.prefs.tag_tree, None)),
        ..Default::default()
    };
    let p = CalendarPage {
        title: format!("{} · Memos", c.t.s("common.calendar")),
        cal: build(&c, start, &memos),
        sb,
        c,
    };
    super::page(app, req, &p.c, &p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn months() {
        assert_eq!(parse_month("2026-11"), Some(Date::constant(2026, 11, 1)));
        assert_eq!(parse_month("2026-2"), Some(Date::constant(2026, 2, 1)));
        assert_eq!(parse_month("2026-13"), None);
        assert_eq!(parse_month("nope"), None);
        assert_eq!((level(0, 4), level(1, 4), level(4, 4)), (0, 1, 4));
    }
}

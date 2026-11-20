use crate::app::App;
use crate::h;
use crate::http::{Request, Response};
use crate::views::{Ctx, NavGroup, NavRow, Sidebar};
use askama::Template;
use rusqlite::Connection;
use std::path::Path;
use std::sync::Arc;
use super::attachments::file_size as size;

/// The settings sections, in sidebar order: hash, icon, label key.
const SECTIONS: [(&str, &str); 5] = [
    ("my-account", "user"),
    ("preference", "cog"),
    ("system", "settings-2"),
    ("tags", "tags"),
    ("resource-stats", "chart-column"),
];

pub struct TagSetting {
    pub tag: String,
    pub color: String,
    pub blur: bool,
    pub count: i64,
}

impl TagSetting {
    /// The row the page copies for a rule it adds.
    pub fn blank() -> TagSetting {
        TagSetting {
            tag: String::new(),
            color: String::new(),
            blur: false,
            count: 0,
        }
    }

    pub fn swatch(&self) -> &str {
        if self.color.is_empty() { "#ffffff" } else { &self.color }
    }
}

pub struct Stats {
    pub memos: i64,
    pub attachments: i64,
    pub attachment_bytes: String,
    pub tags: usize,
    pub db_bytes: String,
    pub dir_bytes: String,
}

pub struct Choice {
    pub value: &'static str,
    pub label: String,
    pub selected: bool,
}

#[derive(Template)]
#[template(path = "pages/settings.html")]
struct SettingsPage<'a> {
    c: Ctx<'a>,
    sb: Sidebar,
    title: String,
    tags: Vec<TagSetting>,
    known: Vec<(String, i64)>,
    stats: Stats,
}

impl SettingsPage<'_> {
    fn languages(&self) -> Vec<(&'static str, &'static str, bool)> {
        crate::i18n::languages().map(|(code, name)| (code, name, self.c.t.is(code))).collect()
    }

    fn themes(&self) -> Vec<Choice> {
        self.c
            .theme_options()
            .into_iter()
            .map(|(value, label)| Choice {
                value,
                label: label.to_string(),
                selected: self.c.prefs.is_theme(value),
            })
            .collect()
    }

    fn theme_icon(&self, value: &str) -> &'static str {
        match value {
            "system" => "monitor",
            "default-dark" => "moon",
            "paper" => "palette",
            _ => "sun",
        }
    }

    fn layouts(&self) -> Vec<Choice> {
        self.c
            .layout_options()
            .into_iter()
            .map(|(value, _, _, label, _)| Choice {
                value,
                selected: self.c.prefs.is_layout(value),
                label,
            })
            .collect()
    }

    fn selected<'b>(&self, choices: &'b [Choice]) -> &'b str {
        choices.iter().find(|c| c.selected).map_or("", |c| c.label.as_str())
    }
}

fn dir_size(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|e| match e.metadata() {
            Ok(m) if m.is_dir() => dir_size(&e.path()),
            Ok(m) => m.len(),
            Err(_) => 0,
        })
        .sum()
}

fn counts(c: &Connection) -> rusqlite::Result<(i64, i64, i64, i64)> {
    let memos = c.query_row("SELECT count(*) FROM memo", [], |r| r.get(0))?;
    let (attachments, bytes) = c.query_row("SELECT count(*), coalesce(sum(size), 0) FROM attachment", [], |r| Ok((r.get(0)?, r.get(1)?)))?;
    let db = c.query_row(
        "SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()",
        [],
        |r| r.get(0),
    )?;
    Ok((memos, attachments, bytes, db))
}

fn sidebar(c: &Ctx) -> Sidebar {
    Sidebar {
        active: "settings",
        sections: Some(vec![NavGroup {
            title: c.t.s("common.basic"),
            rows: SECTIONS
                .iter()
                .enumerate()
                .map(|(i, (key, icon))| NavRow {
                    href: format!("{}/settings#{key}", c.base),
                    icon,
                    label: match *key {
                        "my-account" => c.t.s("setting.my-account.label"),
                        "preference" => c.t.s("setting.preference.label"),
                        "system" => c.t.s("setting.system.label"),
                        "tags" => c.t.s("setting.tags.label"),
                        _ => c.t.s("setting.resource-stats.label"),
                    }
                    .to_string(),
                    title: String::new(),
                    count: None,
                    active: i == 0,
                })
                .collect(),
        }]),
        ..Default::default()
    }
}

pub async fn settings(app: &Arc<App>, req: &Request) -> Response {
    let c = app.ctx(req);
    let etag = match super::validator(app, req, &c) {
        Ok(etag) => etag,
        Err(not_modified) => return not_modified,
    };
    let app2 = app.clone();
    let data = app
        .db
        .with(move |conn| Ok((app2.tag_counts(conn)?, counts(conn)?, crate::db::memos::tagged(conn)?)))
        .await;
    let (tag_counts, (memos, attachments, bytes, db), tagged) = match data {
        Ok(d) => d,
        Err(e) => return e.into(),
    };
    let count_of = |rule: &str| {
        let pattern = crate::views::is_pattern(rule).then(|| regex_lite::Regex::new(&format!("^(?:{rule})$")).ok()).flatten();
        match pattern {
            Some(re) => {
                let ids: std::collections::HashSet<i64> =
                    tagged.iter().filter(|(t, _)| t == rule || re.is_match(t)).map(|(_, id)| *id).collect();
                ids.len() as i64
            }
            None => tag_counts.iter().find(|(t, _)| t == rule).map_or(0, |(_, n)| *n),
        }
    };
    let tags: Vec<TagSetting> = c
        .tags
        .meta
        .iter()
        .map(|m| TagSetting {
            count: count_of(&m.tag),
            tag: m.tag.clone(),
            color: m.color.clone(),
            blur: m.blur,
        })
        .collect();
    let known = tag_counts
        .iter()
        .filter(|(t, _)| !tags.iter().any(|s| s.tag == *t))
        .cloned()
        .collect();
    let stats = Stats {
        memos,
        attachments,
        attachment_bytes: size(bytes),
        tags: tag_counts.len(),
        db_bytes: size(db),
        dir_bytes: size(dir_size(&app.cfg.data_dir) as i64),
    };
    let p = SettingsPage {
        title: c.page_title(c.t.s("common.settings")),
        sb: sidebar(&c),
        tags,
        known,
        stats,
        c,
    };
    super::page(&etag, &p)
}

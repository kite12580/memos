use crate::app::App;
use crate::h::{self, Html};
use crate::http::{Request, Response};
use crate::views::{Ctx, Sidebar, VIEW_ICONS};
use askama::Template;
use std::sync::Arc;

pub struct ViewItem {
    pub id: i64,
    pub name: String,
    pub icon: String,
    pub query: String,
}

impl ViewItem {
    pub fn icon_html(&self) -> Html {
        view_icon(&self.icon, "text-base")
    }
}

/// memos' CustomIcon with the view fallback: a picked Lucide icon or emoji, else parentheses.
pub fn view_icon(icon: &str, class: &str) -> Html {
    match icon.strip_prefix("lucide:") {
        Some(name) if VIEW_ICONS.contains(&name) => h::icon(name, &format!("mu-icon shrink-0 {class}")),
        _ if !icon.is_empty() && !icon.starts_with("lucide:") => Html(format!(
            r#"<span aria-hidden="true" class="mu-icon inline-flex shrink-0 items-center justify-center {class}">{}</span>"#,
            h::escape(icon)
        )),
        _ => h::icon("parentheses", &format!("mu-icon shrink-0 {class}")),
    }
}

/// The picker's name for a Lucide icon, as memos labels them.
fn icon_label(name: &str) -> String {
    let named = match name {
        "astroid" => "Space",
        "book-open" => "Book",
        "chart-no-axes-combined" => "Chart",
        "check-check" => "Checklist",
        "flask-conical" => "Science",
        "flower-2" => "Flower",
        "graduation-cap" => "Education",
        "map-pin" => "Location",
        "notebook-pen" => "Notebook",
        _ => "",
    };
    if !named.is_empty() {
        return named.into();
    }
    let spaced = name.replace('-', " ");
    let mut chars = spaced.chars();
    chars.next().map(|c| c.to_uppercase().chain(chars).collect()).unwrap_or_default()
}

pub struct Example {
    pub icon: &'static str,
    pub title: &'static str,
    pub query: &'static str,
    pub description: &'static str,
}

/// The query syntax, as the help lists it.
pub const SYNTAX: &[&str] = &[
    "#tag", "-#tag", "is:pinned", "has:task", "has:todo", "has:link", "has:code", "has:image", "has:media",
    "has:attachment", "has:tag", "has:comment", "has:ref", "has:reaction", "before:YYYY-MM-DD", "after:YYYY-MM-DD",
    "on:YYYY[-MM[-DD]]", "\"exact words\"", "words", "-term",
];

#[derive(Template)]
#[template(path = "pages/views.html")]
struct ViewsPage<'a> {
    c: Ctx<'a>,
    sb: Sidebar,
    title: String,
    views: Vec<ViewItem>,
}

impl ViewsPage<'_> {
    fn icons(&self) -> Vec<Vec<(&'static str, String)>> {
        VIEW_ICONS
            .chunks(8)
            .map(|row| row.iter().map(|n| (*n, icon_label(n))).collect())
            .collect()
    }

    fn examples(&self) -> [Example; 8] {
        let t = &self.c.t;
        [
            Example {
                icon: "pin",
                title: t.s("setting.memo-view.examples.pinned.title"),
                query: "is:pinned",
                description: t.s("setting.memo-view.examples.pinned.description"),
            },
            Example {
                icon: "clipboard-check",
                title: t.s("setting.memo-view.examples.open-tasks.title"),
                query: "has:todo",
                description: t.s("setting.memo-view.examples.open-tasks.description"),
            },
            Example {
                icon: "tags",
                title: t.s("setting.memo-view.examples.archive-tree.title"),
                query: "#archive",
                description: t.s("setting.memo-view.examples.archive-tree.description"),
            },
            Example {
                icon: "tags",
                title: t.s("setting.memo-view.examples.untagged.title"),
                query: "-has:tag",
                description: t.s("setting.memo-view.examples.untagged.description"),
            },
            Example {
                icon: "paperclip",
                title: t.s("setting.memo-view.examples.with-attachments.title"),
                query: "has:attachment",
                description: t.s("setting.memo-view.examples.with-attachments.description"),
            },
            Example {
                icon: "image",
                title: t.s("setting.memo-view.examples.photos.title"),
                query: "has:image",
                description: t.s("setting.memo-view.examples.photos.description"),
            },
            Example {
                icon: "search",
                title: t.s("setting.memo-view.examples.content-search.title"),
                query: "\"TODO\"",
                description: t.s("setting.memo-view.examples.content-search.description"),
            },
            Example {
                icon: "clock-3",
                title: t.s("setting.memo-view.examples.year-2024.title"),
                query: "on:2024",
                description: t.s("setting.memo-view.examples.year-2024.description"),
            },
        ]
    }
}

pub async fn views(app: &Arc<App>, req: &Request) -> Response {
    let c = app.ctx(req);
    let etag = match super::validator(app, req, &c) {
        Ok(etag) => etag,
        Err(not_modified) => return not_modified,
    };
    let views = match app.db.with(|conn| crate::db::views::list(conn)).await {
        Ok(v) => v,
        Err(e) => return e.into(),
    };
    let sb = Sidebar {
        active: "views",
        views: Some(super::view_rows(&views, &super::Filters::home(c.base))),
        ..Default::default()
    };
    let p = ViewsPage {
        title: c.page_title(c.t.s("common.views")),
        views: views
            .into_iter()
            .map(|w| ViewItem {
                id: w.id,
                name: w.name,
                icon: w.icon,
                query: w.query,
            })
            .collect(),
        sb,
        c,
    };
    super::page(&etag, &p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn icons() {
        assert_eq!(icon_label("map-pin"), "Location");
        assert_eq!(icon_label("check-check"), "Checklist");
        assert_eq!(icon_label("graduation-cap"), "Education");
        assert_eq!(icon_label("book-open"), "Book");
        assert_eq!(icon_label("coffee"), "Coffee");
        assert_eq!(icon_label("utensils"), "Utensils");
        assert!(view_icon("lucide:star", "").0.contains("lucide-star"));
        assert!(view_icon("🌱", "").0.contains("🌱"));
        assert!(view_icon("lucide:nope", "").0.contains("lucide-parentheses"));
    }
}

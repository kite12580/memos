//! POST handlers the pages call. Bodies are JSON; most answer with the
//! changed memo's card so the page can swap it in.

use crate::app::App;
use crate::content::{self, Derived};
use crate::db::memos::{self, Edit, Flag, NewMemo, Outcome};
use crate::db::{attachments as atts, views};
use crate::http::{Request, Response, encode_component};
use serde_json::{Value, json};
use std::sync::Arc;

fn body(req: &Request) -> Value {
    req.json().unwrap_or(Value::Null)
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

/// The HTML to store: what the browser rendered, cleaned, or a server
/// rendering when there is none. The second value is the renderer version.
pub fn rendered(content: &str, html: Option<&str>, ver: Option<&str>) -> (String, String) {
    match (html, ver) {
        (Some(h), Some(v)) if !v.is_empty() => (content::sanitize(h), v.to_string()),
        _ => (content::fallback_html(content), String::new()),
    }
}

async fn card_response(app: &Arc<App>, req: &Request, uid: &str) -> Response {
    crate::pages::card_fragment(app, req, uid).await
}

pub async fn create(app: &Arc<App>, req: &Request) -> Response {
    let b = body(req);
    let Some(content) = b["content"].as_str().map(str::to_string) else {
        return Response::error(400, "content is required");
    };
    let attachments = strings(&b["attachments"]);
    if content.trim().is_empty() && attachments.is_empty() {
        return Response::error(400, "content, attachment, or file required");
    }
    let (html, ver) = rendered(&content, b["html"].as_str(), b["ver"].as_str());
    let derived = content::derive(&html);
    let snippet = content::snippet(&content);
    let relations = strings(&b["relations"]);
    let parent = b["parent"].as_str().map(str::to_string);
    let created_ts = b["createdTs"].as_i64().unwrap_or_else(app.now);
    let res = app
        .db
        .tx(move |c| {
            let parent_id = match parent {
                Some(uid) => match memos::get(c, &uid)? {
                    Some(p) => Some(p.id),
                    None => return Ok(None),
                },
                None => None,
            };
            let m = memos::create(
                c,
                NewMemo {
                    content,
                    html,
                    html_ver: ver,
                    derived,
                    snippet,
                    parent_id,
                    created_ts,
                },
            )?;
            atts::attach(c, m.id, &attachments)?;
            if !relations.is_empty() {
                memos::set_relations(c, m.id, &relations)?;
            }
            Ok(Some(m.uid))
        })
        .await;
    match res {
        Ok(Some(uid)) => {
            app.changed();
            card_response(app, req, &uid).await.with("x-memo", &uid)
        }
        Ok(None) => Response::error(404, "parent memo not found"),
        Err(e) => e.into(),
    }
}

pub async fn update(app: &Arc<App>, req: &Request, uid: &str) -> Response {
    let b = body(req);
    let Some(content) = b["content"].as_str().map(str::to_string) else {
        return Response::error(400, "content is required");
    };
    let (html, ver) = rendered(&content, b["html"].as_str(), b["ver"].as_str());
    let edit = Edit {
        derived: content::derive(&html),
        snippet: content::snippet(&content),
        content,
        html,
        html_ver: ver,
        created_ts: b["createdTs"].as_i64(),
        now: (app.now)(),
    };
    let rev = b["rev"].as_i64();
    let attachments = b.get("attachments").map(strings);
    let relations = b.get("relations").map(strings);
    let uid_owned = uid.to_string();
    let res = app
        .db
        .tx(move |c| {
            let out = memos::update(c, &uid_owned, rev, edit)?;
            if let Outcome::Done(m) = &out {
                if let Some(a) = attachments {
                    atts::attach(c, m.id, &a)?;
                }
                if let Some(r) = relations {
                    memos::set_relations(c, m.id, &r)?;
                }
            }
            Ok(out)
        })
        .await;
    outcome(app, req, uid, res.map(|o| o.map(|_| ()))).await
}

async fn outcome(app: &Arc<App>, req: &Request, uid: &str, res: Result<Outcome<()>, crate::db::DbError>) -> Response {
    match res {
        Ok(Outcome::Done(())) => {
            app.changed();
            card_response(app, req, uid).await
        }
        Ok(Outcome::NotFound) => Response::not_found(),
        Ok(Outcome::Conflict) => Response::error(409, "the memo changed; reload it"),
        Err(e) => e.into(),
    }
}

/// HTML a browser rendered for a memo whose stored HTML was stale.
pub async fn set_html(app: &Arc<App>, req: &Request, uid: &str) -> Response {
    let b = body(req);
    let (Some(html), Some(ver), Some(rev)) = (b["html"].as_str(), b["ver"].as_str(), b["rev"].as_i64()) else {
        return Response::error(400, "html, ver and rev are required");
    };
    let html = content::sanitize(html);
    let ver = ver.to_string();
    let derived = content::derive(&html);
    let uid_owned = uid.to_string();
    let res = app
        .db
        .tx(move |c| memos::set_html(c, &uid_owned, rev, &html, &ver, &derived))
        .await;
    match res {
        Ok(Outcome::Done(_)) => {
            app.changed();
            Response::new(204)
        }
        Ok(Outcome::NotFound) => Response::not_found(),
        Ok(Outcome::Conflict) => Response::new(409),
        Err(e) => e.into(),
    }
}

pub async fn flag(app: &Arc<App>, req: &Request, uid: &str, flag: Flag) -> Response {
    let on = body(req)["on"].as_bool().unwrap_or(true);
    let now = (app.now)();
    let uid_owned = uid.to_string();
    match app.db.tx(move |c| memos::set_flag(c, &uid_owned, flag, on, now)).await {
        Ok(true) => {
            app.changed();
            card_response(app, req, uid).await
        }
        Ok(false) => Response::not_found(),
        Err(e) => e.into(),
    }
}

pub async fn delete(app: &Arc<App>, uid: &str) -> Response {
    let uid_owned = uid.to_string();
    match app.db.tx(move |c| memos::delete(c, &uid_owned)).await {
        Ok(Some(files)) => {
            for f in files {
                crate::files::remove_files(app, &f);
            }
            app.changed();
            Response::new(204)
        }
        Ok(None) => Response::not_found(),
        Err(e) => e.into(),
    }
}

/// The memo's content and HTML after `change`, which gets both and returns
/// both, saved at revision `rev`.
async fn rewrite(
    app: &Arc<App>,
    req: &Request,
    uid: &str,
    rev: Option<i64>,
    change: impl FnOnce(&str, &str, &str) -> Option<(String, String)> + Send + 'static,
) -> Response {
    let uid_owned = uid.to_string();
    let now = (app.now)();
    let res = app
        .db
        .tx(move |c| {
            let Some(m) = memos::get(c, &uid_owned)? else {
                return Ok(Outcome::NotFound);
            };
            if rev.is_some_and(|r| r != m.rev) {
                return Ok(Outcome::Conflict);
            }
            let Some((content, html)) = change(&m.content, &m.html, &m.html_ver) else {
                return Ok(Outcome::Conflict);
            };
            let derived: Derived = content::derive(&html);
            let edit = Edit {
                snippet: content::snippet(&content),
                derived,
                content,
                html,
                html_ver: m.html_ver.clone(),
                created_ts: None,
                now,
            };
            Ok(memos::update(c, &uid_owned, Some(m.rev), edit)?.map(|_| ()))
        })
        .await;
    outcome(app, req, uid, res).await
}

/// Ticks or unticks one task from the read-only card.
pub async fn task(app: &Arc<App>, req: &Request, uid: &str) -> Response {
    let b = body(req);
    let Some(index) = b["i"].as_u64().map(|i| i as usize) else {
        return Response::error(400, "i is required");
    };
    let label = b["label"].as_str().unwrap_or("").to_string();
    rewrite(app, req, uid, b["rev"].as_i64(), move |md, html, ver| {
        let (md, checked) = content::toggle_task_markdown(md, index, &label)?;
        let html = if ver.is_empty() { content::fallback_html(&md) } else { content::set_task_html(html, index, checked)? };
        Some((md, html))
    })
    .await
}

/// "Check all tasks" and "Uncheck all tasks".
pub async fn all_tasks(app: &Arc<App>, req: &Request, uid: &str) -> Response {
    let checked = body(req)["checked"].as_bool().unwrap_or(true);
    rewrite(app, req, uid, None, move |md, html, ver| {
        let (md, flipped) = content::set_all_tasks_markdown(md, checked);
        let html = if ver.is_empty() {
            content::fallback_html(&md)
        } else {
            flipped.iter().try_fold(html.to_string(), |h, &i| content::set_task_html(&h, i, checked))?
        };
        Some((md, html))
    })
    .await
}

pub async fn react(app: &Arc<App>, req: &Request, uid: &str) -> Response {
    let Some(emoji) = body(req)["emoji"].as_str().map(str::to_string).filter(|e| !e.is_empty() && e.len() <= 32) else {
        return Response::error(400, "emoji is required");
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64);
    let uid_owned = uid.to_string();
    let res = app
        .db
        .tx(move |c| {
            let Some(m) = memos::get(c, &uid_owned)? else {
                return Ok(false);
            };
            memos::toggle_reaction(c, m.id, &emoji, now)?;
            Ok(true)
        })
        .await;
    match res {
        Ok(true) => {
            app.changed();
            card_response(app, req, uid).await
        }
        Ok(false) => Response::not_found(),
        Err(e) => e.into(),
    }
}

pub async fn save_view(app: &Arc<App>, req: &Request) -> Response {
    let b = body(req);
    let name = b["name"].as_str().unwrap_or("").trim().to_string();
    let query = b["query"].as_str().unwrap_or("").trim().to_string();
    if name.is_empty() || query.is_empty() {
        return Response::error(400, "name and query are required");
    }
    let icon = b["icon"].as_str().unwrap_or("").to_string();
    let id = b["id"].as_i64();
    match app.db.tx(move |c| views::save(c, id, &name, &icon, &query)).await {
        Ok(id) => {
            app.changed();
            Response::json(200, &json!({ "id": id }))
        }
        Err(e) => e.into(),
    }
}

pub async fn order_views(app: &Arc<App>, req: &Request) -> Response {
    let ids: Vec<i64> = body(req)["ids"]
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_i64).collect())
        .unwrap_or_default();
    match app.db.tx(move |c| views::reorder(c, &ids)).await {
        Ok(()) => {
            app.changed();
            Response::new(204)
        }
        Err(e) => e.into(),
    }
}

pub async fn delete_view(app: &Arc<App>, id: &str) -> Response {
    let Ok(id) = id.parse::<i64>() else {
        return Response::not_found();
    };
    match app.db.tx(move |c| views::delete(c, id)).await {
        Ok(()) => {
            app.changed();
            Response::new(204)
        }
        Err(e) => e.into(),
    }
}

pub async fn tag_meta(app: &Arc<App>, req: &Request) -> Response {
    let b = body(req);
    let Some(tag) = b["tag"].as_str().map(|t| t.trim_start_matches('#').to_string()).filter(|t| !t.is_empty()) else {
        return Response::error(400, "tag is required");
    };
    let color = b["color"]
        .as_str()
        .filter(|c| c.len() == 7 && c.starts_with('#') && c[1..].bytes().all(|b| b.is_ascii_hexdigit()))
        .unwrap_or("")
        .to_string();
    let meta = views::TagMeta {
        tag,
        color,
        blur: b["blur"].as_bool().unwrap_or(false),
    };
    let res = app
        .db
        .tx(move |c| {
            views::set_tag_meta(c, &meta)?;
            views::tag_meta(c)
        })
        .await;
    match res {
        Ok(meta) => {
            app.set_tag_meta(meta);
            app.changed();
            Response::new(204)
        }
        Err(e) => e.into(),
    }
}

/// Saves the fields the body names, leaving the rest of the profile as it is.
pub async fn profile(app: &Arc<App>, req: &Request) -> Response {
    let b = body(req);
    let mut p = (*app.profile()).clone();
    let field = |k: &str, max: usize| b[k].as_str().map(|v| v.trim().to_string()).filter(|v| v.chars().count() <= max);
    for (key, max, slot) in [
        ("title", 64, &mut p.title),
        ("description", 1000, &mut p.description),
        ("nickname", 64, &mut p.nickname),
    ] {
        if !b[key].is_null() {
            match field(key, max) {
                Some(v) => *slot = v,
                None => return Response::error(400, &format!("{key} is too long")),
            }
        }
    }
    if !b["logo"].is_null() {
        match b["logo"].as_str().map(str::trim).filter(|l| crate::profile::valid_logo(l)) {
            Some(l) => p.logo = l.to_string(),
            None => return Response::error(400, "logo must be an http(s) or image URL"),
        }
    }
    if let Some(a) = b["avatar"].as_str() {
        p.avatar = a.to_string();
    }
    let p = p.decoded();
    if !p.avatar.is_empty() && p.avatar_file.is_none() {
        return Response::error(400, "avatar must be a PNG, JPEG, WebP or GIF of 2 MB or less");
    }
    let saved = p.clone();
    match app.db.tx(move |c| saved.save(c)).await {
        Ok(()) => {
            app.set_profile(p);
            app.changed();
            Response::new(204)
        }
        Err(e) => e.into(),
    }
}

const PREF_KEYS: [&str; 10] = ["theme", "lang", "layout", "order", "dir", "compact", "wide", "tags", "sw", "tz"];

/// Stores a display preference in a year-long cookie.
pub fn prefs(app: &Arc<App>, req: &Request) -> Response {
    let b = body(req);
    let (Some(key), Some(value)) = (b["key"].as_str(), b["value"].as_str()) else {
        return Response::error(400, "key and value are required");
    };
    if !PREF_KEYS.contains(&key) || value.len() > 64 {
        return Response::error(400, "unknown preference");
    }
    let mut res = Response::new(204);
    res.add(
        "set-cookie",
        &format!(
            "{key}={}; Path={}/; Max-Age=31536000; SameSite=Lax",
            encode_component(value),
            app.cfg.base
        ),
    );
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_browser_html_and_falls_back() {
        let (h, v) = rendered("#a", Some("<p>x<script>1</script></p>"), Some("v1"));
        assert_eq!((h.as_str(), v.as_str()), ("<p>x</p>", "v1"));
        let (h, v) = rendered("#a", None, None);
        assert!(h.contains("data-tag=\"a\""));
        assert_eq!(v, "");
    }
}

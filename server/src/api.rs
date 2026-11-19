//! A small JSON API for scripts and shortcuts, behind `API_TOKEN`.
//! Memos it creates get server-rendered HTML until a browser shows them.

use crate::app::App;
use crate::content;
use crate::db::memos::{self, Cursor, Edit, Flag, ListQuery, Memo, NewMemo, Order, Outcome, Scope};
use crate::db::attachments as atts;
use crate::http::{Request, Response, decode_path};
use crate::query;
use serde_json::{Value, json};
use std::sync::Arc;

fn authorized(app: &App, req: &Request) -> bool {
    let Some(token) = app.cfg.api_token.as_deref() else {
        return false;
    };
    let given = req
        .header("authorization")
        .and_then(|h| h.strip_prefix("Bearer "))
        .unwrap_or("");
    given.len() == token.len()
        && given
            .bytes()
            .zip(token.bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

fn memo_json(base: &str, m: &Memo, attachments: &[atts::Attachment]) -> Value {
    json!({
        "uid": m.uid,
        "content": m.content,
        "pinned": m.pinned,
        "archived": m.archived,
        "createdTs": m.created_ts,
        "updatedTs": m.updated_ts,
        "rev": m.rev,
        "commentCount": m.comment_count,
        "attachments": attachments.iter().map(|a| crate::pages::attachment_json(base, a)).collect::<Vec<_>>(),
    })
}

pub async fn handle(app: &Arc<App>, mut req: Request) -> Response {
    if app.cfg.api_token.is_none() {
        return Response::not_found();
    }
    if !authorized(app, &req) {
        return Response::error(401, "missing or wrong bearer token");
    }
    let segs: Vec<String> = req.path.split('/').skip(1).map(decode_path).collect();
    let segs: Vec<&str> = segs.iter().map(String::as_str).collect();
    let base = app.cfg.base.clone();
    match (req.method.as_str(), segs.as_slice()) {
        ("GET", ["api", "memos"]) => {
            let terms = query::parse(&req.query("q").unwrap_or_default());
            let archived = req.query("archived").as_deref() == Some("1");
            let limit = req.query("limit").and_then(|l| l.parse().ok()).unwrap_or(20usize).clamp(1, 100);
            let cursor = req.query("cursor").and_then(|c| Cursor::decode(&c));
            let lq = ListQuery {
                scope: if archived { Scope::Archived } else { Scope::Normal },
                terms,
                order: Order::default(),
                cursor,
                limit,
                tz: app.cfg.tz.clone(),
            };
            let res = app
                .db
                .with(move |c| {
                    let (ms, next) = memos::list(c, &lq)?;
                    let a = atts::for_memos(c, &ms.iter().map(|m| m.id).collect::<Vec<_>>())?;
                    Ok((ms, next, a))
                })
                .await;
            match res {
                Ok((ms, next, a)) => Response::json(
                    200,
                    &json!({
                        "memos": ms.iter().map(|m| memo_json(&base, m, a.get(&m.id).map_or(&[][..], Vec::as_slice))).collect::<Vec<_>>(),
                        "next": next.map(|c| c.encode()),
                    }),
                ),
                Err(e) => e.into(),
            }
        }
        ("POST", ["api", "memos"]) => {
            let b = req.json().unwrap_or(Value::Null);
            let Some(content) = b["content"].as_str().map(str::to_string) else {
                return Response::error(400, "content is required");
            };
            let html = content::fallback_html(&content);
            let new = NewMemo {
                derived: content::derive(&html),
                snippet: content::snippet(&content),
                content,
                html,
                html_ver: String::new(),
                parent_id: None,
                created_ts: b["createdTs"].as_i64().unwrap_or_else(app.now),
            };
            let pinned = b["pinned"].as_bool().unwrap_or(false);
            let attachments: Vec<String> = b["attachments"]
                .as_array()
                .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                .unwrap_or_default();
            let now = (app.now)();
            let res = app
                .db
                .with(move |c| {
                    let m = memos::create(c, new)?;
                    atts::attach(c, m.id, &attachments)?;
                    if pinned {
                        memos::set_flag(c, &m.uid, Flag::Pinned, true, now)?;
                    }
                    let m = memos::get(c, &m.uid)?.expect("memo just created");
                    let a = atts::for_memos(c, &[m.id])?.remove(&m.id).unwrap_or_default();
                    Ok((m, a))
                })
                .await;
            match res {
                Ok((m, a)) => {
                    app.changed();
                    Response::json(201, &memo_json(&base, &m, &a))
                }
                Err(e) => e.into(),
            }
        }
        ("POST", ["api", "memos", "attachments"]) => {
            req.path = "/attachments".into();
            crate::files::upload(app, req).await
        }
        (method, ["api", "memos", uid]) => {
            let uid = uid.to_string();
            match method {
                "GET" => {
                    let res = app
                        .db
                        .with(move |c| {
                            let Some(m) = memos::get(c, &uid)? else {
                                return Ok(None);
                            };
                            let a = atts::for_memos(c, &[m.id])?.remove(&m.id).unwrap_or_default();
                            Ok(Some((m, a)))
                        })
                        .await;
                    match res {
                        Ok(Some((m, a))) => Response::json(200, &memo_json(&base, &m, &a)),
                        Ok(None) => Response::error(404, "memo not found"),
                        Err(e) => e.into(),
                    }
                }
                "PATCH" => {
                    let b = req.json().unwrap_or(Value::Null);
                    let now = (app.now)();
                    let res = app
                        .db
                        .with(move |c| {
                            if let Some(content) = b["content"].as_str() {
                                let html = content::fallback_html(content);
                                let edit = Edit {
                                    derived: content::derive(&html),
                                    snippet: content::snippet(content),
                                    content: content.to_string(),
                                    html,
                                    html_ver: String::new(),
                                    created_ts: b["createdTs"].as_i64(),
                                    now,
                                };
                                if let Outcome::NotFound | Outcome::Conflict = memos::update(c, &uid, b["rev"].as_i64(), edit)? {
                                    return Ok(None);
                                }
                            }
                            for (key, flag) in [("pinned", Flag::Pinned), ("archived", Flag::Archived)] {
                                if let Some(on) = b[key].as_bool() {
                                    memos::set_flag(c, &uid, flag, on, now)?;
                                }
                            }
                            let Some(m) = memos::get(c, &uid)? else {
                                return Ok(None);
                            };
                            let a = atts::for_memos(c, &[m.id])?.remove(&m.id).unwrap_or_default();
                            Ok(Some((m, a)))
                        })
                        .await;
                    match res {
                        Ok(Some((m, a))) => {
                            app.changed();
                            Response::json(200, &memo_json(&base, &m, &a))
                        }
                        Ok(None) => Response::error(409, "memo not found or changed"),
                        Err(e) => e.into(),
                    }
                }
                "DELETE" => crate::actions::delete(app, &uid).await,
                _ => Response::error(405, "method not allowed"),
            }
        }
        _ => Response::error(404, "no such endpoint"),
    }
}

//! Attachment files: streamed to disk on upload, streamed back with Range
//! support. Thumbnails are made by the browser; the server never decodes
//! an image.

use crate::app::App;
use crate::db::attachments::{self as atts, NewAttachment};
use crate::db::new_uid;
use crate::http::{BodyStream, ByteRange, Request, Response, encode_component, parse_range};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

const CHUNK: usize = 64 * 1024;
const MAX_THUMB: u64 = 2 << 20;

pub fn dir(app: &App) -> PathBuf {
    app.cfg.data_dir.join("attachments")
}

fn path(app: &App, uid: &str, thumb: bool) -> PathBuf {
    dir(app).join(if thumb { format!("{uid}.thumb") } else { uid.to_string() })
}

pub fn remove_files(app: &App, uid: &str) {
    let _ = std::fs::remove_file(path(app, uid, false));
    let _ = std::fs::remove_file(path(app, uid, true));
}

/// Writes the body to `dest` through a temporary file, refusing more than
/// `max` bytes. Returns the size written.
async fn save(mut body: BodyStream, dest: &PathBuf, max: u64) -> Result<u64, Response> {
    let tmp = dest.with_extension("part");
    let mut file = tokio::fs::File::create(&tmp)
        .await
        .map_err(crate::app::server_error)?;
    let mut size = 0u64;
    while let Some(chunk) = body.recv().await {
        let Ok(chunk) = chunk else {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(Response::text(400, "upload interrupted"));
        };
        size += chunk.len() as u64;
        if size > max {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(Response::text(413, "file too large"));
        }
        if let Err(e) = file.write_all(&chunk).await {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(crate::app::server_error(e));
        }
    }
    file.flush().await.map_err(crate::app::server_error)?;
    drop(file);
    tokio::fs::rename(&tmp, dest)
        .await
        .map_err(crate::app::server_error)?;
    Ok(size)
}

fn sane_name(name: &str) -> String {
    let name: String = name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .chars()
        .filter(|c| !c.is_control())
        .take(200)
        .collect();
    if name.trim().is_empty() { "file".into() } else { name }
}

/// `POST /attachments?name=…&type=…[&w=…&h=…]` with the file as the body.
pub async fn upload(app: &Arc<App>, mut req: Request) -> Response {
    let name = sane_name(&req.query("name").unwrap_or_default());
    let mime = req
        .query("type")
        .filter(|t| t.contains('/') && t.len() < 100)
        .unwrap_or_else(|| crate::assets::mime_type(&name).split(';').next().unwrap_or("").to_string());
    let dim = |k: &str| req.query(k).and_then(|v| v.parse::<i64>().ok()).filter(|v| *v > 0);
    let (width, height) = (dim("w"), dim("h"));
    let Some(body) = req.stream.take() else {
        return Response::error(400, "no body");
    };
    if let Err(e) = tokio::fs::create_dir_all(dir(app)).await {
        return crate::app::server_error(e);
    }
    let uid = new_uid();
    let size = match save(body, &path(app, &uid, false), app.cfg.max_upload).await {
        Ok(s) => s,
        Err(res) => return res,
    };
    let now = (app.now)();
    let uid2 = uid.clone();
    let res = app
        .db
        .with(move |c| {
            atts::create(
                c,
                &uid2,
                NewAttachment {
                    filename: name,
                    mime,
                    size: size as i64,
                    width,
                    height,
                    created_ts: now,
                },
            )
        })
        .await;
    match res {
        Ok(a) => {
            app.changed();
            Response::json(200, &crate::pages::attachment_json(&app.cfg.base, &a))
        }
        Err(e) => {
            remove_files(app, &uid);
            e.into()
        }
    }
}

/// `POST /attachments/{uid}/thumb` with a small WebP or JPEG the browser made.
pub async fn upload_thumb(app: &Arc<App>, mut req: Request, uid: &str) -> Response {
    let Some(body) = req.stream.take() else {
        return Response::error(400, "no body");
    };
    let uid_owned = uid.to_string();
    match app.db.with(move |c| atts::get(c, &uid_owned)).await {
        Ok(Some(_)) => {}
        Ok(None) => return Response::not_found(),
        Err(e) => return e.into(),
    }
    if let Err(res) = save(body, &path(app, uid, true), MAX_THUMB).await {
        return res;
    }
    let uid_owned = uid.to_string();
    match app.db.with(move |c| atts::set_thumb(c, &uid_owned)).await {
        Ok(_) => {
            app.changed();
            Response::new(204)
        }
        Err(e) => e.into(),
    }
}

pub async fn delete(app: &Arc<App>, uid: &str) -> Response {
    let uid_owned = uid.to_string();
    match app.db.with(move |c| atts::delete(c, &uid_owned)).await {
        Ok(true) => {
            remove_files(app, uid);
            app.changed();
            Response::new(204)
        }
        Ok(false) => Response::not_found(),
        Err(e) => e.into(),
    }
}

/// Types a browser may show inline; anything else downloads, sandboxed, so
/// an uploaded HTML or SVG file cannot run script on this origin.
fn inline(mime: &str) -> bool {
    (mime.starts_with("image/") && mime != "image/svg+xml")
        || mime.starts_with("audio/")
        || mime.starts_with("video/")
        || mime == "application/pdf"
        || mime == "text/plain"
}

pub async fn serve(app: &Arc<App>, req: &Request, uid: &str, thumb: bool) -> Response {
    let uid_owned = uid.to_string();
    let a = match app.db.with(move |c| atts::get(c, &uid_owned)).await {
        Ok(Some(a)) => a,
        Ok(None) => return Response::not_found(),
        Err(e) => return e.into(),
    };
    let file_path = path(app, uid, thumb && a.has_thumb);
    let Ok(mut file) = tokio::fs::File::open(&file_path).await else {
        return Response::not_found();
    };
    let Ok(meta) = file.metadata().await else {
        return Response::not_found();
    };
    let size = meta.len();
    let mime = if thumb && a.has_thumb { "image/webp".to_string() } else { a.mime.clone() };
    let mut res = Response::new(200)
        .with("content-type", &mime)
        .with("cache-control", "private, max-age=31536000, immutable")
        .with("accept-ranges", "bytes")
        .with("x-content-type-options", "nosniff");
    if !thumb {
        if inline(&mime) {
            res.set("content-disposition", &format!("inline; filename*=UTF-8''{}", encode_component(&a.filename)));
        } else {
            res.set("content-disposition", &format!("attachment; filename*=UTF-8''{}", encode_component(&a.filename)));
            res.set("content-security-policy", "sandbox");
        }
    }
    let (start, len) = match parse_range(req.header("range"), size) {
        ByteRange::Full => (0, size),
        ByteRange::Part(a, b) => {
            res.status = 206;
            res.set("content-range", &format!("bytes {a}-{b}/{size}"));
            (a, b - a + 1)
        }
        ByteRange::Unsatisfiable => {
            return Response::new(416).with("content-range", &format!("bytes */{size}"));
        }
    };
    res.set("content-length", &len.to_string());
    if req.method == "HEAD" {
        return res;
    }
    if start > 0 && file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
        return Response::internal_error();
    }
    let (tx, rx) = tokio::sync::mpsc::channel(2);
    tokio::spawn(async move {
        let mut left = len;
        let mut buf = vec![0u8; CHUNK];
        while left > 0 {
            let want = (left as usize).min(CHUNK);
            match file.read(&mut buf[..want]).await {
                Ok(0) | Err(_) => {
                    let _ = tx.send(Err(())).await;
                    return;
                }
                Ok(n) => {
                    left -= n as u64;
                    if tx.send(Ok(bytes::Bytes::copy_from_slice(&buf[..n]))).await.is_err() {
                        return;
                    }
                }
            }
        }
    });
    res.stream(rx)
}

/// Request paths whose bodies are streamed instead of buffered.
pub fn streams_body(method: &str, path: &str) -> bool {
    method == "POST"
        && (path.ends_with("/attachments") || (path.contains("/attachments/") && path.ends_with("/thumb"))
            || path.ends_with("/api/memos/attachments"))
}

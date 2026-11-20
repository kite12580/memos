//! Attachment files: streamed to disk on upload, streamed back with Range
//! support. Thumbnails are made by the browser; the server never decodes
//! an image.

use crate::app::{App, server_error};
use crate::db::attachments::{self as atts, NewAttachment};
use crate::db::new_uid;
use crate::http::{BODY_TIMEOUT, BodyStream, ByteRange, Request, Response, encode_component, parse_range};
use crate::motion::Motion;
use bytes::BytesMut;
use http_body_util::BodyExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

const CHUNK: usize = 64 * 1024;
const MAX_THUMB: u64 = 2 << 20;
const PARTIAL: &str = "part";

pub fn dir(data_dir: &Path) -> PathBuf {
    data_dir.join("attachments")
}

/// Creates the attachment directory and clears uploads a crash left half-written.
pub fn prepare(data_dir: &Path) -> std::io::Result<()> {
    let dir = dir(data_dir);
    std::fs::create_dir_all(&dir)?;
    for entry in std::fs::read_dir(&dir)?.flatten() {
        if entry.path().extension().is_some_and(|e| e == PARTIAL) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    Ok(())
}

fn path(app: &App, uid: &str, thumb: bool) -> PathBuf {
    dir(&app.cfg.data_dir).join(if thumb { format!("{uid}.thumb") } else { uid.to_string() })
}

pub fn remove_files(app: &App, uid: &str) {
    let _ = std::fs::remove_file(path(app, uid, false));
    let _ = std::fs::remove_file(path(app, uid, true));
}

/// An upload in progress, deleted unless it is renamed into place.
struct Partial(Option<PathBuf>);

impl Drop for Partial {
    fn drop(&mut self) {
        if let Some(path) = &self.0 {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn too_large() -> Response {
    Response::text(413, "file too large")
}

/// Writes the body to `dest` through a temporary file, refusing more than
/// `max` bytes. Returns the size written.
async fn save(req: &mut Request, dest: &Path, max: u64) -> Result<u64, Response> {
    if req.header("content-length").and_then(|l| l.parse::<u64>().ok()).is_some_and(|l| l > max) {
        return Err(too_large());
    }
    let Some(mut body) = req.stream.take() else {
        return Err(Response::error(400, "no body"));
    };
    let tmp = dest.with_file_name(format!("{}.{PARTIAL}", new_uid()));
    let mut file = tokio::fs::File::create(&tmp).await.map_err(server_error)?;
    let mut partial = Partial(Some(tmp.clone()));
    let mut size = 0u64;
    loop {
        let frame = match tokio::time::timeout(BODY_TIMEOUT, body.frame()).await {
            Ok(None) => break,
            Ok(Some(Ok(frame))) => frame,
            _ => return Err(Response::text(400, "upload interrupted")),
        };
        let Ok(chunk) = frame.into_data() else {
            continue;
        };
        size += chunk.len() as u64;
        if size > max {
            return Err(too_large());
        }
        file.write_all(&chunk).await.map_err(server_error)?;
    }
    file.flush().await.map_err(server_error)?;
    file.sync_data().await.map_err(server_error)?;
    drop(file);
    tokio::fs::rename(&tmp, dest).await.map_err(server_error)?;
    partial.0 = None;
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

async fn detect_motion(file: PathBuf, size: u64) -> Option<crate::motion::Detection> {
    tokio::task::spawn_blocking(move || crate::motion::detect(&mut std::fs::File::open(file).ok()?, size).ok().flatten())
        .await
        .ok()
        .flatten()
}

/// `POST /attachments?name=…&type=…[&w=…&h=…][&media=…][&motion=still|video&group=…]`
/// with the file as the body; `media` is the JSON `media::sanitize` takes, and
/// `motion` with `group` makes the file one half of an Apple Live Photo.
pub async fn upload(app: &Arc<App>, mut req: Request) -> Response {
    let name = sane_name(&req.query("name").unwrap_or_default());
    let mime = req
        .query("type")
        .filter(|t| t.contains('/') && t.len() < 100)
        .unwrap_or_else(|| crate::assets::mime_type(&name).split(';').next().unwrap_or("").to_string());
    let dim = |k: &str| req.query(k).and_then(|v| v.parse::<i64>().ok()).filter(|v| *v > 0);
    let (width, height) = (dim("w"), dim("h"));
    let media = req.query("media").and_then(|m| crate::media::sanitize(&m, &mime, width.is_some()));
    let mut motion = match (req.query("motion"), req.query("group")) {
        (None, _) => None,
        (Some(role), group) => match Motion::from_client(&role, &group.unwrap_or_default()) {
            Some(m) => Some(m),
            None => return Response::error(400, "invalid motion media"),
        },
    };
    let uid = new_uid();
    let size = match save(&mut req, &path(app, &uid, false), app.cfg.max_upload).await {
        Ok(s) => s,
        Err(res) => return res,
    };
    if motion.is_none() && matches!(mime.as_str(), "image/jpeg" | "image/jpg") {
        motion = detect_motion(path(app, &uid, false), size).await.map(|d| Motion::container(&uid, d));
    }
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
                    media,
                    motion,
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
    let uid_owned = uid.to_string();
    match app.db.with(move |c| atts::get(c, &uid_owned)).await {
        Ok(Some(_)) => {}
        Ok(None) => return Response::not_found(),
        Err(e) => return e.into(),
    }
    if let Err(res) = save(&mut req, &path(app, uid, true), MAX_THUMB).await {
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
    match app.db.tx(move |c| atts::delete(c, &uid_owned)).await {
        Ok(uids) if uids.is_empty() => Response::not_found(),
        Ok(uids) => {
            for uid in &uids {
                remove_files(app, uid);
            }
            app.changed();
            Response::new(204)
        }
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

/// The account avatar; its URL carries a content hash, so it caches for good.
pub fn avatar(app: &App) -> Response {
    match app.profile().avatar_file.clone() {
        Some(a) => Response::new(200)
            .with("content-type", &a.mime)
            .with("cache-control", "private, max-age=31536000, immutable")
            .with("x-content-type-options", "nosniff")
            .body(a.bytes),
        None => Response::not_found(),
    }
}

pub async fn serve(app: &Arc<App>, req: &Request, uid: &str, thumb: bool) -> Response {
    let uid_owned = uid.to_string();
    let a = match app.db.with(move |c| atts::get(c, &uid_owned)).await {
        Ok(Some(a)) => a,
        Ok(None) => return Response::not_found(),
        Err(e) => return e.into(),
    };
    let clip = if !thumb && req.query("motion").as_deref() == Some("true") {
        match a.motion.as_ref().and_then(|m| m.video_start) {
            Some(start) => Some(start),
            None => return Response::error(400, "attachment does not have motion clip"),
        }
    } else {
        None
    };
    let file_path = path(app, uid, thumb && a.has_thumb);
    let Ok(mut file) = tokio::fs::File::open(&file_path).await else {
        return Response::not_found();
    };
    let Ok(meta) = file.metadata().await else {
        return Response::not_found();
    };
    let offset = clip.unwrap_or(0).min(meta.len());
    let size = meta.len() - offset;
    let mime = if clip.is_some() {
        "video/mp4".to_string()
    } else if thumb && a.has_thumb {
        "image/webp".to_string()
    } else {
        a.mime.clone()
    };
    let mut res = Response::new(200)
        .with("content-type", &mime)
        .with("cache-control", "private, max-age=31536000, immutable")
        .with("accept-ranges", "bytes")
        .with("x-content-type-options", "nosniff");
    if clip.is_some() {
        res.set("content-disposition", &format!("inline; filename=\"{}.mp4\"", a.uid));
    } else if !thumb {
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
    if start + offset > 0 && file.seek(std::io::SeekFrom::Start(start + offset)).await.is_err() {
        return Response::internal_error();
    }
    res.stream(read_stream(file, len))
}

fn read_stream(file: tokio::fs::File, len: u64) -> BodyStream {
    let (tx, rx) = tokio::sync::mpsc::channel(2);
    tokio::spawn(async move {
        let mut file = file.take(len);
        while file.limit() > 0 {
            let mut buf = BytesMut::with_capacity(file.limit().min(CHUNK as u64) as usize);
            let chunk = match file.read_buf(&mut buf).await {
                Ok(n) if n > 0 => Ok(buf.freeze()),
                _ => Err(()),
            };
            let failed = chunk.is_err();
            if tx.send(chunk).await.is_err() || failed {
                return;
            }
        }
    });
    rx
}

//! The built client: hashed files under `assets/`, held in memory in the
//! brotli and gzip forms the build wrote, plus the names the pages link to.

use crate::http::{IMMUTABLE_CACHE, Request, Response, accepts};
use bytes::Bytes;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub fn mime_type(name: &str) -> &'static str {
    let ext = name
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "wasm" => "application/wasm",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "heic" => "image/heic",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "txt" | "md" => "text/plain; charset=utf-8",
        "pdf" => "application/pdf",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "wav" => "audio/wav",
        "weba" => "audio/webm",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

struct Asset {
    mime: &'static str,
    br: Option<Bytes>,
    gz: Option<Bytes>,
    /// Read from disk on the rare request that takes no compression.
    path: PathBuf,
}

pub struct Assets {
    files: HashMap<String, Asset>,
    pub css: String,
    pub boot: String,
    pub sprite: String,
    pub preload: Vec<String>,
    pub render_version: String,
    pub favicon: Bytes,
}

impl Assets {
    pub fn load(dir: &Path) -> Result<Assets, String> {
        let manifest: serde_json::Value = std::fs::read(dir.join("manifest.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .ok_or_else(|| format!("{}: no manifest.json; build the client first", dir.display()))?;
        let field = |k: &str| manifest[k].as_str().unwrap_or_default().to_string();
        let mut files = HashMap::new();
        let assets = dir.join("assets");
        for entry in std::fs::read_dir(&assets).map_err(|e| format!("{}: {e}", assets.display()))? {
            let Ok(entry) = entry else { continue };
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.ends_with(".br") || name.ends_with(".gz") {
                continue;
            }
            let read = |ext: &str| std::fs::read(assets.join(format!("{name}.{ext}"))).ok().map(Bytes::from);
            files.insert(
                format!("assets/{name}"),
                Asset {
                    mime: mime_type(&name),
                    br: read("br"),
                    gz: read("gz"),
                    path: entry.path(),
                },
            );
        }
        Ok(Assets {
            files,
            css: field("css"),
            boot: field("boot"),
            render_version: field("renderVersion"),
            sprite: field("sprite"),
            preload: manifest["preload"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                .unwrap_or_default(),
            favicon: std::fs::read(dir.join("favicon.svg")).unwrap_or_default().into(),
        })
    }

    /// `assets/<name>` with the smallest encoding the client takes.
    pub fn serve(&self, req: &Request, key: &str) -> Option<Response> {
        let file = self.files.get(key)?;
        let ae = req.header("accept-encoding");
        let res = Response::new(200)
            .with("content-type", file.mime)
            .with("cache-control", IMMUTABLE_CACHE)
            .with("vary", "Accept-Encoding");
        if let Some(br) = file.br.as_ref().filter(|_| accepts(ae, "br")) {
            return Some(res.with("content-encoding", "br").body(br.clone()));
        }
        if let Some(gz) = file.gz.as_ref().filter(|_| accepts(ae, "gzip")) {
            return Some(res.with("content-encoding", "gzip").body(gz.clone()));
        }
        std::fs::read(&file.path).ok().map(|data| res.body(data))
    }
}

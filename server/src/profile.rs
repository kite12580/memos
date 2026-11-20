//! The instance's name, icon and description, and the account's nickname and
//! avatar: one JSON setting the pages read from memory.

use bytes::Bytes;
use rusqlite::Connection;
use serde_json::{Value, json};

use crate::db::{DbResult, get_setting, set_setting};

const KEY: &str = "profile";
pub const DEFAULT_TITLE: &str = "Memos";
pub const MAX_AVATAR_BYTES: usize = 2 << 20;
const AVATAR_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/webp", "image/gif"];

#[derive(Default, Clone)]
pub struct Profile {
    pub title: String,
    pub logo: String,
    pub description: String,
    pub nickname: String,
    /// `data:image/…;base64,…`, as memos stores it.
    pub avatar: String,
    pub avatar_file: Option<Avatar>,
}

#[derive(Default, Clone)]
pub struct Avatar {
    pub mime: String,
    pub bytes: Bytes,
    pub rev: String,
}

impl Profile {
    pub fn load(c: &Connection) -> DbResult<Profile> {
        let v: Value = get_setting(c, KEY)?
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(Value::Null);
        let s = |k: &str| v[k].as_str().unwrap_or_default().to_string();
        Ok(Profile {
            title: s("title"),
            logo: s("logo"),
            description: s("description"),
            nickname: s("nickname"),
            avatar: s("avatar"),
            avatar_file: None,
        }
        .decoded())
    }

    pub fn decoded(mut self) -> Profile {
        self.avatar_file = self.decode_avatar();
        self
    }

    pub fn save(&self, c: &Connection) -> DbResult<()> {
        let v = json!({
            "title": self.title,
            "logo": self.logo,
            "description": self.description,
            "nickname": self.nickname,
            "avatar": self.avatar,
        });
        set_setting(c, KEY, &v.to_string())
    }

    pub fn title(&self) -> &str {
        if self.title.is_empty() { DEFAULT_TITLE } else { &self.title }
    }

    /// The decoded avatar, versioned by its content so its URL can be cached for good.
    fn decode_avatar(&self) -> Option<Avatar> {
        let (mime, data) = self.avatar.strip_prefix("data:")?.split_once(";base64,")?;
        if !AVATAR_TYPES.contains(&mime) {
            return None;
        }
        let bytes = base64_decode(data)?;
        if bytes.len() > MAX_AVATAR_BYTES {
            return None;
        }
        let mut h: u64 = 0xcbf29ce484222325;
        for b in &bytes {
            h = (h ^ *b as u64).wrapping_mul(0x100000001b3);
        }
        Some(Avatar {
            mime: mime.to_string(),
            bytes: Bytes::from(bytes),
            rev: format!("{h:x}"),
        })
    }
}

/// A logo the page may load: a web or app-relative address, or an inline image.
pub fn valid_logo(url: &str) -> bool {
    url.is_empty()
        || url.starts_with("https://")
        || url.starts_with("http://")
        || (url.starts_with('/') && !url.starts_with("//"))
        || url.starts_with("data:image/")
}

fn base64_decode(s: &str) -> Option<Vec<u8>> {
    let val = |c: u8| match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    };
    let s = s.trim_end_matches('=').as_bytes();
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0);
    for &c in s {
        acc = (acc << 6) | val(c)? as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_avatar() {
        let p = Profile {
            avatar: "data:image/png;base64,aGVsbG8=".into(),
            ..Default::default()
        };
        let a = p.decoded().avatar_file.unwrap();
        assert_eq!((a.mime.as_str(), &a.bytes[..]), ("image/png", &b"hello"[..]));
        let bad = Profile {
            avatar: "data:text/html;base64,aGVsbG8=".into(),
            ..Default::default()
        };
        assert!(bad.decoded().avatar_file.is_none());
    }

    #[test]
    fn logos() {
        assert!(valid_logo("https://example.com/a.png"));
        assert!(valid_logo("/file/x/logo.png"));
        assert!(!valid_logo("//evil.example/a.png"));
        assert!(!valid_logo("javascript:alert(1)"));
    }
}

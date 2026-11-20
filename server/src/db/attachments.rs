use super::DbResult;
use crate::motion::Motion;
use rusqlite::{Connection, OptionalExtension, Row, Transaction, params, params_from_iter};
use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct Attachment {
    pub id: i64,
    pub uid: String,
    pub memo_id: Option<i64>,
    pub filename: String,
    pub mime: String,
    pub kind: Kind,
    pub size: i64,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub has_thumb: bool,
    pub created_ts: i64,
    pub media: Option<String>,
    pub motion: Option<Motion>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Image,
    Video,
    Audio,
    File,
}

impl Kind {
    pub fn from_mime(mime: &str) -> Kind {
        match mime.split('/').next().unwrap_or("") {
            "image" => Kind::Image,
            "video" => Kind::Video,
            "audio" => Kind::Audio,
            _ => Kind::File,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Image => "image",
            Kind::Video => "video",
            Kind::Audio => "audio",
            Kind::File => "file",
        }
    }

    fn parse(s: &str) -> Kind {
        match s {
            "image" => Kind::Image,
            "video" => Kind::Video,
            "audio" => Kind::Audio,
            _ => Kind::File,
        }
    }
}

const COLUMNS: &str =
    "id, uid, memo_id, filename, mime, kind, size, width, height, has_thumb, created_ts, media, motion";

fn attachment(r: &Row) -> rusqlite::Result<Attachment> {
    Ok(Attachment {
        id: r.get(0)?,
        uid: r.get(1)?,
        memo_id: r.get(2)?,
        filename: r.get(3)?,
        mime: r.get(4)?,
        kind: Kind::parse(&r.get::<_, String>(5)?),
        size: r.get(6)?,
        width: r.get(7)?,
        height: r.get(8)?,
        has_thumb: r.get(9)?,
        created_ts: r.get(10)?,
        media: r.get(11)?,
        motion: r.get::<_, Option<String>>(12)?.as_deref().and_then(Motion::from_json),
    })
}

pub struct NewAttachment {
    pub filename: String,
    pub mime: String,
    pub size: i64,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub created_ts: i64,
    pub media: Option<String>,
    pub motion: Option<Motion>,
}

/// Records an uploaded file; `uid` names it on disk.
pub fn create(c: &Connection, uid: &str, a: NewAttachment) -> DbResult<Attachment> {
    let kind = Kind::from_mime(&a.mime);
    c.prepare_cached(
        "INSERT INTO attachment(uid, filename, mime, kind, size, width, height, created_ts, media, motion)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )?
    .execute(params![uid, a.filename, a.mime, kind.as_str(), a.size, a.width, a.height, a.created_ts, a.media, a.motion.as_ref().map(Motion::to_json)])?;
    Ok(get(c, uid)?.expect("attachment just created"))
}

pub fn get(c: &Connection, uid: &str) -> DbResult<Option<Attachment>> {
    Ok(c.prepare_cached(&format!("SELECT {COLUMNS} FROM attachment WHERE uid = ?"))?
        .query_row([uid], attachment)
        .optional()?)
}

/// The attachments with these uids, in the order given; unknown uids are skipped.
pub fn by_uids(c: &Connection, uids: &[String]) -> DbResult<Vec<Attachment>> {
    let mut out = Vec::with_capacity(uids.len());
    for uid in uids {
        out.extend(get(c, uid)?);
    }
    Ok(out)
}

pub fn set_thumb(c: &Connection, uid: &str) -> DbResult<bool> {
    Ok(c.prepare_cached("UPDATE attachment SET has_thumb = 1 WHERE uid = ?")?
        .execute([uid])?
        > 0)
}

/// Gives the memo exactly these attachments, in this order, with a motion
/// photo's members kept together. A motion photo the memo has is dropped
/// whole unless every member is kept (memos' normalizeMemoAttachments).
/// Attachments dropped from it stay in the library as unused.
pub fn attach(tx: &Transaction, memo_id: i64, uids: &[String]) -> DbResult<()> {
    let mut current: HashMap<String, Vec<String>> = HashMap::new();
    for row in tx
        .prepare_cached("SELECT motion ->> 'group', uid FROM attachment WHERE memo_id = ? AND motion IS NOT NULL")?
        .query_map([memo_id], |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, String>(1)?)))?
    {
        if let (Some(group), uid) = row? {
            current.entry(group).or_default().push(uid);
        }
    }
    let requested = by_uids(tx, uids)?;
    let mut order: Vec<&str> = vec![];
    for a in &requested {
        if order.contains(&a.uid.as_str()) {
            continue;
        }
        let Some(group) = a.motion.as_ref().map(|m| &m.group) else {
            order.push(&a.uid);
            continue;
        };
        if current.get(group).is_some_and(|members| members.len() > 1 && !members.iter().all(|m| uids.contains(m))) {
            continue;
        }
        for b in &requested {
            if b.motion.as_ref().is_some_and(|m| &m.group == group) && !order.contains(&b.uid.as_str()) {
                order.push(&b.uid);
            }
        }
    }
    tx.prepare_cached("UPDATE attachment SET memo_id = NULL WHERE memo_id = ?")?
        .execute([memo_id])?;
    let mut st = tx.prepare_cached("UPDATE attachment SET memo_id = ?, position = ? WHERE uid = ?")?;
    for (i, uid) in order.iter().enumerate() {
        st.execute(params![memo_id, i as i64, uid])?;
    }
    Ok(())
}

pub fn motion_partners(c: &Connection, a: &Attachment) -> DbResult<Vec<Attachment>> {
    let Some(m) = &a.motion else {
        return Ok(vec![]);
    };
    Ok(c.prepare_cached(&format!("SELECT {COLUMNS} FROM attachment WHERE motion ->> 'group' = ? AND motion IS NOT NULL AND uid != ? ORDER BY id"))?
        .query_map(params![m.group, a.uid], attachment)?
        .collect::<rusqlite::Result<_>>()?)
}

pub fn for_memos(c: &Connection, ids: &[i64]) -> DbResult<HashMap<i64, Vec<Attachment>>> {
    let mut out: HashMap<i64, Vec<Attachment>> = HashMap::new();
    if ids.is_empty() {
        return Ok(out);
    }
    let marks = vec!["?"; ids.len()].join(",");
    let mut st = c.prepare(&format!(
        "SELECT {COLUMNS} FROM attachment WHERE memo_id IN ({marks}) ORDER BY position, id"
    ))?;
    for a in st.query_map(params_from_iter(ids), attachment)? {
        let a = a?;
        out.entry(a.memo_id.unwrap_or_default()).or_default().push(a);
    }
    Ok(out)
}

/// Leaves out a Live Photo's video when its still is in the same memo: the
/// library shows the pair once, as the still.
macro_rules! paired_video {
    () => {
        "NOT (a.motion IS NOT NULL AND a.motion ->> 'role' = 'video' AND EXISTS (
          SELECT 1 FROM attachment s WHERE s.motion IS NOT NULL AND s.motion ->> 'group' = a.motion ->> 'group'
            AND s.motion ->> 'role' = 'still' AND s.memo_id = a.memo_id))"
    };
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Section {
    All,
    Media,
    Audio,
    Documents,
    Unused,
}

impl Section {
    pub fn parse(s: &str) -> Section {
        match s {
            "media" => Section::Media,
            "audio" => Section::Audio,
            "documents" => Section::Documents,
            "unused" => Section::Unused,
            _ => Section::All,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Section::All => "all",
            Section::Media => "media",
            Section::Audio => "audio",
            Section::Documents => "documents",
            Section::Unused => "unused",
        }
    }

    fn condition(self) -> &'static str {
        match self {
            Section::All => concat!("a.memo_id IS NOT NULL AND ", paired_video!()),
            Section::Media => concat!("a.memo_id IS NOT NULL AND a.kind IN ('image', 'video') AND ", paired_video!()),
            Section::Audio => "a.memo_id IS NOT NULL AND a.kind = 'audio'",
            Section::Documents => "a.memo_id IS NOT NULL AND a.kind = 'file'",
            Section::Unused => "a.memo_id IS NULL",
        }
    }
}

/// Library attachments, newest first, with their memo's uid.
pub fn library(c: &Connection, section: Section, before: Option<i64>, limit: usize) -> DbResult<Vec<(Attachment, Option<String>)>> {
    let sql = format!(
        "SELECT a.id, a.uid, a.memo_id, a.filename, a.mime, a.kind, a.size, a.width, a.height, a.has_thumb, a.created_ts, a.media, a.motion, m.uid
         FROM attachment a LEFT JOIN memo m ON m.id = a.memo_id
         WHERE {} AND a.id < ? ORDER BY a.id DESC LIMIT ?",
        section.condition()
    );
    Ok(c.prepare_cached(&sql)?
        .query_map(params![before.unwrap_or(i64::MAX), limit as i64], |r| {
            Ok((attachment(r)?, r.get(13)?))
        })?
        .collect::<rusqlite::Result<_>>()?)
}

pub fn section_counts(c: &Connection) -> DbResult<[i64; 4]> {
    let mut out = [0; 4];
    for (i, s) in [Section::Media, Section::Audio, Section::Documents, Section::Unused]
        .into_iter()
        .enumerate()
    {
        out[i] = c
            .prepare_cached(&format!("SELECT count(*) FROM attachment a WHERE {}", s.condition()))?
            .query_row([], |r| r.get(0))?;
    }
    Ok(out)
}

/// Deletes the attachment with the rest of its motion photo, returning the
/// uids deleted; the caller removes the files.
pub fn delete(c: &Connection, uid: &str) -> DbResult<Vec<String>> {
    let Some(a) = get(c, uid)? else {
        return Ok(vec![]);
    };
    let mut uids: Vec<String> = motion_partners(c, &a)?.into_iter().map(|p| p.uid).collect();
    uids.insert(0, a.uid);
    let mut st = c.prepare_cached("DELETE FROM attachment WHERE uid = ?")?;
    for uid in &uids {
        st.execute([uid])?;
    }
    Ok(uids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::content;
    use crate::db::Db;
    use crate::db::memos::{self, NewMemo};

    fn memo(c: &Transaction) -> i64 {
        let html = content::fallback_html("m");
        memos::create(c, NewMemo { content: "m".into(), derived: content::derive(&html), html, html_ver: String::new(), snippet: "m".into(), parent_id: None, created_ts: 1 })
            .unwrap()
            .id
    }

    fn add(c: &Connection, uid: &str, mime: &str, motion: Option<Motion>) {
        create(c, uid, NewAttachment { filename: uid.into(), mime: mime.into(), size: 1, width: None, height: None, created_ts: 1, media: None, motion }).unwrap();
    }

    fn attached(c: &Connection, memo_id: i64) -> Vec<String> {
        for_memos(c, &[memo_id]).unwrap().remove(&memo_id).unwrap_or_default().into_iter().map(|a| a.uid).collect()
    }

    #[test]
    fn keeps_a_live_photo_whole() {
        let db = Db::open(":memory:").unwrap();
        db.blocking(|c| {
            let c = &c.transaction()?;
            let id = memo(c);
            add(c, "still", "image/jpeg", Motion::from_client("still", "g"));
            add(c, "video", "video/quicktime", Motion::from_client("video", "g"));
            add(c, "doc", "text/plain", None);
            let uids = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
            attach(c, id, &uids(&["still", "doc", "video"]))?;
            assert_eq!(attached(c, id), ["still", "video", "doc"]);
            assert_eq!(section_counts(c)?, [1, 0, 1, 0]);
            assert_eq!(library(c, Section::Media, None, 10)?.len(), 1);
            attach(c, id, &uids(&["doc", "still"]))?;
            assert_eq!(attached(c, id), ["doc"]);
            assert_eq!(section_counts(c)?, [0, 0, 1, 2]);
            assert_eq!(delete(c, "video")?, ["video", "still"]);
            assert!(get(c, "still")?.is_none());
            Ok(())
        })
        .unwrap();
    }
}

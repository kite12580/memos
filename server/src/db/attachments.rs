use super::DbResult;
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
    "id, uid, memo_id, filename, mime, kind, size, width, height, has_thumb, created_ts, media";

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
}

/// Records an uploaded file; `uid` names it on disk.
pub fn create(c: &Connection, uid: &str, a: NewAttachment) -> DbResult<Attachment> {
    let kind = Kind::from_mime(&a.mime);
    c.prepare_cached(
        "INSERT INTO attachment(uid, filename, mime, kind, size, width, height, created_ts, media)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )?
    .execute(params![uid, a.filename, a.mime, kind.as_str(), a.size, a.width, a.height, a.created_ts, a.media])?;
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

/// Gives the memo exactly these attachments, in this order. Attachments
/// dropped from it stay in the library as unused.
pub fn attach(tx: &Transaction, memo_id: i64, uids: &[String]) -> DbResult<()> {
    tx.prepare_cached("UPDATE attachment SET memo_id = NULL WHERE memo_id = ?")?
        .execute([memo_id])?;
    let mut st = tx.prepare_cached("UPDATE attachment SET memo_id = ?, position = ? WHERE uid = ?")?;
    for (i, uid) in uids.iter().enumerate() {
        st.execute(params![memo_id, i as i64, uid])?;
    }
    Ok(())
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
            Section::All => "a.memo_id IS NOT NULL",
            Section::Media => "a.memo_id IS NOT NULL AND a.kind IN ('image', 'video')",
            Section::Audio => "a.memo_id IS NOT NULL AND a.kind = 'audio'",
            Section::Documents => "a.memo_id IS NOT NULL AND a.kind = 'file'",
            Section::Unused => "a.memo_id IS NULL",
        }
    }
}

/// Library attachments, newest first, with their memo's uid.
pub fn library(c: &Connection, section: Section, before: Option<i64>, limit: usize) -> DbResult<Vec<(Attachment, Option<String>)>> {
    let sql = format!(
        "SELECT a.id, a.uid, a.memo_id, a.filename, a.mime, a.kind, a.size, a.width, a.height, a.has_thumb, a.created_ts, a.media, m.uid
         FROM attachment a LEFT JOIN memo m ON m.id = a.memo_id
         WHERE {} AND a.id < ? ORDER BY a.id DESC LIMIT ?",
        section.condition()
    );
    Ok(c.prepare_cached(&sql)?
        .query_map(params![before.unwrap_or(i64::MAX), limit as i64], |r| {
            Ok((attachment(r)?, r.get(12)?))
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

/// Deletes the row; the caller removes the file.
pub fn delete(c: &Connection, uid: &str) -> DbResult<bool> {
    Ok(c.prepare_cached("DELETE FROM attachment WHERE uid = ?")?
        .execute([uid])?
        > 0)
}

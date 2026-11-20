use super::{DbError, DbResult, new_uid};
use crate::content::Derived;
use crate::query::{self, Term};
use jiff::tz::TimeZone;
use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, Row, Transaction, params, params_from_iter};
use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct Memo {
    pub id: i64,
    pub uid: String,
    pub parent_id: Option<i64>,
    pub created_ts: i64,
    pub updated_ts: i64,
    pub archived: bool,
    pub pinned: bool,
    pub rev: i64,
    pub content: String,
    pub html: String,
    pub html_ver: String,
    pub snippet: String,
    pub comment_count: i64,
    pub has_task: bool,
    pub has_todo: bool,
}

const COLUMNS: &str = "m.id, m.uid, m.parent_id, m.created_ts, m.updated_ts, m.archived, m.pinned, m.rev, m.content, m.html, m.html_ver, m.snippet, m.comment_count, m.has_task, m.has_todo";

fn memo(r: &Row) -> rusqlite::Result<Memo> {
    Ok(Memo {
        id: r.get(0)?,
        uid: r.get(1)?,
        parent_id: r.get(2)?,
        created_ts: r.get(3)?,
        updated_ts: r.get(4)?,
        archived: r.get(5)?,
        pinned: r.get(6)?,
        rev: r.get(7)?,
        content: r.get(8)?,
        html: r.get(9)?,
        html_ver: r.get(10)?,
        snippet: r.get(11)?,
        comment_count: r.get(12)?,
        has_task: r.get(13)?,
        has_todo: r.get(14)?,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    Normal,
    Archived,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Order {
    pub by_updated: bool,
    pub asc: bool,
}

impl Order {
    fn column(self) -> &'static str {
        if self.by_updated { "updated_ts" } else { "created_ts" }
    }
}

/// Where the next page starts: just after this memo in list order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cursor {
    pub pinned: bool,
    pub ts: i64,
    pub id: i64,
}

impl Cursor {
    pub fn encode(&self) -> String {
        format!("{}.{}.{}", u8::from(self.pinned), self.ts, self.id)
    }

    pub fn decode(s: &str) -> Option<Cursor> {
        let mut it = s.split('.');
        let pinned = it.next()? == "1";
        let ts = it.next()?.parse().ok()?;
        let id = it.next()?.parse().ok()?;
        it.next().is_none().then_some(Cursor { pinned, ts, id })
    }
}

pub struct ListQuery {
    pub scope: Scope,
    pub terms: Vec<Term>,
    pub order: Order,
    pub cursor: Option<Cursor>,
    pub limit: usize,
    pub tz: TimeZone,
}

/// One page of top-level memos and the cursor of the page after it.
pub fn list(c: &Connection, q: &ListQuery) -> DbResult<(Vec<Memo>, Option<Cursor>)> {
    let ts = q.order.column();
    let (mut conds, mut params) = query::to_sql(&q.terms, &q.tz, ts);
    conds.insert(0, "m.parent_id IS NULL".into());
    conds.insert(1, format!("m.archived = {}", u8::from(q.scope == Scope::Archived)));
    let pinned_first = q.scope == Scope::Normal;
    let dir = if q.order.asc { ">" } else { "<" };
    if let Some(cur) = q.cursor {
        let after = format!("(m.{ts}, m.id) {dir} (?, ?)");
        if pinned_first {
            conds.push(format!("(m.pinned < ? OR (m.pinned = ? AND {after}))"));
            params.push(Value::Integer(cur.pinned.into()));
            params.push(Value::Integer(cur.pinned.into()));
        } else {
            conds.push(after);
        }
        params.push(Value::Integer(cur.ts));
        params.push(Value::Integer(cur.id));
    }
    let way = if q.order.asc { "ASC" } else { "DESC" };
    let order = if pinned_first {
        format!("m.pinned DESC, m.{ts} {way}, m.id {way}")
    } else {
        format!("m.{ts} {way}, m.id {way}")
    };
    let sql = format!(
        "SELECT {COLUMNS} FROM memo m WHERE {} ORDER BY {order} LIMIT {}",
        conds.join(" AND "),
        q.limit + 1
    );
    let mut st = c.prepare_cached(&sql)?;
    let mut memos = st
        .query_map(params_from_iter(params.iter()), memo)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let next = if memos.len() > q.limit {
        memos.truncate(q.limit);
        memos.last().map(|m| Cursor {
            pinned: pinned_first && m.pinned,
            ts: if q.order.by_updated { m.updated_ts } else { m.created_ts },
            id: m.id,
        })
    } else {
        None
    };
    Ok((memos, next))
}

pub fn get(c: &Connection, uid: &str) -> DbResult<Option<Memo>> {
    Ok(c.prepare_cached(&format!("SELECT {COLUMNS} FROM memo m WHERE m.uid = ?"))?
        .query_row([uid], memo)
        .optional()?)
}

pub fn get_by_id(c: &Connection, id: i64) -> DbResult<Option<Memo>> {
    Ok(c.prepare_cached(&format!("SELECT {COLUMNS} FROM memo m WHERE m.id = ?"))?
        .query_row([id], memo)
        .optional()?)
}

pub struct NewMemo {
    pub content: String,
    pub html: String,
    pub html_ver: String,
    pub derived: Derived,
    pub snippet: String,
    pub parent_id: Option<i64>,
    pub created_ts: i64,
}

fn set_tags(c: &Connection, id: i64, tags: &[String]) -> DbResult<()> {
    c.prepare_cached("DELETE FROM memo_tag WHERE memo_id = ?")?
        .execute([id])?;
    let mut st = c.prepare_cached("INSERT OR IGNORE INTO memo_tag(tag, memo_id) VALUES (?, ?)")?;
    for t in tags {
        st.execute(params![t, id])?;
    }
    Ok(())
}

pub fn create(tx: &Transaction, m: NewMemo) -> DbResult<Memo> {
    let uid = new_uid();
    let d = &m.derived;
    tx.prepare_cached(
        "INSERT INTO memo(uid, parent_id, created_ts, updated_ts, content, html, html_ver, snippet,
           has_task, has_todo, has_link, has_code, has_image)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )?
    .execute(params![
        uid,
        m.parent_id,
        m.created_ts,
        m.created_ts,
        m.content,
        m.html,
        m.html_ver,
        m.snippet,
        d.has_task,
        d.has_todo,
        d.has_link,
        d.has_code,
        d.has_image
    ])?;
    let id = tx.last_insert_rowid();
    set_tags(tx, id, &d.tags)?;
    if let Some(parent) = m.parent_id {
        tx.prepare_cached("UPDATE memo SET comment_count = comment_count + 1 WHERE id = ?")?
            .execute([parent])?;
    }
    get_by_id(tx, id)?.ok_or_else(|| DbError("memo vanished".into()))
}

pub enum Outcome<T> {
    Done(T),
    NotFound,
    /// The memo changed since the revision the caller saw.
    Conflict,
}

impl<T> Outcome<T> {
    pub fn map<U>(self, f: impl FnOnce(T) -> U) -> Outcome<U> {
        match self {
            Outcome::Done(t) => Outcome::Done(f(t)),
            Outcome::NotFound => Outcome::NotFound,
            Outcome::Conflict => Outcome::Conflict,
        }
    }
}

pub struct Edit {
    pub content: String,
    pub html: String,
    pub html_ver: String,
    pub derived: Derived,
    pub snippet: String,
    pub created_ts: Option<i64>,
    pub updated_ts: Option<i64>,
    pub now: i64,
}

/// Replaces the content of the memo at revision `rev`.
pub fn update(tx: &Transaction, uid: &str, rev: Option<i64>, e: Edit) -> DbResult<Outcome<Memo>> {
    let Some(cur) = get(tx, uid)? else {
        return Ok(Outcome::NotFound);
    };
    if rev.is_some_and(|r| r != cur.rev) {
        return Ok(Outcome::Conflict);
    }
    let d = &e.derived;
    let touched = cur.content != e.content;
    tx.prepare_cached(
        "UPDATE memo SET content = ?, html = ?, html_ver = ?, snippet = ?, has_task = ?, has_todo = ?,
           has_link = ?, has_code = ?, has_image = ?, created_ts = ?, updated_ts = ?, rev = rev + 1
         WHERE id = ?",
    )?
    .execute(params![
        e.content,
        e.html,
        e.html_ver,
        e.snippet,
        d.has_task,
        d.has_todo,
        d.has_link,
        d.has_code,
        d.has_image,
        e.created_ts.unwrap_or(cur.created_ts),
        e.updated_ts.unwrap_or(if touched { e.now } else { cur.updated_ts }),
        cur.id
    ])?;
    set_tags(tx, cur.id, &d.tags)?;
    Ok(Outcome::Done(get_by_id(tx, cur.id)?.expect("memo just updated")))
}

/// Stores HTML a browser rendered for unchanged content.
pub fn set_html(tx: &Transaction, uid: &str, rev: i64, html: &str, ver: &str, d: &Derived) -> DbResult<Outcome<Memo>> {
    let Some(cur) = get(tx, uid)? else {
        return Ok(Outcome::NotFound);
    };
    if cur.rev != rev {
        return Ok(Outcome::Conflict);
    }
    tx.prepare_cached(
        "UPDATE memo SET html = ?, html_ver = ?, has_task = ?, has_todo = ?, has_link = ?, has_code = ?,
           has_image = ? WHERE id = ?",
    )?
    .execute(params![html, ver, d.has_task, d.has_todo, d.has_link, d.has_code, d.has_image, cur.id])?;
    set_tags(tx, cur.id, &d.tags)?;
    Ok(Outcome::Done(get_by_id(tx, cur.id)?.expect("memo just updated")))
}

#[derive(Clone, Copy)]
pub enum Flag {
    Pinned,
    Archived,
}

pub fn set_flag(c: &Connection, uid: &str, flag: Flag, on: bool, now: i64) -> DbResult<bool> {
    let col = match flag {
        Flag::Pinned => "pinned",
        Flag::Archived => "archived",
    };
    let n = c
        .prepare_cached(&format!("UPDATE memo SET {col} = ?, rev = rev + 1, updated_ts = CASE WHEN ? THEN ? ELSE updated_ts END WHERE uid = ?"))?
        .execute(params![on, matches!(flag, Flag::Archived), now, uid])?;
    Ok(n > 0)
}

/// Deletes a memo with its comments; returns the uids of their attachments,
/// whose rows are gone and whose files the caller removes.
pub fn delete(tx: &Transaction, uid: &str) -> DbResult<Option<Vec<String>>> {
    let Some(cur) = get(tx, uid)? else {
        return Ok(None);
    };
    let files: Vec<String> = tx
        .prepare_cached(
            "SELECT uid FROM attachment WHERE memo_id = ?1 OR memo_id IN (SELECT id FROM memo WHERE parent_id = ?1)",
        )?
        .query_map([cur.id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    tx.prepare_cached(
        "DELETE FROM attachment WHERE memo_id = ?1 OR memo_id IN (SELECT id FROM memo WHERE parent_id = ?1)",
    )?
    .execute([cur.id])?;
    tx.prepare_cached("DELETE FROM memo WHERE id = ?")?
        .execute([cur.id])?;
    if let Some(parent) = cur.parent_id {
        tx.prepare_cached("UPDATE memo SET comment_count = max(comment_count - 1, 0) WHERE id = ?")?
            .execute([parent])?;
    }
    Ok(Some(files))
}

pub fn comments(c: &Connection, parent_id: i64) -> DbResult<Vec<Memo>> {
    Ok(c.prepare_cached(&format!(
        "SELECT {COLUMNS} FROM memo m WHERE m.parent_id = ? ORDER BY m.created_ts DESC, m.id DESC"
    ))?
    .query_map([parent_id], memo)?
    .collect::<rusqlite::Result<_>>()?)
}

/// Memos by id, in no particular order.
pub fn by_ids(c: &Connection, ids: &[i64]) -> DbResult<Vec<Memo>> {
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let marks = vec!["?"; ids.len()].join(",");
    Ok(c.prepare(&format!("SELECT {COLUMNS} FROM memo m WHERE m.id IN ({marks})"))?
        .query_map(params_from_iter(ids), memo)?
        .collect::<rusqlite::Result<_>>()?)
}

fn id_list(ids: &[i64]) -> String {
    ids.iter().map(i64::to_string).collect::<Vec<_>>().join(",")
}

/// A linked memo as cards show it.
#[derive(Debug, Clone)]
pub struct MemoLink {
    pub uid: String,
    pub snippet: String,
    pub created_ts: i64,
}

/// The memos one memo links to, and the memos linking to it.
pub type Links = (Vec<MemoLink>, Vec<MemoLink>);

/// For each memo, the memos it links to and the memos linking to it.
pub fn relations(c: &Connection, ids: &[i64]) -> DbResult<HashMap<i64, Links>> {
    let mut out: HashMap<i64, Links> = HashMap::new();
    if ids.is_empty() {
        return Ok(out);
    }
    let list = id_list(ids);
    let mut st = c.prepare(&format!(
        "SELECT r.memo_id, m.uid, m.snippet, m.created_ts FROM memo_relation r JOIN memo m ON m.id = r.related_id
         WHERE r.memo_id IN ({list}) ORDER BY m.created_ts DESC"
    ))?;
    for row in st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))? {
        let (id, uid, snippet, created_ts) = row?;
        out.entry(id).or_default().0.push(MemoLink { uid, snippet, created_ts });
    }
    let mut st = c.prepare(&format!(
        "SELECT r.related_id, m.uid, m.snippet, m.created_ts FROM memo_relation r JOIN memo m ON m.id = r.memo_id
         WHERE r.related_id IN ({list}) ORDER BY m.created_ts DESC"
    ))?;
    for row in st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))? {
        let (id, uid, snippet, created_ts) = row?;
        out.entry(id).or_default().1.push(MemoLink { uid, snippet, created_ts });
    }
    Ok(out)
}

/// Replaces the memos `id` links to. Unknown uids and links to itself are
/// skipped.
pub fn set_relations(tx: &Transaction, id: i64, uids: &[String]) -> DbResult<()> {
    tx.prepare_cached("DELETE FROM memo_relation WHERE memo_id = ?")?
        .execute([id])?;
    let mut st = tx.prepare_cached(
        "INSERT OR IGNORE INTO memo_relation(memo_id, related_id)
         SELECT ?1, id FROM memo WHERE uid = ?2 AND id != ?1",
    )?;
    for uid in uids {
        st.execute(params![id, uid])?;
    }
    Ok(())
}

pub fn reactions(c: &Connection, ids: &[i64]) -> DbResult<HashMap<i64, Vec<String>>> {
    let mut out: HashMap<i64, Vec<String>> = HashMap::new();
    if ids.is_empty() {
        return Ok(out);
    }
    let mut st = c.prepare(&format!(
        "SELECT memo_id, emoji FROM reaction WHERE memo_id IN ({}) ORDER BY created_ts",
        id_list(ids)
    ))?;
    for row in st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get(1)?)))? {
        let (id, emoji) = row?;
        out.entry(id).or_default().push(emoji);
    }
    Ok(out)
}

/// Adds the reaction, or removes it if the memo has it.
/// `now` orders reactions, so it is in milliseconds.
pub fn toggle_reaction(c: &Connection, memo_id: i64, emoji: &str, now: i64) -> DbResult<()> {
    let removed = c
        .prepare_cached("DELETE FROM reaction WHERE memo_id = ? AND emoji = ?")?
        .execute(params![memo_id, emoji])?;
    if removed == 0 {
        c.prepare_cached("INSERT INTO reaction(memo_id, emoji, created_ts) VALUES (?, ?, ?)")?
            .execute(params![memo_id, emoji, now])?;
    }
    Ok(())
}

/// Latest comments of each memo, oldest first, at most `per` each.
pub fn latest_comments(c: &Connection, ids: &[i64], per: usize) -> DbResult<HashMap<i64, Vec<Memo>>> {
    let mut out: HashMap<i64, Vec<Memo>> = HashMap::new();
    if ids.is_empty() {
        return Ok(out);
    }
    let sql = format!(
        "SELECT {COLUMNS} FROM (
           SELECT *, row_number() OVER (PARTITION BY parent_id ORDER BY created_ts DESC, id DESC) AS n
           FROM memo WHERE parent_id IN ({})
         ) m WHERE m.n <= {per} ORDER BY m.created_ts DESC, m.id DESC",
        id_list(ids)
    );
    let mut st = c.prepare(&sql)?;
    for m in st.query_map([], memo)? {
        let m = m?;
        out.entry(m.parent_id.unwrap_or_default()).or_default().push(m);
    }
    Ok(out)
}

/// Tags of non-archived top-level memos with how many memos carry each,
/// counting a memo under every ancestor of a nested tag, busiest first.
pub fn tag_counts(c: &Connection) -> DbResult<Vec<(String, i64)>> {
    let mut st = c.prepare_cached(
        "SELECT t.tag, t.memo_id FROM memo_tag t JOIN memo m ON m.id = t.memo_id
         WHERE m.archived = 0 AND m.parent_id IS NULL",
    )?;
    let mut memos_by_tag: HashMap<String, std::collections::HashSet<i64>> = HashMap::new();
    for row in st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))? {
        let (tag, id) = row?;
        let mut end = 0;
        for seg in tag.split('/') {
            end += seg.len();
            memos_by_tag.entry(tag[..end].to_string()).or_default().insert(id);
            end += 1;
        }
    }
    let mut out: Vec<(String, i64)> = memos_by_tag.into_iter().map(|(t, ids)| (t, ids.len() as i64)).collect();
    out.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    Ok(out)
}

/// Creation times of non-archived top-level memos in `[from, to)`.
pub fn created_between(c: &Connection, from: i64, to: i64) -> DbResult<Vec<i64>> {
    Ok(c.prepare_cached(
        "SELECT created_ts FROM memo m WHERE m.parent_id IS NULL AND m.archived = 0
         AND m.created_ts >= ? AND m.created_ts < ? ORDER BY m.created_ts",
    )?
    .query_map([from, to], |r| r.get(0))?
    .collect::<rusqlite::Result<_>>()?)
}

/// Memos whose HTML a browser has not rendered with editor `ver`.
pub fn stale(c: &Connection, ver: &str, limit: usize) -> DbResult<Vec<(String, i64, String)>> {
    Ok(c.prepare_cached("SELECT uid, rev, content FROM memo WHERE html_ver != ? LIMIT ?")?
        .query_map(params![ver, limit as i64], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?)
}

pub fn search_links(c: &Connection, text: &str, exclude: Option<i64>, limit: usize) -> DbResult<Vec<MemoLink>> {
    let terms: Vec<Term> = query::parse(text);
    let (mut conds, params) = query::to_sql(&terms, &TimeZone::UTC, "created_ts");
    conds.insert(0, "m.parent_id IS NULL".into());
    if let Some(id) = exclude {
        conds.push(format!("m.id != {id}"));
    }
    let sql = format!(
        "SELECT m.uid, m.snippet, m.created_ts FROM memo m WHERE {} ORDER BY m.created_ts DESC LIMIT {limit}",
        conds.join(" AND ")
    );
    Ok(c.prepare(&sql)?
        .query_map(params_from_iter(params.iter()), |r| {
            Ok(MemoLink {
                uid: r.get(0)?,
                snippet: r.get(1)?,
                created_ts: r.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::content;
    use crate::db::Db;

    fn new(content: &str, ts: i64) -> NewMemo {
        let html = content::fallback_html(content);
        NewMemo {
            content: content.into(),
            derived: content::derive(&html),
            html,
            html_ver: String::new(),
            snippet: content::snippet(content),
            parent_id: None,
            created_ts: ts,
        }
    }

    fn q(terms: &str, cursor: Option<Cursor>, limit: usize) -> ListQuery {
        ListQuery {
            scope: Scope::Normal,
            terms: query::parse(terms),
            order: Order::default(),
            cursor,
            limit,
            tz: TimeZone::UTC,
        }
    }

    #[test]
    fn lists_pages_with_pinned_first() {
        let db = Db::open(":memory:").unwrap();
        db.blocking(|c| {
            let c = &c.transaction()?;
            for i in 0..5 {
                create(c, new(&format!("memo {i} #t{}", i % 2), 100 + i))?;
            }
            let second = list(c, &q("", None, 10))?.0[3].uid.clone();
            set_flag(c, &second, Flag::Pinned, true, 0)?;
            let (page1, next) = list(c, &q("", None, 2))?;
            assert_eq!(page1.iter().map(|m| m.content.as_str()).collect::<Vec<_>>(), ["memo 1 #t1", "memo 4 #t0"]);
            let (page2, next) = list(c, &q("", next, 2))?;
            assert_eq!(page2.iter().map(|m| m.content.as_str()).collect::<Vec<_>>(), ["memo 3 #t1", "memo 2 #t0"]);
            let (page3, next) = list(c, &q("", next, 2))?;
            assert_eq!(page3.iter().map(|m| m.content.as_str()).collect::<Vec<_>>(), ["memo 0 #t0"]);
            assert_eq!(next, None);
            assert_eq!(list(c, &q("#t1", None, 10))?.0.len(), 2);
            assert_eq!(list(c, &q("-#t1 memo", None, 10))?.0.len(), 3);
            assert_eq!(list(c, &q("is:pinned", None, 10))?.0.len(), 1);
            assert_eq!(tag_counts(c)?, vec![("t0".into(), 3), ("t1".into(), 2)]);
            create(c, new("#a/b #a/c", 9))?;
            assert_eq!(tag_counts(c)?[2..], [("a".into(), 1), ("a/b".into(), 1), ("a/c".into(), 1)]);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn searches_text_and_nested_tags() {
        let db = Db::open(":memory:").unwrap();
        db.blocking(|c| {
            let c = &c.transaction()?;
            create(c, new("中文搜索测试 #work/alpha", 1))?;
            create(c, new("an apple a day #work", 2))?;
            create(c, new("#workshop notes", 3))?;
            assert_eq!(list(c, &q("搜索测", None, 10))?.0.len(), 1);
            assert_eq!(list(c, &q("APPLE", None, 10))?.0.len(), 1);
            assert_eq!(list(c, &q("an", None, 10))?.0.len(), 1);
            assert_eq!(list(c, &q("#work", None, 10))?.0.len(), 2);
            assert_eq!(list(c, &q("#work/alpha", None, 10))?.0.len(), 1);
            assert_eq!(list(c, &q("\"a day\"", None, 10))?.0.len(), 1);
            assert_eq!(list(c, &q("on:1970-01-01", None, 10))?.0.len(), 3);
            assert_eq!(list(c, &q("after:1970", None, 10))?.0.len(), 0);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn comments_relations_reactions() {
        let db = Db::open(":memory:").unwrap();
        db.blocking(|c| {
            let c = &c.transaction()?;
            let a = create(c, new("a", 1))?;
            let b = create(c, new("b", 2))?;
            let mut com = new("comment", 3);
            com.parent_id = Some(a.id);
            let com = create(c, com)?;
            assert_eq!(get(c, &a.uid)?.unwrap().comment_count, 1);
            assert_eq!(list(c, &q("", None, 10))?.0.len(), 2);
            set_relations(c, b.id, &[a.uid.clone(), b.uid.clone(), "nope".into()])?;
            let rel = relations(c, &[a.id, b.id])?;
            assert_eq!(rel[&b.id].0.len(), 1);
            assert_eq!(rel[&a.id].1[0].uid, b.uid);
            toggle_reaction(c, a.id, "👍", 5)?;
            toggle_reaction(c, a.id, "🎉", 6)?;
            toggle_reaction(c, a.id, "👍", 7)?;
            assert_eq!(reactions(c, &[a.id])?[&a.id], vec!["🎉"]);
            assert_eq!(latest_comments(c, &[a.id], 3)?[&a.id][0].uid, com.uid);
            delete(c, &com.uid)?;
            assert_eq!(get(c, &a.uid)?.unwrap().comment_count, 0);
            Ok(())
        })
        .unwrap();
    }
}

use super::DbResult;
use rusqlite::{Connection, OptionalExtension, params};

#[derive(Debug, Clone)]
pub struct View {
    pub id: i64,
    pub name: String,
    pub icon: String,
    pub query: String,
}

pub fn list(c: &Connection) -> DbResult<Vec<View>> {
    Ok(c.prepare_cached("SELECT id, name, icon, query FROM view ORDER BY position, id")?
        .query_map([], |r| {
            Ok(View {
                id: r.get(0)?,
                name: r.get(1)?,
                icon: r.get(2)?,
                query: r.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

pub fn get(c: &Connection, id: i64) -> DbResult<Option<View>> {
    Ok(c.prepare_cached("SELECT id, name, icon, query FROM view WHERE id = ?")?
        .query_row([id], |r| {
            Ok(View {
                id: r.get(0)?,
                name: r.get(1)?,
                icon: r.get(2)?,
                query: r.get(3)?,
            })
        })
        .optional()?)
}

pub fn save(c: &Connection, id: Option<i64>, name: &str, icon: &str, query: &str) -> DbResult<i64> {
    match id {
        Some(id) => {
            c.prepare_cached("UPDATE view SET name = ?, icon = ?, query = ? WHERE id = ?")?
                .execute(params![name, icon, query, id])?;
            Ok(id)
        }
        None => {
            c.prepare_cached(
                "INSERT INTO view(name, icon, query, position) VALUES (?, ?, ?, (SELECT coalesce(max(position), 0) + 1 FROM view))",
            )?
            .execute(params![name, icon, query])?;
            Ok(c.last_insert_rowid())
        }
    }
}

pub fn delete(c: &Connection, id: i64) -> DbResult<()> {
    c.prepare_cached("DELETE FROM view WHERE id = ?")?.execute([id])?;
    Ok(())
}

pub fn reorder(c: &mut Connection, ids: &[i64]) -> DbResult<()> {
    let tx = c.transaction()?;
    let mut st = tx.prepare_cached("UPDATE view SET position = ? WHERE id = ?")?;
    for (i, id) in ids.iter().enumerate() {
        st.execute(params![i as i64, id])?;
    }
    drop(st);
    tx.commit()?;
    Ok(())
}

#[derive(Debug, Clone, Default)]
pub struct TagMeta {
    pub tag: String,
    pub color: String,
    pub blur: bool,
}

pub fn tag_meta(c: &Connection) -> DbResult<Vec<TagMeta>> {
    Ok(c.prepare_cached("SELECT tag, color, blur FROM tag_meta ORDER BY tag")?
        .query_map([], |r| {
            Ok(TagMeta {
                tag: r.get(0)?,
                color: r.get(1)?,
                blur: r.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

pub fn set_tag_meta(c: &Connection, m: &TagMeta) -> DbResult<()> {
    if m.color.is_empty() && !m.blur {
        c.prepare_cached("DELETE FROM tag_meta WHERE tag = ?")?
            .execute([&m.tag])?;
    } else {
        c.prepare_cached(
            "INSERT INTO tag_meta(tag, color, blur) VALUES (?1, ?2, ?3)
             ON CONFLICT(tag) DO UPDATE SET color = ?2, blur = ?3",
        )?
        .execute(params![m.tag, m.color, m.blur])?;
    }
    Ok(())
}

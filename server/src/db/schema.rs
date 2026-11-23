use rusqlite::Connection;

/// Each entry moves the schema one version forward; `PRAGMA user_version`
/// records how many have run. Append only.
const MIGRATIONS: &[&str] = &[r#"
CREATE TABLE memo (
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  parent_id INTEGER REFERENCES memo(id) ON DELETE CASCADE,
  created_ts INTEGER NOT NULL,
  updated_ts INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL,
  html TEXT NOT NULL,
  html_ver TEXT NOT NULL DEFAULT '',
  snippet TEXT NOT NULL DEFAULT '',
  has_task INTEGER NOT NULL DEFAULT 0,
  has_todo INTEGER NOT NULL DEFAULT 0,
  has_link INTEGER NOT NULL DEFAULT 0,
  has_code INTEGER NOT NULL DEFAULT 0,
  has_image INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX memo_list_created ON memo(archived, pinned, created_ts, id) WHERE parent_id IS NULL;
CREATE INDEX memo_list_updated ON memo(archived, pinned, updated_ts, id) WHERE parent_id IS NULL;
CREATE INDEX memo_comments ON memo(parent_id, created_ts) WHERE parent_id IS NOT NULL;

CREATE TABLE memo_tag (
  tag TEXT NOT NULL,
  memo_id INTEGER NOT NULL REFERENCES memo(id) ON DELETE CASCADE,
  PRIMARY KEY (tag, memo_id)
) WITHOUT ROWID;
CREATE INDEX memo_tag_memo ON memo_tag(memo_id);

CREATE TABLE memo_relation (
  memo_id INTEGER NOT NULL REFERENCES memo(id) ON DELETE CASCADE,
  related_id INTEGER NOT NULL REFERENCES memo(id) ON DELETE CASCADE,
  PRIMARY KEY (memo_id, related_id)
) WITHOUT ROWID;
CREATE INDEX memo_relation_back ON memo_relation(related_id, memo_id);

CREATE TABLE reaction (
  memo_id INTEGER NOT NULL REFERENCES memo(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_ts INTEGER NOT NULL,
  PRIMARY KEY (memo_id, emoji)
) WITHOUT ROWID;

CREATE TABLE attachment (
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  memo_id INTEGER REFERENCES memo(id) ON DELETE SET NULL,
  position INTEGER NOT NULL DEFAULT 0,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'audio', 'file')),
  size INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  has_thumb INTEGER NOT NULL DEFAULT 0,
  created_ts INTEGER NOT NULL
);
CREATE INDEX attachment_memo ON attachment(memo_id, position);
CREATE INDEX attachment_kind ON attachment(kind, created_ts);

CREATE TABLE view (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '',
  query TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE tag_meta (
  tag TEXT PRIMARY KEY,
  color TEXT NOT NULL DEFAULT '',
  blur INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

CREATE TABLE setting (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE VIRTUAL TABLE memo_fts USING fts5(
  content, content='memo', content_rowid='id', tokenize='trigram remove_diacritics 1'
);
CREATE TRIGGER memo_fts_insert AFTER INSERT ON memo BEGIN
  INSERT INTO memo_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER memo_fts_delete AFTER DELETE ON memo BEGIN
  INSERT INTO memo_fts(memo_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
CREATE TRIGGER memo_fts_update AFTER UPDATE OF content ON memo BEGIN
  INSERT INTO memo_fts(memo_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO memo_fts(rowid, content) VALUES (new.id, new.content);
END;
"#, r#"
ALTER TABLE attachment ADD COLUMN media TEXT;
"#, r#"
ALTER TABLE attachment ADD COLUMN motion TEXT;
CREATE INDEX attachment_motion_group ON attachment(motion ->> 'group') WHERE motion IS NOT NULL;
"#];

pub fn migrate(conn: &mut Connection) -> rusqlite::Result<()> {
    let version: u32 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    for (next, sql) in (1u32..).zip(MIGRATIONS).skip(version as usize) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", next)?;
        tx.commit()?;
    }
    Ok(())
}

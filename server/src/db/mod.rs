pub mod attachments;
pub mod memos;
pub mod schema;
pub mod views;

use rusqlite::{Connection, Transaction};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub type DbResult<T> = Result<T, DbError>;

#[derive(Debug)]
pub struct DbError(pub String);

impl std::fmt::Display for DbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<rusqlite::Error> for DbError {
    fn from(e: rusqlite::Error) -> DbError {
        DbError(e.to_string())
    }
}

impl From<tokio::task::JoinError> for DbError {
    fn from(e: tokio::task::JoinError) -> DbError {
        DbError(e.to_string())
    }
}

/// One connection behind a mutex: the app has a single writer and reads are
/// a few milliseconds, so a pool would only add memory.
#[derive(Clone)]
pub struct Db {
    conn: Arc<Mutex<Connection>>,
}

impl Db {
    /// `:memory:` opens a private in-memory database.
    pub fn open(path: &str) -> DbResult<Db> {
        let mut conn = Connection::open(path)?;
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "journal_size_limit", 4 << 20)?;
        conn.pragma_update(None, "cache_size", -2000)?;
        conn.pragma_update(None, "temp_store", "MEMORY")?;
        conn.set_prepared_statement_cache_capacity(64);
        schema::migrate(&mut conn)?;
        conn.execute_batch("PRAGMA optimize=0x10002")?;
        Ok(Db {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub async fn with<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Connection) -> DbResult<T> + Send + 'static,
    ) -> DbResult<T> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || f(&mut conn.lock().unwrap_or_else(|p| p.into_inner())))
            .await?
    }

    /// `with`, inside one transaction that commits when `f` succeeds.
    pub async fn tx<T: Send + 'static>(
        &self,
        f: impl FnOnce(&Transaction) -> DbResult<T> + Send + 'static,
    ) -> DbResult<T> {
        self.with(move |c| {
            let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let out = f(&tx)?;
            tx.commit()?;
            Ok(out)
        })
        .await
    }

    /// For subcommands that run outside the async runtime.
    pub fn blocking<T>(&self, f: impl FnOnce(&mut Connection) -> DbResult<T>) -> DbResult<T> {
        f(&mut self.conn.lock().unwrap_or_else(|p| p.into_inner()))
    }
}

pub fn get_setting(c: &Connection, key: &str) -> DbResult<Option<String>> {
    use rusqlite::OptionalExtension;
    Ok(c.prepare_cached("SELECT value FROM setting WHERE key = ?")?
        .query_row([key], |r| r.get(0))
        .optional()?)
}

pub fn set_setting(c: &Connection, key: &str, value: &str) -> DbResult<()> {
    c.prepare_cached(
        "INSERT INTO setting(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
    )?
    .execute([key, value])?;
    Ok(())
}

/// A random base62 id, like memos' 22-character uids but shorter.
pub fn new_uid() -> String {
    const ALPHABET: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("random bytes");
    bytes
        .iter()
        .map(|b| ALPHABET[(*b as usize) % ALPHABET.len()] as char)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn tx_commits_all_or_nothing() {
        let db = Db::open(":memory:").unwrap();
        let failed = db
            .tx(|c| {
                set_setting(c, "a", "1")?;
                Err::<(), _>(DbError("stop".into()))
            })
            .await;
        assert!(failed.is_err());
        assert_eq!(db.blocking(|c| get_setting(c, "a")).unwrap(), None);
        db.tx(|c| set_setting(c, "a", "1")).await.unwrap();
        assert_eq!(db.blocking(|c| get_setting(c, "a")).unwrap().as_deref(), Some("1"));
    }
}

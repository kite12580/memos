//! `memos-lite backup FILE` writes one tar archive: a consistent copy of the
//! database made with `VACUUM INTO`, and every attachment file.

use crate::db::Db;
use std::fs::File;
use std::io::Write;
use std::path::Path;

pub fn run(db: &Db, data_dir: &Path, out: &Path) -> Result<(), String> {
    let snapshot = data_dir.join(".backup.db");
    let _ = std::fs::remove_file(&snapshot);
    let snap = snapshot.to_string_lossy().into_owned();
    db.blocking(|c| Ok(c.execute("VACUUM INTO ?", [&snap])?))
        .map_err(|e| format!("snapshot: {e}"))?;
    let result = (|| {
        let file: Box<dyn Write> = if out == Path::new("-") {
            Box::new(std::io::stdout().lock())
        } else {
            Box::new(File::create(out).map_err(|e| format!("{}: {e}", out.display()))?)
        };
        let mut tar = tar::Builder::new(file);
        tar.append_path_with_name(&snapshot, "memos.db")
            .map_err(|e| e.to_string())?;
        let attachments = crate::files::dir(data_dir);
        if let Ok(entries) = std::fs::read_dir(&attachments) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.ends_with(".part") {
                    continue;
                }
                // A file deleted while the backup runs is skipped.
                if let Ok(mut f) = File::open(entry.path()) {
                    tar.append_file(format!("attachments/{name}"), &mut f)
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        tar.into_inner()
            .and_then(|mut w| w.flush())
            .map_err(|e| e.to_string())
    })();
    let _ = std::fs::remove_file(&snapshot);
    result
}

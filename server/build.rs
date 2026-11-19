//! Compiles the memos locale files into string tables holding only the keys
//! the templates, the server and the client use. A key is used where the
//! source says `t.s("key")`, `t.n("key", …)`, `t.f("key", …)` or, in the
//! client, `t("key")`. Missing translations fall back to English here, so
//! a lookup at runtime is an index into a static array.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write;
use std::fs;
use std::path::{Path, PathBuf};

const PLURAL_SUFFIXES: [&str; 6] = ["_zero", "_one", "_two", "_few", "_many", "_other"];

fn files(dir: &Path, exts: &[&str], out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            if p.file_name().is_some_and(|n| n != "node_modules" && n != "dist") {
                files(&p, exts, out);
            }
        } else if p
            .extension()
            .and_then(|x| x.to_str())
            .is_some_and(|x| exts.contains(&x))
        {
            out.push(p);
        }
    }
}

/// String literals after each of `calls`.
fn keys_in(src: &str, calls: &[&str], out: &mut BTreeSet<String>) {
    for call in calls {
        let mut rest = src;
        while let Some(at) = rest.find(call) {
            let before = rest[..at].chars().next_back();
            rest = rest[at + call.len()..].trim_start();
            if before.is_some_and(|c| c.is_alphanumeric() || c == '_') {
                continue;
            }
            let Some(after) = rest.strip_prefix('"') else { continue };
            rest = after;
            let Some(end) = rest.find('"') else { break };
            let key = &rest[..end];
            if !key.is_empty() && key.chars().all(|c| c.is_alphanumeric() || "._-".contains(c)) {
                out.insert(key.to_string());
            }
        }
    }
}

fn flatten(prefix: &str, v: &serde_json::Value, out: &mut BTreeMap<String, String>) {
    match v {
        serde_json::Value::Object(m) => {
            for (k, v) in m {
                let key = if prefix.is_empty() { k.clone() } else { format!("{prefix}.{k}") };
                flatten(&key, v, out);
            }
        }
        serde_json::Value::String(s) => {
            out.insert(prefix.to_string(), s.clone());
        }
        _ => {}
    }
}

fn main() {
    let root = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let locales_dir = std::env::var("LOCALES_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| root.join("../client/locales"));
    let client_src = root.join("../client/src");
    println!("cargo:rerun-if-changed={}", locales_dir.display());
    println!("cargo:rerun-if-changed=templates");
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed={}", client_src.display());
    println!("cargo:rerun-if-env-changed=LOCALES_DIR");

    let mut server_keys = BTreeSet::new();
    let mut client_keys = BTreeSet::new();
    let mut sources = vec![];
    files(&root.join("templates"), &["html"], &mut sources);
    files(&root.join("src"), &["rs"], &mut sources);
    for f in &sources {
        let src = fs::read_to_string(f).unwrap();
        keys_in(&src, &["t.s(", "t.n(", "t.f("], &mut server_keys);
    }
    let mut client = vec![];
    files(&client_src, &["ts"], &mut client);
    for f in &client {
        let src = fs::read_to_string(f).unwrap();
        keys_in(&src, &["t("], &mut client_keys);
    }

    let mut langs: Vec<(String, BTreeMap<String, String>)> = vec![];
    let mut paths: Vec<_> = fs::read_dir(&locales_dir)
        .unwrap_or_else(|e| panic!("{}: {e}", locales_dir.display()))
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    paths.sort();
    for p in paths {
        let lang = p.file_stem().unwrap().to_string_lossy().into_owned();
        let v: serde_json::Value = serde_json::from_str(&fs::read_to_string(&p).unwrap())
            .unwrap_or_else(|e| panic!("{}: {e}", p.display()));
        let mut flat = BTreeMap::new();
        flatten("", &v, &mut flat);
        langs.push((lang, flat));
    }
    let en = langs
        .iter()
        .find(|(l, _)| l == "en")
        .map(|(_, m)| m.clone())
        .expect("en.json");

    let is_plural = |k: &str| en.contains_key(&format!("{k}_other"));
    let mut all: BTreeSet<String> = BTreeSet::new();
    for k in server_keys.iter().chain(client_keys.iter()) {
        if is_plural(k) {
            for s in PLURAL_SUFFIXES {
                let pk = format!("{k}{s}");
                if langs.iter().any(|(_, m)| m.contains_key(&pk)) {
                    all.insert(pk);
                }
            }
        }
        if en.contains_key(k) {
            all.insert(k.clone());
        } else if !is_plural(k) {
            panic!("i18n key {k} is not in en.json");
        }
    }
    let keys: Vec<&String> = all.iter().collect();
    let index = |k: &str| keys.iter().position(|x| x.as_str() == k);

    let mut out = String::new();
    writeln!(out, "pub static KEYS: &[&str] = &{:?};", keys).unwrap();
    let client_idx: Vec<usize> = client_keys
        .iter()
        .flat_map(|k| {
            let mut v: Vec<usize> = PLURAL_SUFFIXES
                .iter()
                .filter_map(|s| index(&format!("{k}{s}")))
                .collect();
            v.extend(index(k));
            v
        })
        .collect();
    writeln!(out, "pub static CLIENT_KEYS: &[usize] = &{:?};", client_idx).unwrap();
    writeln!(out, "pub static LANGS: &[(&str, &[&str])] = &[").unwrap();
    for (lang, map) in &langs {
        let values: Vec<&str> = keys
            .iter()
            .map(|k| {
                map.get(k.as_str())
                    .filter(|s| !s.is_empty())
                    .or_else(|| en.get(k.as_str()))
                    .map_or("", String::as_str)
            })
            .collect();
        writeln!(out, "    ({lang:?}, &{values:?}),").unwrap();
    }
    writeln!(out, "];").unwrap();
    fs::write(PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("i18n.rs"), out).unwrap();
}

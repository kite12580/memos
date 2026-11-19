//! The search syntax shared by the search box and saved views:
//! `#work -#done is:pinned has:task after:2026-01 "exact words" plain`.
//! Every term must match; `-` negates one. Anything that is not a known
//! filter is searched as text, so parsing never fails.

use jiff::civil::Date;
use jiff::tz::TimeZone;
use rusqlite::types::Value;

#[derive(Debug, Clone, PartialEq)]
pub enum Atom {
    Tag(String),
    Pinned,
    Has(Has),
    Before(String),
    After(String),
    On(String),
    Text(String),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Has {
    Task,
    Todo,
    Link,
    Code,
    Image,
    Media,
    Attachment,
    Tag,
    Comment,
    Ref,
    Reaction,
}

impl Has {
    fn parse(s: &str) -> Option<Has> {
        Some(match s {
            "task" | "tasks" => Has::Task,
            "todo" => Has::Todo,
            "link" | "links" => Has::Link,
            "code" => Has::Code,
            "image" | "images" => Has::Image,
            "media" => Has::Media,
            "attachment" | "attachments" | "file" => Has::Attachment,
            "tag" | "tags" => Has::Tag,
            "comment" | "comments" => Has::Comment,
            "ref" | "link-memo" => Has::Ref,
            "reaction" | "reactions" => Has::Reaction,
            _ => return None,
        })
    }

    pub fn name(self) -> &'static str {
        match self {
            Has::Task => "task",
            Has::Todo => "todo",
            Has::Link => "link",
            Has::Code => "code",
            Has::Image => "image",
            Has::Media => "media",
            Has::Attachment => "attachment",
            Has::Tag => "tag",
            Has::Comment => "comment",
            Has::Ref => "ref",
            Has::Reaction => "reaction",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Term {
    pub neg: bool,
    pub atom: Atom,
}

impl Term {
    /// The term as the user would type it.
    pub fn source(&self) -> String {
        let body = match &self.atom {
            Atom::Tag(t) => format!("#{t}"),
            Atom::Pinned => "is:pinned".into(),
            Atom::Has(h) => format!("has:{}", h.name()),
            Atom::Before(d) => format!("before:{d}"),
            Atom::After(d) => format!("after:{d}"),
            Atom::On(d) => format!("on:{d}"),
            Atom::Text(t) if t.chars().any(char::is_whitespace) || t.starts_with('-') => {
                format!("\"{t}\"")
            }
            Atom::Text(t) => t.clone(),
        };
        if self.neg { format!("-{body}") } else { body }
    }
}

fn is_date(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    let digits = |p: &str, n: usize| p.len() == n && p.bytes().all(|b| b.is_ascii_digit());
    match parts.as_slice() {
        [y] => digits(y, 4),
        [y, m] => digits(y, 4) && digits(m, 2),
        [y, m, d] => digits(y, 4) && digits(m, 2) && digits(d, 2),
        _ => false,
    }
}

fn atom(word: &str) -> Atom {
    if let Some(tag) = word.strip_prefix('#') {
        let tag = tag.trim_end_matches('/');
        if !tag.is_empty() {
            return Atom::Tag(tag.to_string());
        }
    }
    if let Some((key, value)) = word.split_once(':') {
        let value_lc = value.to_ascii_lowercase();
        match key.to_ascii_lowercase().as_str() {
            "is" if value_lc == "pinned" => return Atom::Pinned,
            "has" => {
                if let Some(h) = Has::parse(&value_lc) {
                    return Atom::Has(h);
                }
            }
            "before" if is_date(value) => return Atom::Before(value.to_string()),
            "after" if is_date(value) => return Atom::After(value.to_string()),
            "on" if is_date(value) => return Atom::On(value.to_string()),
            _ => {}
        }
    }
    Atom::Text(word.to_string())
}

pub fn parse(q: &str) -> Vec<Term> {
    let mut terms = vec![];
    let mut chars = q.chars().peekable();
    loop {
        while chars.next_if(|c| c.is_whitespace()).is_some() {}
        let Some(&first) = chars.peek() else {
            break;
        };
        let mut neg = false;
        if first == '-' {
            chars.next();
            neg = true;
        }
        if chars.peek() == Some(&'"') {
            chars.next();
            let phrase: String = chars.by_ref().take_while(|&c| c != '"').collect();
            let phrase = phrase.trim();
            if !phrase.is_empty() {
                terms.push(Term {
                    neg,
                    atom: Atom::Text(phrase.to_string()),
                });
            }
            continue;
        }
        let mut word = String::new();
        while let Some(c) = chars.next_if(|c| !c.is_whitespace()) {
            word.push(c);
        }
        if word.is_empty() {
            if neg {
                terms.push(Term {
                    neg: false,
                    atom: Atom::Text("-".into()),
                });
            }
            continue;
        }
        terms.push(Term {
            neg,
            atom: atom(&word),
        });
    }
    terms
}

/// Joins terms back into a query string.
pub fn format(terms: &[Term]) -> String {
    terms.iter().map(Term::source).collect::<Vec<_>>().join(" ")
}

/// The first and last-plus-one second of a `YYYY[-MM[-DD]]` period in `tz`.
pub fn period(value: &str, tz: &TimeZone) -> Option<(i64, i64)> {
    let parts: Vec<i32> = value.split('-').map(|p| p.parse().ok()).collect::<Option<_>>()?;
    let (start, end) = match parts.as_slice() {
        [y] => {
            let s = Date::new(*y as i16, 1, 1).ok()?;
            (s, s.checked_add(jiff::Span::new().years(1)).ok()?)
        }
        [y, m] => {
            let s = Date::new(*y as i16, *m as i8, 1).ok()?;
            (s, s.checked_add(jiff::Span::new().months(1)).ok()?)
        }
        [y, m, d] => {
            let s = Date::new(*y as i16, *m as i8, *d as i8).ok()?;
            (s, s.tomorrow().ok()?)
        }
        _ => return None,
    };
    let secs = |d: Date| d.to_zoned_datetime(tz.clone()).ok().map(|z| z.timestamp().as_second());
    Some((secs(start)?, secs(end)?))
}

/// FTS5 needs three characters for its trigram index; shorter text is
/// matched by scanning.
fn text_condition(text: &str, params: &mut Vec<Value>) -> String {
    if text.chars().count() >= 3 {
        params.push(Value::Text(format!("\"{}\"", text.replace('"', "\"\""))));
        "m.id IN (SELECT rowid FROM memo_fts WHERE memo_fts MATCH ?)".into()
    } else {
        params.push(Value::Text(text.to_lowercase()));
        "instr(lower(m.content), ?) > 0".into()
    }
}

/// `tag` and every tag nested under it.
pub fn tag_condition(tag: &str, params: &mut Vec<Value>) -> String {
    params.push(Value::Text(tag.to_string()));
    params.push(Value::Text(format!("{tag}/")));
    params.push(Value::Text(format!("{tag}0")));
    "EXISTS (SELECT 1 FROM memo_tag t WHERE t.memo_id = m.id AND (t.tag = ? OR (t.tag >= ? AND t.tag < ?)))"
        .into()
}

fn has_condition(h: Has) -> &'static str {
    match h {
        Has::Task => "m.has_task = 1",
        Has::Todo => "m.has_todo = 1",
        Has::Link => "m.has_link = 1",
        Has::Code => "m.has_code = 1",
        Has::Image => {
            "(m.has_image = 1 OR EXISTS (SELECT 1 FROM attachment a WHERE a.memo_id = m.id AND a.kind = 'image'))"
        }
        Has::Media => {
            "EXISTS (SELECT 1 FROM attachment a WHERE a.memo_id = m.id AND a.kind IN ('image', 'video', 'audio'))"
        }
        Has::Attachment => "EXISTS (SELECT 1 FROM attachment a WHERE a.memo_id = m.id)",
        Has::Tag => "EXISTS (SELECT 1 FROM memo_tag t WHERE t.memo_id = m.id)",
        Has::Comment => "m.comment_count > 0",
        Has::Ref => {
            "(EXISTS (SELECT 1 FROM memo_relation r WHERE r.memo_id = m.id) OR EXISTS (SELECT 1 FROM memo_relation r WHERE r.related_id = m.id))"
        }
        Has::Reaction => "EXISTS (SELECT 1 FROM reaction x WHERE x.memo_id = m.id)",
    }
}

/// SQL conditions over memo alias `m`, joined with AND, and their parameters.
/// `ts` is the column dates compare against.
pub fn to_sql(terms: &[Term], tz: &TimeZone, ts: &str) -> (Vec<String>, Vec<Value>) {
    let mut conds = vec![];
    let mut params = vec![];
    for term in terms {
        let cond = match &term.atom {
            Atom::Tag(t) => tag_condition(t, &mut params),
            Atom::Pinned => "m.pinned = 1".into(),
            Atom::Has(h) => has_condition(*h).into(),
            Atom::Before(d) | Atom::After(d) | Atom::On(d) => {
                let Some((start, end)) = period(d, tz) else {
                    continue;
                };
                match &term.atom {
                    Atom::Before(_) => {
                        params.push(Value::Integer(start));
                        format!("m.{ts} < ?")
                    }
                    Atom::After(_) => {
                        params.push(Value::Integer(end));
                        format!("m.{ts} >= ?")
                    }
                    _ => {
                        params.push(Value::Integer(start));
                        params.push(Value::Integer(end));
                        format!("(m.{ts} >= ? AND m.{ts} < ?)")
                    }
                }
            }
            Atom::Text(t) => text_condition(t, &mut params),
        };
        conds.push(if term.neg {
            format!("NOT {cond}")
        } else {
            cond
        });
    }
    (conds, params)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(neg: bool, atom: Atom) -> Term {
        Term { neg, atom }
    }

    #[test]
    fn parses_terms() {
        assert_eq!(
            parse(r#"#work -#done is:pinned has:Task after:2026-01 "exact  words" plain -x"#),
            vec![
                t(false, Atom::Tag("work".into())),
                t(true, Atom::Tag("done".into())),
                t(false, Atom::Pinned),
                t(false, Atom::Has(Has::Task)),
                t(false, Atom::After("2026-01".into())),
                t(false, Atom::Text("exact  words".into())),
                t(false, Atom::Text("plain".into())),
                t(true, Atom::Text("x".into())),
            ]
        );
    }

    #[test]
    fn unknown_input_is_text() {
        assert_eq!(
            parse("http://x.com has:nothing before:soon # -"),
            vec![
                t(false, Atom::Text("http://x.com".into())),
                t(false, Atom::Text("has:nothing".into())),
                t(false, Atom::Text("before:soon".into())),
                t(false, Atom::Text("#".into())),
                t(false, Atom::Text("-".into())),
            ]
        );
        assert_eq!(parse("  "), vec![]);
        assert_eq!(parse(r#""unclosed phrase"#), vec![t(false, Atom::Text("unclosed phrase".into()))]);
    }

    #[test]
    fn round_trips() {
        let q = r#"#a/b -has:code "two words" on:2026-11-19"#;
        assert_eq!(format(&parse(q)), q);
    }

    #[test]
    fn periods() {
        let utc = TimeZone::UTC;
        assert_eq!(period("1970", &utc), Some((0, 365 * 86400)));
        assert_eq!(period("1970-02", &utc), Some((31 * 86400, 59 * 86400)));
        assert_eq!(period("1970-01-02", &utc), Some((86400, 2 * 86400)));
        assert_eq!(period("1970-13", &utc), None);
        let tokyo = TimeZone::get("Asia/Tokyo").unwrap();
        assert_eq!(period("1970-01-02", &tokyo), Some((86400 - 9 * 3600, 2 * 86400 - 9 * 3600)));
    }
}

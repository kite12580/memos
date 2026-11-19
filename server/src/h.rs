//! Markup helpers the templates call for the pieces they repeat.

use std::fmt::{self, Write};
use std::sync::OnceLock;

static SPRITE: OnceLock<String> = OnceLock::new();

/// Where icons come from: the sprite's URL, set once at startup.
pub fn set_sprite(url: String) {
    let _ = SPRITE.set(url);
}

fn sprite() -> &'static str {
    SPRITE.get().map_or("", String::as_str)
}

/// Markup that is already escaped.
pub struct Html(pub String);

impl fmt::Display for Html {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl askama::filters::HtmlSafe for Html {}

pub fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

/// A Lucide icon from the page's sprite.
pub fn icon(name: &str, class: &str) -> Html {
    let mut s = String::with_capacity(220);
    let _ = write!(
        s,
        r##"<svg class="lucide lucide-{name}{}{class}" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="{}#i-{name}"/></svg>"##,
        if class.is_empty() { "" } else { " " },
        sprite()
    );
    Html(s)
}

/// The account avatar, which has no picture in a single-user app.
pub fn avatar(size: &str) -> Html {
    Html(format!(
        r##"<div class="flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-[oklch(0.82_0.09_var(--avatar-hue))] text-[oklch(0.5_0.1_var(--avatar-hue))] [[data-theme=dark]_&amp;]:bg-[oklch(0.42_0.09_var(--avatar-hue))] [[data-theme=dark]_&amp;]:text-[oklch(0.85_0.06_var(--avatar-hue))] {size}" aria-hidden="true" style="--avatar-hue: 330deg;"><svg class="lucide lucide-user-round size-full translate-y-[12.5%] [&amp;_circle]:-translate-y-px [&amp;_path]:origin-center [&amp;_path]:scale-x-110" width="24" height="24" fill="currentColor" stroke="currentColor" stroke-width="0" aria-hidden="true"><use href="{}#i-user-round"/></svg></div>"##,
        sprite()
    ))
}

/// The memos mark at `width`×`height`.
pub fn mark(width: u32, height: u32) -> Html {
    Html(format!(
        r##"<svg viewBox="112 32 288 448" width="{width}" height="{height}" fill="currentColor" aria-hidden="true" focusable="false" class="memos-mark shrink-0 text-mu-primary"><use href="{}#memos-mark"/></svg>"##,
        sprite()
    ))
}

/// The 20px slot sidebar rows put their icon in.
pub fn row_icon(name: &str) -> Html {
    Html(format!(
        r##"<span class="flex size-5 shrink-0 items-center justify-center" aria-hidden="true">{}</span>"##,
        icon(name, "mu-icon me-auto shrink-0 group-data-checked:text-mu-primary")
    ))
}

pub fn human_size(bytes: i64) -> String {
    const UNITS: [&str; 4] = ["KB", "MB", "GB", "TB"];
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let mut v = bytes as f64 / 1024.0;
    let mut unit = 0;
    while v >= 1024.0 && unit < UNITS.len() - 1 {
        v /= 1024.0;
        unit += 1;
    }
    if v < 10.0 {
        format!("{v:.1} {}", UNITS[unit])
    } else {
        format!("{v:.0} {}", UNITS[unit])
    }
}

/// `2026-11-19T18:29:46.000Z`, as `<relative-time>` and `<time>` take it.
pub fn iso(ts: i64) -> String {
    jiff::Timestamp::from_second(ts)
        .map(|t| t.strftime("%Y-%m-%dT%H:%M:%S.000Z").to_string())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes() {
        assert_eq!(human_size(10), "10 B");
        assert_eq!(human_size(1536), "1.5 KB");
        assert_eq!(human_size(5 * 1024 * 1024), "5.0 MB");
        assert_eq!(human_size(50 * 1024 * 1024), "50 MB");
    }

    #[test]
    fn times() {
        assert_eq!(iso(1_763_576_986), "2025-11-19T18:29:46.000Z");
    }
}

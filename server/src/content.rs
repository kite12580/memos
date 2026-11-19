//! A memo's HTML: made by the browser with the memos editor when it is
//! saved, or by `fallback_html` when it comes in through the JSON API. Facts
//! the lists filter on are read back out of the HTML, so both sources agree.

use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use std::collections::HashSet;
use std::sync::OnceLock;

const TAGS: &[&str] = &[
    "a", "b", "blockquote", "br", "button", "circle", "code", "dd", "del", "details", "div", "dl",
    "dt", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "iframe", "img", "input", "ins",
    "kbd", "li", "line", "mark", "ol", "p", "path", "polyline", "pre", "q", "rect", "rp", "rt",
    "ruby", "s", "samp", "section", "span", "strike", "strong", "sub", "summary", "sup", "svg",
    "table", "tbody", "td", "tfoot", "th", "thead", "tr", "tt", "ul", "var",
];

const ATTRIBUTES: &[&str] = &[
    "align", "allow", "allowfullscreen", "alt", "checked", "cite", "class", "colspan", "contenteditable",
    "cx", "cy", "d", "datetime", "dir", "disabled", "fill", "focusable", "height", "href", "id",
    "lang", "loading", "open", "placeholder", "points", "r", "referrerpolicy", "role", "rowspan",
    "rx", "ry", "spellcheck", "src", "start", "stroke", "stroke-linecap", "stroke-linejoin",
    "stroke-width", "style", "tabindex", "title", "translate", "type", "value", "viewBox", "width",
    "x", "x1", "x2", "y", "y1", "y2",
];

const TRUSTED_IFRAME_PREFIXES: &[&str] = &[
    "https://www.youtube.com/embed/",
    "https://www.youtube-nocookie.com/embed/",
    "https://player.vimeo.com/video/",
    "https://player.bilibili.com/player.html",
    "https://open.spotify.com/embed/",
    "https://w.soundcloud.com/player",
    "https://www.loom.com/embed/",
    "https://www.google.com/maps/embed",
    "https://app.diagrams.net/",
    "https://diagrams.net/",
    "https://www.draw.io/",
    "https://draw.io/",
];

fn sanitizer() -> &'static ammonia::Builder<'static> {
    static B: OnceLock<ammonia::Builder<'static>> = OnceLock::new();
    B.get_or_init(|| {
        let mut b = ammonia::Builder::default();
        b.tags(TAGS.iter().copied().collect::<HashSet<_>>())
            .generic_attributes(ATTRIBUTES.iter().copied().collect::<HashSet<_>>())
            .generic_attribute_prefixes(["data-", "aria-"].into_iter().collect::<HashSet<_>>())
            .add_url_schemes(["obsidian", "logseq", "zotero", "slack", "notion", "things", "bear"])
            .url_relative(ammonia::UrlRelative::PassThrough)
            .link_rel(None)
            .strip_comments(true)
            .attribute_filter(|element, attribute, value| {
                if element == "iframe" && attribute == "src" {
                    return TRUSTED_IFRAME_PREFIXES
                        .iter()
                        .any(|p| value.starts_with(p))
                        .then_some(value.into());
                }
                Some(value.into())
            });
        b
    })
}

pub fn sanitize(html: &str) -> String {
    sanitizer().clean(html).to_string()
}

#[derive(Debug, Default, PartialEq)]
pub struct Derived {
    pub tags: Vec<String>,
    pub has_task: bool,
    pub has_todo: bool,
    pub has_link: bool,
    pub has_code: bool,
    pub has_image: bool,
}

fn unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

/// Start tags of `name` in `html`, as their attribute text.
fn start_tags<'a>(html: &'a str, name: &'a str) -> impl Iterator<Item = &'a str> + 'a {
    let open = format!("<{name}");
    let mut rest = html;
    std::iter::from_fn(move || {
        loop {
            let at = rest.find(&open)?;
            let after = &rest[at + open.len()..];
            let end = after.find('>')?;
            rest = &after[end..];
            if after.starts_with([' ', '>', '/']) {
                return Some(&after[..end]);
            }
        }
    })
}

fn attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let key = format!(" {name}=\"");
    let at = tag.find(&key)? + key.len();
    let len = tag[at..].find('"')?;
    Some(&tag[at..at + len])
}

fn has_class(tag: &str, class: &str) -> bool {
    attr(tag, "class").is_some_and(|c| c.split(' ').any(|x| x == class))
}

fn is_checkbox(tag: &str) -> bool {
    has_class(tag, "mbe-checkbox")
}

pub fn derive(html: &str) -> Derived {
    let mut d = Derived::default();
    let mut seen = HashSet::new();
    for tag in start_tags(html, "span") {
        if let Some(t) = attr(tag, "data-tag") {
            let t = unescape(t);
            if seen.insert(t.clone()) {
                d.tags.push(t);
            }
        }
    }
    for tag in start_tags(html, "input").filter(|t| is_checkbox(t)) {
        d.has_task = true;
        if !tag.contains(" checked") {
            d.has_todo = true;
        }
    }
    d.has_link = start_tags(html, "a").any(|t| has_class(t, "mbe-link"));
    d.has_code = start_tags(html, "div").any(|t| has_class(t, "mbe-code"));
    d.has_image = start_tags(html, "img").next().is_some();
    d
}

fn strip_tags(html: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    unescape(out.trim())
}

/// The h1–h4 headings with ids, as `(level, id, text)`, for the memo's outline.
pub fn headings(html: &str) -> Vec<(u8, String, String)> {
    let mut out = vec![];
    for level in 1..=4u8 {
        let open = format!("<h{level}");
        let close = format!("</h{level}>");
        let mut rest = html;
        while let Some(at) = rest.find(&open) {
            let after = &rest[at..];
            let Some(tag_end) = after.find('>') else { break };
            let Some(end) = after.find(&close) else { break };
            if let Some(id) = attr(&after[..tag_end], "id") {
                let text = strip_tags(&after[tag_end + 1..end]);
                if !text.is_empty() {
                    out.push((html.len() - rest.len() + at, level, id.to_string(), text));
                }
            }
            rest = &after[end..];
        }
    }
    out.sort_by_key(|h| h.0);
    out.into_iter().map(|(_, l, id, t)| (l, id, t)).collect()
}

/// Plain text of the start of the memo, for link pickers and references.
pub fn snippet(markdown: &str) -> String {
    const MAX: usize = 160;
    let mut out = String::new();
    for ev in Parser::new_ext(markdown, Options::ENABLE_TASKLISTS | Options::ENABLE_STRIKETHROUGH) {
        match ev {
            Event::Text(t) | Event::Code(t) => out.push_str(&t),
            Event::SoftBreak | Event::HardBreak | Event::End(_) if !out.ends_with(' ') => {
                out.push(' ')
            }
            _ => {}
        }
        if out.chars().count() > MAX {
            break;
        }
    }
    let out = out.split_whitespace().collect::<Vec<_>>().join(" ");
    match out.char_indices().nth(MAX) {
        Some((i, _)) => format!("{}…", &out[..i]),
        None => out,
    }
}

/// Where a `#tag` may start and what it may hold, close to the editor's
/// `scanTags`: letters, digits, `_-/` and non-ASCII symbols, after a space
/// or the start of the text, not ending in `/`.
fn scan_tags(text: &str) -> Vec<(usize, usize)> {
    let mut out = vec![];
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'#' {
            let before_ok = i == 0
                || text[..i]
                    .chars()
                    .next_back()
                    .is_some_and(|c| c.is_whitespace() || "([{,;".contains(c));
            let body: usize = text[i + 1..]
                .char_indices()
                .find(|(_, c)| !(c.is_alphanumeric() || "_-/&+".contains(*c) || (!c.is_ascii() && !c.is_whitespace() && !"，。！？、；：".contains(*c))))
                .map_or(text.len() - i - 1, |(n, _)| n);
            let mut end = i + 1 + body;
            while end > i + 1 && text[..end].ends_with('/') {
                end -= 1;
            }
            if before_ok && end > i + 1 && !text[i + 1..end].chars().all(|c| c.is_ascii_digit()) {
                out.push((i, end));
                i = end;
                continue;
            }
        }
        i += text[i..].chars().next().map_or(1, char::len_utf8);
    }
    out
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn push_text_with_tags(out: &mut String, text: &str) {
    let mut last = 0;
    for (from, to) in scan_tags(text) {
        out.push_str(&escape(&text[last..from]));
        let tag = &text[from + 1..to];
        out.push_str(&format!(
            "<span data-tag=\"{}\" class=\"mbe-deco mbe-tag memo-tag\">{}</span>",
            escape(tag),
            escape(&text[from..to])
        ));
        last = to;
    }
    out.push_str(&escape(&text[last..]));
}

/// Plain HTML for a memo no browser has rendered yet. It carries the same
/// markers `derive` reads; a browser that shows the memo replaces it.
pub fn fallback_html(markdown: &str) -> String {
    let opts = Options::ENABLE_TASKLISTS
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TABLES
        | Options::ENABLE_FOOTNOTES;
    let mut out = String::new();
    let mut code_depth = 0;
    let mut link_depth = 0;
    let mut image_depth = 0;
    for ev in Parser::new_ext(markdown, opts) {
        match ev {
            Event::Start(tag) => match tag {
                Tag::Paragraph => out.push_str("<p dir=\"auto\" class=\"mbe-block mbe-paragraph\">"),
                Tag::Heading { level, .. } => out.push_str(&format!("<{level} class=\"mbe-block mbe-heading\">")),
                Tag::BlockQuote(_) => out.push_str("<blockquote class=\"mbe-block mbe-quote\">"),
                Tag::CodeBlock(kind) => {
                    code_depth += 1;
                    let lang = match kind {
                        pulldown_cmark::CodeBlockKind::Fenced(l) => l.to_string(),
                        pulldown_cmark::CodeBlockKind::Indented => String::new(),
                    };
                    out.push_str(&format!(
                        "<div data-language=\"{}\" class=\"mbe-block mbe-code\"><pre><code>",
                        escape(&lang)
                    ));
                }
                Tag::List(Some(start)) => out.push_str(&format!("<ol start=\"{start}\">")),
                Tag::List(None) => out.push_str("<ul>"),
                Tag::Item => out.push_str("<li>"),
                Tag::Emphasis => out.push_str("<em>"),
                Tag::Strong => out.push_str("<strong>"),
                Tag::Strikethrough => out.push_str("<del>"),
                Tag::Link { dest_url, .. } => {
                    link_depth += 1;
                    out.push_str(&format!("<a href=\"{}\" class=\"mbe-link\">", escape(&dest_url)));
                }
                Tag::Image { dest_url, title, .. } => {
                    out.push_str(&format!("<img src=\"{}\" alt=\"{}\" loading=\"lazy\">", escape(&dest_url), escape(&title)));
                    image_depth += 1;
                }
                Tag::Table(_) => out.push_str("<table>"),
                Tag::TableHead => out.push_str("<thead><tr>"),
                Tag::TableRow => out.push_str("<tr>"),
                Tag::TableCell => out.push_str("<td>"),
                Tag::FootnoteDefinition(label) => out.push_str(&format!("<div class=\"mbe-footnote\"><sup>{}</sup> ", escape(&label))),
                _ => {}
            },
            Event::End(tag) => match tag {
                TagEnd::Paragraph => out.push_str("</p>"),
                TagEnd::Heading(level) => out.push_str(&format!("</{level}>")),
                TagEnd::BlockQuote(_) => out.push_str("</blockquote>"),
                TagEnd::CodeBlock => {
                    code_depth -= 1;
                    out.push_str("</code></pre></div>");
                }
                TagEnd::List(true) => out.push_str("</ol>"),
                TagEnd::List(false) => out.push_str("</ul>"),
                TagEnd::Item => out.push_str("</li>"),
                TagEnd::Emphasis => out.push_str("</em>"),
                TagEnd::Strong => out.push_str("</strong>"),
                TagEnd::Strikethrough => out.push_str("</del>"),
                TagEnd::Link => {
                    link_depth -= 1;
                    out.push_str("</a>");
                }
                TagEnd::Image => image_depth -= 1,
                TagEnd::Table => out.push_str("</table>"),
                TagEnd::TableHead => out.push_str("</tr></thead>"),
                TagEnd::TableRow => out.push_str("</tr>"),
                TagEnd::TableCell => out.push_str("</td>"),
                TagEnd::FootnoteDefinition => out.push_str("</div>"),
                _ => {}
            },
            Event::Text(_) if image_depth > 0 => {}
            Event::Text(t) if code_depth == 0 && link_depth == 0 => push_text_with_tags(&mut out, &t),
            Event::Text(t) => out.push_str(&escape(&t)),
            Event::Code(t) => out.push_str(&format!("<code>{}</code>", escape(&t))),
            Event::SoftBreak | Event::HardBreak => out.push_str("<br>"),
            Event::Rule => out.push_str("<div class=\"mbe-block mbe-divider\"><hr></div>"),
            Event::TaskListMarker(checked) => out.push_str(if checked {
                "<input class=\"mbe-checkbox\" type=\"checkbox\" checked=\"\"> "
            } else {
                "<input class=\"mbe-checkbox\" type=\"checkbox\"> "
            }),
            Event::FootnoteReference(label) => out.push_str(&format!("<sup>{}</sup>", escape(&label))),
            Event::Html(h) | Event::InlineHtml(h) => out.push_str(&h),
            _ => {}
        }
    }
    sanitize(&out)
}

/// The Markdown with its `index`th task (in document order) ticked or
/// unticked, if that task's text starts with `label`.
pub fn toggle_task_markdown(markdown: &str, index: usize, label: &str) -> Option<(String, bool)> {
    let opts = Options::ENABLE_TASKLISTS
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TABLES
        | Options::ENABLE_FOOTNOTES;
    let mut events = Parser::new_ext(markdown, opts).into_offset_iter();
    let mut n = 0;
    while let Some((ev, range)) = events.next() {
        let Event::TaskListMarker(checked) = ev else {
            continue;
        };
        if n < index {
            n += 1;
            continue;
        }
        let mut text = String::new();
        for (ev, _) in events.by_ref() {
            match ev {
                Event::Text(t) | Event::Code(t) => text.push_str(&t),
                Event::SoftBreak | Event::HardBreak => text.push(' '),
                Event::End(TagEnd::Item) | Event::Start(Tag::List(_)) => break,
                _ => {}
            }
        }
        let norm = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
        if !norm(&text).starts_with(&norm(label)) {
            return None;
        }
        let marker = &markdown[range.clone()];
        let pos = range.start + marker.find(['x', 'X', ' '])?;
        let mut out = markdown.to_string();
        out.replace_range(pos..pos + 1, if checked { " " } else { "x" });
        return Some((out, !checked));
    }
    None
}

/// The Markdown with every task set to `checked`, and the indexes of the
/// tasks that changed.
pub fn set_all_tasks_markdown(markdown: &str, checked: bool) -> (String, Vec<usize>) {
    let opts = Options::ENABLE_TASKLISTS
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TABLES
        | Options::ENABLE_FOOTNOTES;
    let mut out = markdown.to_string();
    let mut changed = vec![];
    let markers = Parser::new_ext(markdown, opts)
        .into_offset_iter()
        .filter_map(|(ev, range)| match ev {
            Event::TaskListMarker(c) => Some((c, range)),
            _ => None,
        });
    for (i, (was, range)) in markers.enumerate() {
        if was == checked {
            continue;
        }
        if let Some(off) = markdown[range.clone()].find(['x', 'X', ' ']) {
            let pos = range.start + off;
            out.replace_range(pos..pos + 1, if checked { "x" } else { " " });
            changed.push(i);
        }
    }
    (out, changed)
}

/// The HTML with its `index`th task checkbox set to `checked`, and the
/// editor's `mbe-checked` class on that task's block to match.
pub fn set_task_html(html: &str, index: usize, checked: bool) -> Option<String> {
    let mut seen = 0;
    let mut search = 0;
    let input_at = loop {
        let at = search + html[search..].find("<input")?;
        let end = at + html[at..].find('>')?;
        if is_checkbox(&html[at + 6..end]) {
            if seen == index {
                break at;
            }
            seen += 1;
        }
        search = end;
    };
    let input_end = input_at + html[input_at..].find('>')?;
    let input = &html[input_at..input_end];
    let new_input = if checked {
        if input.contains(" checked") {
            input.to_string()
        } else {
            format!("{input} checked=\"\"")
        }
    } else {
        input.replace(" checked=\"\"", "").replace(" checked", "")
    };
    let mut out = String::with_capacity(html.len() + 16);
    let before = &html[..input_at];
    match before.rfind("<div").filter(|&b| before[b..].contains("data-list-type=\"task\"")) {
        Some(block_at) => {
            let block_end = block_at + before[block_at..].find('>')?;
            let block = &before[block_at..block_end];
            let new_block = match attr(block, "class") {
                Some(class) => {
                    let mut classes: Vec<&str> = class.split(' ').filter(|c| *c != "mbe-checked").collect();
                    if checked {
                        let at = classes.iter().position(|c| *c == "mbe-list-item").map_or(classes.len(), |p| p + 1);
                        classes.insert(at, "mbe-checked");
                    }
                    block.replacen(&format!("class=\"{class}\""), &format!("class=\"{}\"", classes.join(" ")), 1)
                }
                None => block.to_string(),
            };
            out.push_str(&before[..block_at]);
            out.push_str(&new_block);
            out.push_str(&before[block_end..]);
        }
        None => out.push_str(before),
    }
    out.push_str(&new_input);
    out.push_str(&html[input_end..]);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const EDITOR_TASKS: &str = r#"<div dir="auto" data-list-type="task" data-indent="0" class="mbe-block mbe-list-item mbe-lazy"><span class="mbe-marker" contenteditable="false"><input class="mbe-checkbox" type="checkbox" tabindex="0" aria-label="one"></span><div class="mbe-content" data-content="">one</div></div><div dir="auto" data-list-type="task" data-indent="0" class="mbe-block mbe-list-item mbe-checked mbe-lazy"><span class="mbe-marker" contenteditable="false"><input class="mbe-checkbox" type="checkbox" tabindex="0" aria-label="two" checked=""></span><div class="mbe-content" data-content="">two <span data-tag="a&amp;b" class="mbe-deco mbe-tag">#a&amp;b</span></div></div>"#;

    #[test]
    fn derives_from_editor_html() {
        let d = derive(EDITOR_TASKS);
        assert_eq!(d.tags, vec!["a&b"]);
        assert!(d.has_task && d.has_todo && !d.has_link && !d.has_code && !d.has_image);
    }

    #[test]
    fn sanitizes_without_changing_editor_markup() {
        assert_eq!(sanitize(EDITOR_TASKS), EDITOR_TASKS);
        assert_eq!(sanitize("<p onclick=\"x()\">a<script>alert(1)</script></p>"), "<p>a</p>");
        assert_eq!(
            sanitize("<a href=\"javascript:alert(1)\">x</a><iframe src=\"https://evil.example/\"></iframe>"),
            "<a>x</a><iframe></iframe>"
        );
    }

    #[test]
    fn toggles_tasks() {
        let md = "- [ ] one\n- [x] two #tag\n\n```\n- [ ] not a task\n```\n";
        let (md2, checked) = toggle_task_markdown(md, 1, "two").unwrap();
        assert!(!checked);
        assert_eq!(md2, md.replace("[x] two", "[ ] two"));
        assert_eq!(toggle_task_markdown(md, 0, "two"), None);
        assert_eq!(toggle_task_markdown(md, 2, ""), None);
        let (md3, checked) = toggle_task_markdown(md, 0, "one").unwrap();
        assert!(checked);
        assert!(md3.starts_with("- [x] one"));

        let html = set_task_html(EDITOR_TASKS, 0, true).unwrap();
        assert!(html.contains("class=\"mbe-block mbe-list-item mbe-checked mbe-lazy\"><span class=\"mbe-marker\" contenteditable=\"false\"><input class=\"mbe-checkbox\" type=\"checkbox\" tabindex=\"0\" aria-label=\"one\" checked=\"\">"));
        let html = set_task_html(&html, 1, false).unwrap();
        assert!(derive(&html).has_todo);
        assert!(html.contains("<div dir=\"auto\" data-list-type=\"task\" data-indent=\"0\" class=\"mbe-block mbe-list-item mbe-lazy\"><span class=\"mbe-marker\" contenteditable=\"false\"><input class=\"mbe-checkbox\" type=\"checkbox\" tabindex=\"0\" aria-label=\"two\">"));
    }

    #[test]
    fn sets_all_tasks() {
        let (md, changed) = set_all_tasks_markdown("- [ ] a\n- [x] b\n- [ ] c\n", true);
        assert_eq!(md, "- [x] a\n- [x] b\n- [x] c\n");
        assert_eq!(changed, vec![0, 2]);
        let html = changed.iter().try_fold(EDITOR_TASKS.to_string(), |h, &i| set_task_html(&h, i.min(1), true)).unwrap();
        assert!(!derive(&html).has_todo);
    }

    #[test]
    fn fallback_marks_tags_and_tasks() {
        let html = fallback_html("Hi #work/proj and #a/ but not #123 or `#code`\n\n- [ ] do [x](https://x.com)\n");
        let d = derive(&html);
        assert_eq!(d.tags, vec!["work/proj", "a"]);
        assert!(d.has_task && d.has_todo && d.has_link);
        assert!(!html.contains("<script"));
    }

    #[test]
    fn snippets() {
        assert_eq!(snippet("# Title\n\nSome **bold** text\n- item"), "Title Some bold text item");
        assert_eq!(snippet(&"x".repeat(200)).chars().count(), 161);
    }
}

use intl_pluralrules::{PluralCategory, PluralRuleType, PluralRules};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

mod data {
    include!(concat!(env!("OUT_DIR"), "/i18n.rs"));
}

/// Each locale's name in its own language, for the language menu.
const NAMES: &[(&str, &str)] = &[
    ("ar", "العربية"),
    ("az", "Azərbaycan"),
    ("bg", "Български"),
    ("ca", "Català"),
    ("cs", "Čeština"),
    ("da", "Dansk"),
    ("de", "Deutsch"),
    ("el", "Ελληνικά"),
    ("en", "English"),
    ("en-GB", "English (UK)"),
    ("es", "Español"),
    ("et", "Eesti"),
    ("fa", "فارسی"),
    ("fi", "Suomi"),
    ("fr", "Français"),
    ("gl", "Galego"),
    ("he", "עברית"),
    ("hi", "हिन्दी"),
    ("hr", "Hrvatski"),
    ("hu", "Magyar"),
    ("id", "Indonesia"),
    ("it", "Italiano"),
    ("ja", "日本語"),
    ("ka-GE", "ქართული"),
    ("ko", "한국어"),
    ("lt", "Lietuvių"),
    ("lv", "Latviešu"),
    ("mr", "मराठी"),
    ("nb", "Norsk bokmål"),
    ("nl", "Nederlands"),
    ("nn", "Norsk nynorsk"),
    ("pl", "Polski"),
    ("pt-BR", "Português (Brasil)"),
    ("pt-PT", "Português (Portugal)"),
    ("ro", "Română"),
    ("ru", "Русский"),
    ("sk", "Slovenčina"),
    ("sl", "Slovenščina"),
    ("sr", "Српски"),
    ("sv", "Svenska"),
    ("th", "ไทย"),
    ("tr", "Türkçe"),
    ("uk", "Українська"),
    ("vi", "Tiếng Việt"),
    ("zh-Hans", "简体中文"),
    ("zh-Hant", "繁體中文"),
];

pub fn languages() -> impl Iterator<Item = (&'static str, &'static str)> {
    data::LANGS
        .iter()
        .map(|(code, _)| (*code, NAMES.iter().find(|(c, _)| c == code).map_or(*code, |(_, n)| *n)))
}

#[derive(Clone, Copy)]
pub struct T {
    pub lang: &'static str,
    strings: &'static [&'static str],
}

fn index(key: &str) -> Option<usize> {
    data::KEYS.binary_search(&key).ok()
}

fn plural_category(lang: &'static str, n: i64) -> PluralCategory {
    static RULES: OnceLock<Mutex<HashMap<&'static str, Option<PluralRules>>>> = OnceLock::new();
    let mut rules = RULES
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    rules
        .entry(lang)
        .or_insert_with(|| {
            let id: unic_langid::LanguageIdentifier = lang.parse().ok()?;
            PluralRules::create(id, PluralRuleType::CARDINAL).ok()
        })
        .as_ref()
        .and_then(|r| r.select(n).ok())
        .unwrap_or(if n == 1 { PluralCategory::ONE } else { PluralCategory::OTHER })
}

fn interpolate(s: &str, args: &[(&str, &str)]) -> String {
    let mut out = s.to_string();
    for (k, v) in args {
        out = out.replace(&format!("{{{{{k}}}}}"), v);
    }
    out
}

impl T {
    pub fn new(lang: &str) -> Option<T> {
        data::LANGS
            .iter()
            .find(|(code, _)| code.eq_ignore_ascii_case(lang))
            .map(|(code, strings)| T { lang: code, strings })
    }

    pub fn english() -> T {
        T::new("en").expect("en locale")
    }

    /// The language from the `lang` cookie, else the best `Accept-Language`
    /// match, else English.
    pub fn pick(cookie: Option<&str>, accept: Option<&str>) -> T {
        if let Some(t) = cookie.and_then(T::new) {
            return t;
        }
        for part in accept.unwrap_or("").split(',') {
            let tag = part.split(';').next().unwrap_or("").trim();
            if tag.is_empty() || tag == "*" {
                continue;
            }
            if let Some(t) = T::new(tag) {
                return t;
            }
            let lower = tag.to_ascii_lowercase();
            let script = if lower.starts_with("zh") {
                if ["tw", "hk", "mo", "hant"].iter().any(|r| lower.contains(r)) { "zh-Hant" } else { "zh-Hans" }
            } else {
                lower.split('-').next().unwrap_or("")
            };
            if let Some(t) = T::new(script) {
                return t;
            }
            if let Some((code, strings)) = data::LANGS
                .iter()
                .find(|(code, _)| code.split('-').next().is_some_and(|c| c.eq_ignore_ascii_case(script)))
            {
                return T { lang: code, strings };
            }
        }
        T::english()
    }

    pub fn is(&self, lang: &str) -> bool {
        self.lang == lang
    }

    pub fn name(&self) -> &'static str {
        NAMES.iter().find(|(c, _)| *c == self.lang).map_or(self.lang, |(_, n)| *n)
    }

    pub fn dir(&self) -> &'static str {
        if matches!(self.lang, "ar" | "fa" | "he") { "rtl" } else { "ltr" }
    }

    /// The string for `key`, or the key itself if it was never compiled in.
    pub fn s(&self, key: &'static str) -> &'static str {
        index(key).map_or(key, |i| self.strings[i])
    }

    /// The string for `key` with `{{name}}` placeholders filled in.
    pub fn f(&self, key: &'static str, args: &[(&str, &str)]) -> String {
        interpolate(self.s(key), args)
    }

    /// The plural form of `key` for `count`, with `{{count}}` filled in.
    pub fn n(&self, key: &'static str, count: impl std::borrow::Borrow<i64>) -> String {
        let count = *count.borrow();
        let suffix = match plural_category(self.lang, count) {
            PluralCategory::ZERO => "_zero",
            PluralCategory::ONE => "_one",
            PluralCategory::TWO => "_two",
            PluralCategory::FEW => "_few",
            PluralCategory::MANY => "_many",
            PluralCategory::OTHER => "_other",
        };
        let s = index(&format!("{key}{suffix}"))
            .or_else(|| index(&format!("{key}_other")))
            .or_else(|| index(key))
            .map_or(key, |i| self.strings[i]);
        interpolate(s, &[("count", &count.to_string())])
    }

    /// The strings the client asks for, as a JSON object.
    pub fn client_json(&self) -> String {
        let mut m = serde_json::Map::new();
        for &i in data::CLIENT_KEYS {
            m.insert(data::KEYS[i].to_string(), self.strings[i].into());
        }
        serde_json::Value::Object(m).to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_languages() {
        assert_eq!(T::pick(Some("de"), Some("fr")).lang, "de");
        assert_eq!(T::pick(None, Some("fr-CA,fr;q=0.9")).lang, "fr");
        assert_eq!(T::pick(None, Some("zh-TW")).lang, "zh-Hant");
        assert_eq!(T::pick(None, Some("zh-CN")).lang, "zh-Hans");
        assert_eq!(T::pick(None, Some("pt")).lang, "pt-BR");
        assert_eq!(T::pick(Some("xx"), None).lang, "en");
    }

    #[test]
    fn translates() {
        let en = T::english();
        assert_eq!(en.s("common.delete"), "Delete");
        assert_eq!(T::new("de").unwrap().s("common.delete"), "Löschen");
        assert_eq!(en.n("memo.comment.view-all-count", 1), "View 1 comment");
        assert_eq!(en.n("memo.comment.view-all-count", 4), "View all 4 comments");
        assert_eq!(en.s("not.compiled.in"), "not.compiled.in");
    }
}

use bytes::Bytes;
use flate2::Compression;
use flate2::write::GzEncoder;
use std::io::Write;

/// Body bytes as they arrive; an `Err` means the transfer broke off.
pub type BodyStream = tokio::sync::mpsc::Receiver<Result<Bytes, ()>>;

pub struct Request {
    pub method: String,
    /// Raw (still percent-encoded) path, without `BASE_PATH`.
    pub path: String,
    pub query: String,
    /// Lowercased names.
    pub headers: Vec<(String, String)>,
    /// `None` when the request had no body or it could not be read.
    pub body: Option<Vec<u8>>,
    /// Set instead of `body` for upload routes.
    pub stream: Option<BodyStream>,
}

impl Request {
    pub fn get(method: &str, path_and_query: &str) -> Request {
        let (path, query) = path_and_query.split_once('?').unwrap_or((path_and_query, ""));
        Request {
            method: method.to_string(),
            path: path.to_string(),
            query: query.to_string(),
            headers: vec![],
            body: None,
            stream: None,
        }
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    /// First occurrence.
    pub fn query(&self, key: &str) -> Option<String> {
        query_pairs(&self.query).find_map(|(k, v)| (k == key).then_some(v))
    }

    pub fn cookie(&self, name: &str) -> Option<String> {
        self.header("cookie")?.split(';').find_map(|c| {
            let (k, v) = c.trim().split_once('=')?;
            (k == name).then(|| decode_component(v))
        })
    }

    /// Fields of an `application/x-www-form-urlencoded` body.
    pub fn form(&self) -> Vec<(String, String)> {
        let body = self.body.as_deref().unwrap_or_default();
        query_pairs(&String::from_utf8_lossy(body)).collect()
    }

    pub fn json(&self) -> Option<serde_json::Value> {
        serde_json::from_slice(self.body.as_deref()?).ok()
    }
}

pub fn form_value<'a>(form: &'a [(String, String)], key: &str) -> Option<&'a str> {
    form.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
}

pub fn query_pairs(query: &str) -> impl Iterator<Item = (String, String)> {
    query.split('&').filter(|p| !p.is_empty()).map(|pair| {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        (decode_component(k), decode_component(v))
    })
}

pub fn decode_component(s: &str) -> String {
    decode_path(&s.replace('+', " "))
}

pub fn decode_path(s: &str) -> String {
    percent_encoding::percent_decode_str(s)
        .decode_utf8_lossy()
        .into_owned()
}

const COMPONENT: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

pub fn encode_component(s: &str) -> String {
    percent_encoding::utf8_percent_encode(s, COMPONENT).to_string()
}

#[derive(Debug)]
pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Bytes,
    /// Sent instead of `body` when set.
    pub stream: Option<BodyStream>,
}

impl Response {
    pub fn new(status: u16) -> Response {
        Response {
            status,
            headers: vec![],
            body: Bytes::new(),
            stream: None,
        }
    }

    pub fn html(body: impl Into<Bytes>) -> Response {
        Response::new(200)
            .with("content-type", "text/html; charset=utf-8")
            .body(body)
    }

    pub fn json(status: u16, v: &serde_json::Value) -> Response {
        Response::new(status)
            .with("content-type", "application/json")
            .body(v.to_string())
    }

    pub fn text(status: u16, s: &str) -> Response {
        Response::new(status)
            .with("content-type", "text/plain; charset=utf-8")
            .body(s.to_string())
    }

    pub fn error(status: u16, msg: &str) -> Response {
        Response::json(status, &serde_json::json!({ "error": msg }))
    }

    pub fn not_found() -> Response {
        Response::text(404, "404 Not Found")
    }

    pub fn internal_error() -> Response {
        Response::text(500, "Internal Server Error")
    }

    pub fn redirect(location: &str) -> Response {
        Response::new(303).with("location", location)
    }

    pub fn body(mut self, body: impl Into<Bytes>) -> Response {
        self.body = body.into();
        self
    }

    pub fn stream(mut self, stream: BodyStream) -> Response {
        self.stream = Some(stream);
        self
    }

    pub fn with(mut self, name: &str, value: &str) -> Response {
        self.set(name, value);
        self
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    pub fn set(&mut self, name: &str, value: &str) {
        match self
            .headers
            .iter_mut()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
        {
            Some(h) => h.1 = value.to_string(),
            None => self.headers.push((name.to_string(), value.to_string())),
        }
    }

    /// Adds another header line with the same name, as `set-cookie` needs.
    pub fn add(&mut self, name: &str, value: &str) {
        self.headers.push((name.to_string(), value.to_string()));
    }

    pub fn remove(&mut self, name: &str) {
        self.headers.retain(|(k, _)| !k.eq_ignore_ascii_case(name));
    }
}

fn accept_q(params: &str) -> f64 {
    for p in params.split(';') {
        if let Some((k, v)) = p.split_once('=')
            && k.trim().eq_ignore_ascii_case("q")
        {
            return v.trim().parse::<f64>().map_or(1.0, |q| q.clamp(0.0, 1.0));
        }
    }
    1.0
}

/// Whether `Accept-Encoding` allows `encoding` (or `*`) with a non-zero weight.
pub fn accepts(header: Option<&str>, encoding: &str) -> bool {
    let Some(header) = header else {
        return false;
    };
    let mut wildcard = None;
    for part in header.split(',') {
        let (ty, params) = part.split_once(';').unwrap_or((part, ""));
        let ty = ty.trim();
        if ty.eq_ignore_ascii_case(encoding) {
            return accept_q(params) > 0.0;
        }
        if ty == "*" {
            wildcard = Some(accept_q(params) > 0.0);
        }
    }
    wildcard.unwrap_or(false)
}

pub const MIN_COMPRESS_BYTES: usize = 1024;
pub const IMMUTABLE_CACHE: &str = "public, max-age=31536000, immutable";

/// Level 1: on the server's weak CPU a fast pass beats a few percent of size.
pub fn gzip_fast(data: &[u8]) -> std::io::Result<Vec<u8>> {
    let mut e = GzEncoder::new(Vec::with_capacity(data.len() / 4), Compression::fast());
    e.write_all(data).and_then(|_| e.finish())
}

// ───── Range requests ─────

#[derive(Debug, PartialEq, Eq)]
pub enum ByteRange {
    Full,
    /// Inclusive.
    Part(u64, u64),
    Unsatisfiable,
}

/// A single `bytes=` range of a `size`-byte body; multiple or malformed
/// ranges are served in full.
pub fn parse_range(header: Option<&str>, size: u64) -> ByteRange {
    let Some(spec) = header.and_then(|h| h.trim().strip_prefix("bytes=")) else {
        return ByteRange::Full;
    };
    let Some((start, end)) = spec.trim().split_once('-') else {
        return ByteRange::Full;
    };
    let number = |s: &str| {
        (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
            .then(|| s.parse::<u64>().unwrap_or(u64::MAX))
    };
    let (start, end) = (start.trim(), end.trim());
    let (first, last) = match (number(start), number(end)) {
        (Some(a), Some(b)) if a <= b => (a, b),
        (Some(a), None) if end.is_empty() => (a, u64::MAX),
        (None, Some(n)) if start.is_empty() => {
            if n == 0 {
                return ByteRange::Unsatisfiable;
            }
            (size.saturating_sub(n), u64::MAX)
        }
        _ => return ByteRange::Full,
    };
    if first >= size {
        return ByteRange::Unsatisfiable;
    }
    ByteRange::Part(first, last.min(size - 1))
}

pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodings() {
        assert!(accepts(Some("gzip, deflate, br"), "gzip"));
        assert!(accepts(Some("gzip, deflate, br"), "br"));
        assert!(!accepts(Some("gzip;q=0, br"), "gzip"));
        assert!(accepts(Some("*"), "gzip"));
        assert!(!accepts(Some("identity"), "gzip"));
        assert!(!accepts(None, "gzip"));
    }

    #[test]
    fn ranges() {
        use ByteRange::*;
        let r = |h: &str| parse_range(Some(h), 100);
        assert_eq!(parse_range(None, 100), Full);
        assert_eq!(r("bytes=0-9"), Part(0, 9));
        assert_eq!(r("bytes=90-"), Part(90, 99));
        assert_eq!(r("bytes=-10"), Part(90, 99));
        assert_eq!(r("bytes=-1000"), Part(0, 99));
        assert_eq!(r("bytes=100-"), Unsatisfiable);
        assert_eq!(r("bytes=-0"), Unsatisfiable);
        assert_eq!(r("bytes=0-1,5-6"), Full);
        assert_eq!(r("bytes=5-1"), Full);
        assert_eq!(parse_range(Some("bytes=0-"), 0), Unsatisfiable);
    }

    #[test]
    fn cookies_and_forms() {
        let mut req = Request::get("POST", "/x?a=1&b=two+words");
        req.headers
            .push(("cookie".into(), "theme=dark; lang=zh-Hans".into()));
        req.body = Some(b"content=%23tag+hi&pinned=1".to_vec());
        assert_eq!(req.query("b").as_deref(), Some("two words"));
        assert_eq!(req.cookie("lang").as_deref(), Some("zh-Hans"));
        assert_eq!(req.cookie("missing"), None);
        let form = req.form();
        assert_eq!(form_value(&form, "content"), Some("#tag hi"));
        assert_eq!(encode_component("a b/#"), "a%20b%2F%23");
    }
}

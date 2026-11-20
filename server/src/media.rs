//! The media details a browser reads from a file it uploads (memos' MediaMetadata),
//! kept only in the shape and ranges memos' server accepts.

use serde_json::{Map, Value};

const MAX_STRING_BYTES: usize = 256;

/// The stored form of `raw`, or `None` when it holds nothing memos would keep.
/// `{}` records that the upload saved metadata with only its dimensions.
pub fn sanitize(raw: &str, mime: &str, has_dimensions: bool) -> Option<String> {
    let v: Value = serde_json::from_str(raw).ok()?;
    let obj = v.as_object()?;
    let mime = mime.to_ascii_lowercase();
    let mut out = Map::new();
    if mime.starts_with("image/") {
        if let Some(p) = obj.get("photo").and_then(photo) {
            out.insert("photo".into(), p);
        }
    } else if mime.starts_with("video/") {
        if let Some(d) = obj.get("video").and_then(|v| v.get("durationSeconds")).and_then(Value::as_f64).filter(|d| d.is_finite() && *d >= 0.0) {
            out.insert("video".into(), serde_json::json!({ "durationSeconds": d }));
        }
    } else {
        return None;
    }
    if out.is_empty() && !has_dimensions {
        return None;
    }
    Some(Value::Object(out).to_string())
}

fn text(v: Option<&Value>) -> Option<Value> {
    let s: String = v?.as_str()?.chars().filter(|c| !c.is_control()).collect();
    let s = s.trim();
    (!s.is_empty() && s.len() <= MAX_STRING_BYTES).then(|| Value::from(s))
}

fn positive(v: Option<&Value>) -> Option<Value> {
    v?.as_f64().filter(|n| n.is_finite() && *n > 0.0).map(Value::from)
}

fn int(v: Option<&Value>, min: i64, max: i64) -> Option<Value> {
    v?.as_i64().filter(|n| (min..=max).contains(n)).map(Value::from)
}

fn local_date_time(s: &str) -> bool {
    let b = s.as_bytes();
    let digits = |r: std::ops::Range<usize>| b.get(r).is_some_and(|d| d.iter().all(u8::is_ascii_digit));
    let shape = b.len() >= 19
        && [(0..4), (5..7), (8..10), (11..13), (14..16), (17..19)].into_iter().all(digits)
        && b[4] == b'-' && b[7] == b'-' && b[10] == b'T' && b[13] == b':' && b[16] == b':';
    let fraction = match &s.get(19..) {
        Some("") => true,
        Some(f) => f.len() <= 10 && f.starts_with('.') && f.len() > 1 && f[1..].bytes().all(|c| c.is_ascii_digit()),
        None => false,
    };
    shape && fraction && s[..19].parse::<jiff::civil::DateTime>().is_ok() && &s[..4] != "0000"
}

fn utc_offset(s: &str) -> bool {
    if s == "Z" {
        return true;
    }
    let b = s.as_bytes();
    if b.len() != 6 || !matches!(b[0], b'+' | b'-') || b[3] != b':' {
        return false;
    }
    match (s[1..3].parse::<u8>(), s[4..6].parse::<u8>()) {
        (Ok(h), Ok(m)) => h <= 14 && m <= 59 && (h != 14 || m == 0),
        _ => false,
    }
}

fn photo(v: &Value) -> Option<Value> {
    let mut out = Map::new();
    let capture = v.get("captureTime").and_then(|c| {
        let local = c.get("localDateTime")?.as_str().filter(|s| local_date_time(s))?;
        let mut t = Map::new();
        t.insert("localDateTime".into(), local.into());
        if let Some(o) = c.get("utcOffset").and_then(Value::as_str).filter(|s| utc_offset(s)) {
            t.insert("utcOffset".into(), o.into());
        }
        Some(Value::Object(t))
    });
    let location = v.get("location").and_then(|l| {
        let lat = l.get("latitude")?.as_f64().filter(|n| (-90.0..=90.0).contains(n))?;
        let lon = l.get("longitude")?.as_f64().filter(|n| (-180.0..=180.0).contains(n))?;
        let mut m = Map::new();
        m.insert("latitude".into(), lat.into());
        m.insert("longitude".into(), lon.into());
        if let Some(a) = l.get("altitudeMeters").and_then(Value::as_f64).filter(|n| n.is_finite()) {
            m.insert("altitudeMeters".into(), a.into());
        }
        Some(Value::Object(m))
    });
    let fields = [
        ("captureTime", capture),
        ("location", location),
        ("sourceExifOrientation", int(v.get("sourceExifOrientation"), 1, 8)),
        ("cameraMake", text(v.get("cameraMake"))),
        ("cameraModel", text(v.get("cameraModel"))),
        ("lensModel", text(v.get("lensModel"))),
        ("fNumber", positive(v.get("fNumber"))),
        ("exposureTimeSeconds", positive(v.get("exposureTimeSeconds"))),
        ("iso", int(v.get("iso"), 1, i64::from(u32::MAX))),
        ("focalLengthMm", positive(v.get("focalLengthMm"))),
    ];
    for (k, v) in fields {
        if let Some(v) = v {
            out.insert(k.into(), v);
        }
    }
    (!out.is_empty()).then_some(Value::Object(out))
}

/// `Intl.NumberFormat("en", { maximumFractionDigits })`.
pub fn number(v: f64, max_fraction: usize) -> String {
    let s = format!("{v:.max_fraction$}");
    let s = if s.contains('.') { s.trim_end_matches('0').trim_end_matches('.') } else { &s };
    let (sign, s) = s.strip_prefix('-').map_or(("", s), |r| ("-", r));
    let (int, frac) = s.split_once('.').map_or((s, ""), |(a, b)| (a, b));
    let mut out = String::from(sign);
    for (i, ch) in int.chars().enumerate() {
        if i > 0 && (int.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    if !frac.is_empty() {
        out.push('.');
        out.push_str(frac);
    }
    out
}

/// memos' formatMediaDuration.
pub fn duration(seconds: f64) -> String {
    let total = seconds.max(0.0).round() as u64;
    let (h, m, s) = (total / 3600, total % 3600 / 60, total % 60);
    if h > 0 { format!("{h}:{m:02}:{s:02}") } else { format!("{m}:{s:02}") }
}

/// memos' formatExposureTime.
pub fn exposure_time(seconds: f64) -> String {
    if seconds > 0.0 && seconds < 1.0 {
        let reciprocal = 1.0 / seconds;
        let rounded = reciprocal.round();
        if rounded > 0.0 && (reciprocal - rounded).abs() / rounded < 0.01 {
            return format!("1/{rounded} s");
        }
    }
    format!("{} s", number(seconds, 4))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keeps_what_memos_keeps() {
        let raw = json!({
            "photo": {
                "captureTime": { "localDateTime": "2024-05-01T14:23:45.120", "utcOffset": "+02:00" },
                "location": { "latitude": 48.8, "longitude": 2.29, "altitudeMeters": -3.5 },
                "sourceExifOrientation": 6,
                "cameraMake": " Canon\u{0}",
                "cameraModel": "",
                "fNumber": 2.8,
                "exposureTimeSeconds": -1,
                "iso": 400,
                "extra": "dropped"
            },
            "video": { "durationSeconds": 3 }
        })
        .to_string();
        let v: Value = serde_json::from_str(&sanitize(&raw, "image/jpeg", true).unwrap()).unwrap();
        assert_eq!(
            v,
            json!({ "photo": {
                "captureTime": { "localDateTime": "2024-05-01T14:23:45.120", "utcOffset": "+02:00" },
                "location": { "latitude": 48.8, "longitude": 2.29, "altitudeMeters": -3.5 },
                "sourceExifOrientation": 6,
                "cameraMake": "Canon",
                "fNumber": 2.8,
                "iso": 400
            }})
        );
        assert_eq!(sanitize(r#"{"video":{"durationSeconds":12.5}}"#, "video/mp4", false).as_deref(), Some(r#"{"video":{"durationSeconds":12.5}}"#));
        assert_eq!(sanitize("{}", "image/png", true).as_deref(), Some("{}"));
        assert_eq!(sanitize("{}", "image/png", false), None);
        assert_eq!(sanitize(r#"{"photo":{}}"#, "application/pdf", true), None);
        assert_eq!(sanitize("[1]", "image/png", true), None);
    }

    #[test]
    fn rejects_impossible_times_and_offsets() {
        assert!(local_date_time("2024-02-29T23:59:59"));
        assert!(!local_date_time("2023-02-29T00:00:00"));
        assert!(!local_date_time("0000-01-01T00:00:00"));
        assert!(!local_date_time("2024-01-01 00:00:00"));
        assert!(!local_date_time("2024-01-01T00:00:00."));
        assert!(utc_offset("Z") && utc_offset("-14:00") && utc_offset("+05:45"));
        assert!(!utc_offset("+14:30") && !utc_offset("+0200") && !utc_offset("+02:60"));
    }

    #[test]
    fn formats_like_memos() {
        assert_eq!(number(2.8, 2), "2.8");
        assert_eq!(number(50.0, 2), "50");
        assert_eq!(number(1234.56, 1), "1,234.6");
        assert_eq!(number(-35.26, 1), "-35.3");
        assert_eq!(exposure_time(0.004), "1/250 s");
        assert_eq!(exposure_time(0.3), "0.3 s");
        assert_eq!(exposure_time(2.0), "2 s");
        assert_eq!(duration(65.4), "1:05");
        assert_eq!(duration(3725.0), "1:02:05");
    }
}

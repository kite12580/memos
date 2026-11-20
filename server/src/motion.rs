use regex_lite::Regex;
use serde_json::{Value, json};
use std::io::{Read, Seek, SeekFrom};
use std::sync::LazyLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Still,
    Video,
    Container,
}

impl Role {
    fn as_str(self) -> &'static str {
        match self {
            Role::Still => "still",
            Role::Video => "video",
            Role::Container => "container",
        }
    }

    fn parse(s: &str) -> Option<Role> {
        match s {
            "still" => Some(Role::Still),
            "video" => Some(Role::Video),
            "container" => Some(Role::Container),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Motion {
    pub role: Role,
    pub group: String,
    pub presentation_us: i64,
    pub video_start: Option<u64>,
}

const MAX_GROUP_BYTES: usize = 128;

impl Motion {
    /// memos' validateClientMotionMedia.
    pub fn from_client(role: &str, group: &str) -> Option<Motion> {
        let role = Role::parse(role).filter(|r| *r != Role::Container)?;
        let group = group.trim();
        if group.is_empty() || group.len() > MAX_GROUP_BYTES || group.chars().any(char::is_control) {
            return None;
        }
        Some(Motion { role, group: group.to_string(), presentation_us: 0, video_start: None })
    }

    pub fn container(uid: &str, d: Detection) -> Motion {
        Motion { role: Role::Container, group: uid.to_string(), presentation_us: d.presentation_us, video_start: Some(d.video_start) }
    }

    pub fn to_json(&self) -> String {
        let mut v = json!({ "role": self.role.as_str(), "group": self.group });
        if self.presentation_us != 0 {
            v["pts"] = self.presentation_us.into();
        }
        if let Some(start) = self.video_start {
            v["videoStart"] = start.into();
        }
        v.to_string()
    }

    pub fn from_json(s: &str) -> Option<Motion> {
        let v: Value = serde_json::from_str(s).ok()?;
        let role = Role::parse(v.get("role")?.as_str()?)?;
        let video_start = v.get("videoStart").and_then(Value::as_u64);
        if role == Role::Container && video_start.is_none() {
            return None;
        }
        Some(Motion {
            role,
            group: v.get("group")?.as_str()?.to_string(),
            presentation_us: v.get("pts").and_then(Value::as_i64).unwrap_or(0),
            video_start,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Detection {
    pub video_start: u64,
    pub presentation_us: i64,
}

static MARKER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)(?:Camera:MotionPhoto|GCamera:MotionPhoto|MicroVideo)["'=:\s>]+1"#).unwrap());
static PRESENTATION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)(?:Camera:MotionPhotoPresentationTimestampUs|GCamera:MotionPhotoPresentationTimestampUs)["'=:\s>]+(-?\d+)"#).unwrap());
static MICRO_VIDEO_OFFSET: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)(?:Camera:MicroVideoOffset|GCamera:MicroVideoOffset)["'=:\s>]+(\d+)"#).unwrap());

const MAX_METADATA_SCAN: u64 = 256 * 1024;
const SCAN_BLOCK: u64 = 64 * 1024;
const BOX_HEADER: u64 = 12;

fn read_at<R: Read + Seek>(r: &mut R, at: u64, len: u64) -> std::io::Result<Vec<u8>> {
    r.seek(SeekFrom::Start(at))?;
    let mut buf = vec![0; len as usize];
    r.read_exact(&mut buf)?;
    Ok(buf)
}

fn looks_like_mp4(b: &[u8]) -> bool {
    if b.len() < BOX_HEADER as usize || &b[4..8] != b"ftyp" {
        return false;
    }
    let size = u32::from_be_bytes([b[0], b[1], b[2], b[3]]);
    size == 1 || size >= 8
}

fn last_mp4_start(b: &[u8]) -> Option<usize> {
    let mut end = b.len();
    while end > 8 {
        let index = b[..end].windows(4).rposition(|w| w == b"ftyp")?;
        if index < 4 {
            return None;
        }
        if looks_like_mp4(&b[index - 4..]) {
            return Some(index - 4);
        }
        end = index;
    }
    None
}

/// memos' DetectJPEGReader.
pub fn detect<R: Read + Seek>(r: &mut R, size: u64) -> std::io::Result<Option<Detection>> {
    if size < 16 {
        return Ok(None);
    }
    let header = read_at(r, 0, size.min(MAX_METADATA_SCAN))?;
    if !header.starts_with(&[0xFF, 0xD8]) {
        return Ok(None);
    }
    let text = String::from_utf8_lossy(&header);
    if !MARKER.is_match(&text) {
        return Ok(None);
    }
    let presentation_us = PRESENTATION
        .captures(&text)
        .and_then(|c| c[1].parse().ok())
        .unwrap_or(0);
    let found = |video_start| Ok(Some(Detection { video_start, presentation_us }));
    if let Some(offset) = MICRO_VIDEO_OFFSET.captures(&text).and_then(|c| c[1].parse::<u64>().ok())
        && (BOX_HEADER..size).contains(&offset)
        && looks_like_mp4(&read_at(r, size - offset, BOX_HEADER)?)
    {
        return found(size - offset);
    }
    let mut end = size;
    while end >= BOX_HEADER {
        let start = end.saturating_sub(SCAN_BLOCK);
        if let Some(i) = last_mp4_start(&read_at(r, start, end - start)?) {
            return found(start + i as u64);
        }
        if start == 0 {
            break;
        }
        end = start + BOX_HEADER - 1;
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn motion_jpeg() -> Vec<u8> {
        let mut b = vec![0xFF, 0xD8, 0xFF, 0xE1];
        b.extend_from_slice(br#"<?xpacket begin=""?><rdf:Description GCamera:MotionPhoto="1" GCamera:MotionPhotoPresentationTimestampUs="123456"></rdf:Description>"#);
        b.extend_from_slice(&[0xFF, 0xD9, 0, 0, 0, 0x10, b'f', b't', b'y', b'p', b'i', b's', b'o', b'm', 0, 0, 0, 0]);
        b
    }

    fn run(b: &[u8]) -> Option<Detection> {
        detect(&mut Cursor::new(b), b.len() as u64).unwrap()
    }

    const BOX: [u8; 12] = [0, 0, 0, 16, b'f', b't', b'y', b'p', b'm', b'p', b'4', b'2'];

    #[test]
    fn detects_the_fixture() {
        let b = motion_jpeg();
        let d = run(&b).unwrap();
        assert_eq!(d.presentation_us, 123456);
        assert_eq!(&b[d.video_start as usize..d.video_start as usize + 8], &[0, 0, 0, 0x10, b'f', b't', b'y', b'p']);
    }

    #[test]
    fn ignores_files_without_the_marker() {
        for b in [&b""[..], b"not a JPEG", b"\xff\xd8 no motion marker here at all", b"Camera:MotionPhoto=\"1\" not a jpeg ftyp"] {
            assert_eq!(run(b), None);
        }
    }

    #[test]
    fn finds_boxes_across_scan_blocks() {
        for offset in -12i64..=12 {
            let mut b = vec![0u8; 200_000];
            let head = b"\xff\xd8 Camera:MotionPhoto=\"1\"";
            b[..head.len()].copy_from_slice(head);
            let start = (b.len() as i64 - SCAN_BLOCK as i64 + offset) as usize;
            b[start..start + 12].copy_from_slice(&BOX);
            assert_eq!(run(&b).map(|d| d.video_start), Some(start as u64), "offset {offset}");
        }
    }

    #[test]
    fn prefers_micro_video_offset() {
        let mut b = vec![0u8; 1024];
        let head = b"\xff\xd8 Camera:MotionPhoto=\"1\" Camera:MicroVideoOffset=\"128\"";
        b[..head.len()].copy_from_slice(head);
        b[896..908].copy_from_slice(&BOX);
        b[1000..1012].copy_from_slice(&BOX);
        assert_eq!(run(&b).map(|d| d.video_start), Some(896));
    }

    #[test]
    fn round_trips_and_validates() {
        let m = Motion::container("u1", Detection { video_start: 40, presentation_us: 5 });
        assert_eq!(Motion::from_json(&m.to_json()), Some(m));
        let still = Motion::from_client("still", " IMG_1-abc ").unwrap();
        assert_eq!((still.role, still.group.as_str()), (Role::Still, "IMG_1-abc"));
        assert_eq!(Motion::from_json(&still.to_json()), Some(still));
        assert_eq!(Motion::from_client("container", "g"), None);
        assert_eq!(Motion::from_client("video", " "), None);
        assert_eq!(Motion::from_client("live", "g"), None);
    }
}

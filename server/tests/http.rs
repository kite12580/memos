use memos_lite::app::App;
use memos_lite::assets::Assets;
use memos_lite::config::Config;
use memos_lite::db::{Db, new_uid};
use memos_lite::{files, server};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

struct Server {
    addr: SocketAddr,
    root: PathBuf,
}

impl Server {
    async fn start() -> Server {
        let root = std::env::temp_dir().join(format!("memos-lite-test-{}", new_uid()));
        let client = root.join("client");
        std::fs::create_dir_all(client.join("assets")).unwrap();
        std::fs::write(client.join("manifest.json"), "{}").unwrap();
        let data = root.join("data");
        std::fs::create_dir_all(&data).unwrap();
        let config = Config::from_env(|k| match k {
            "DATA_DIR" => Some(data.to_string_lossy().into_owned()),
            "CLIENT_DIR" => Some(client.to_string_lossy().into_owned()),
            "MAX_UPLOAD_MB" => Some("1".into()),
            "TZ" => Some("UTC".into()),
            _ => None,
        })
        .unwrap();
        files::prepare(&config.data_dir).unwrap();
        let db = Db::open(&data.join("memos.db").to_string_lossy()).unwrap();
        let app = Arc::new(App::new(db, config, Assets::load(&client).unwrap()));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(server::run(listener, app, std::future::pending()));
        Server { addr, root }
    }

    fn stored(&self) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(files::dir(&self.root.join("data")))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    /// Sends `head` plus a blank line and `body`, and reads the response to the end.
    async fn send(&self, head: &str, body: &[u8]) -> (u16, String, Vec<u8>) {
        let mut s = TcpStream::connect(self.addr).await.unwrap();
        let head = format!("{head}\r\nhost: test\r\nsec-fetch-site: same-origin\r\nconnection: close\r\n\r\n");
        s.write_all(head.as_bytes()).await.unwrap();
        let _ = s.write_all(body).await;
        let mut raw = vec![];
        let _ = s.read_to_end(&mut raw).await;
        let split = raw.windows(4).position(|w| w == b"\r\n\r\n").expect("response head");
        let head = String::from_utf8_lossy(&raw[..split]).to_lowercase();
        let status = head.split(' ').nth(1).unwrap().parse().unwrap();
        (status, head, raw[split + 4..].to_vec())
    }

    async fn upload(&self, body: &[u8]) -> (u16, Vec<u8>) {
        let head = format!("POST /attachments?name=a.bin&type=application/octet-stream HTTP/1.1\r\ncontent-length: {}", body.len());
        let (status, _, res) = self.send(&head, body).await;
        (status, res)
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn pattern(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i * 31 % 251) as u8).collect()
}

#[tokio::test]
async fn uploads_and_serves_ranges() {
    let server = Server::start().await;
    let data = pattern(300_000);
    let (status, res) = server.upload(&data).await;
    assert_eq!(status, 200);
    let json: serde_json::Value = serde_json::from_slice(&res).unwrap();
    assert_eq!(json["size"], 300_000);
    let url = json["url"].as_str().unwrap();
    assert_eq!(server.stored(), [json["uid"].as_str().unwrap()]);

    let (status, head, body) = server.send(&format!("GET {url} HTTP/1.1"), b"").await;
    assert_eq!(status, 200);
    assert!(head.contains("content-length: 300000"));
    assert!(head.contains("content-disposition: attachment"));
    assert!(body == data);

    let (status, head, body) = server.send(&format!("GET {url} HTTP/1.1\r\nrange: bytes=70000-169999"), b"").await;
    assert_eq!(status, 206);
    assert!(head.contains("content-range: bytes 70000-169999/300000"));
    assert!(body == data[70_000..170_000]);

    let (status, _, body) = server.send(&format!("GET {url} HTTP/1.1\r\nrange: bytes=-5"), b"").await;
    assert_eq!(status, 206);
    assert_eq!(body, data[299_995..]);

    let (status, head, body) = server.send(&format!("HEAD {url} HTTP/1.1"), b"").await;
    assert_eq!(status, 200);
    assert!(head.contains("content-length: 300000"));
    assert!(body.is_empty());

    let (status, _, _) = server.send(&format!("GET {url} HTTP/1.1\r\nrange: bytes=300000-"), b"").await;
    assert_eq!(status, 416);
}

#[tokio::test]
async fn refuses_oversized_uploads_and_keeps_nothing() {
    let server = Server::start().await;
    let (status, _) = server.upload(&pattern((1 << 20) + 1)).await;
    assert_eq!(status, 413);

    let mut chunked = vec![];
    for _ in 0..17 {
        chunked.extend_from_slice(b"10000\r\n");
        chunked.extend_from_slice(&[7u8; 0x10000]);
        chunked.extend_from_slice(b"\r\n");
    }
    chunked.extend_from_slice(b"0\r\n\r\n");
    let (status, _, _) = server
        .send("POST /attachments?name=a.bin HTTP/1.1\r\ntransfer-encoding: chunked", &chunked)
        .await;
    assert_eq!(status, 413);
    assert!(server.stored().is_empty());
}

#[tokio::test]
async fn drops_interrupted_uploads() {
    let server = Server::start().await;
    let mut s = TcpStream::connect(server.addr).await.unwrap();
    s.write_all(b"POST /attachments?name=a.bin HTTP/1.1\r\nhost: test\r\nsec-fetch-site: same-origin\r\ncontent-length: 100000\r\n\r\n")
        .await
        .unwrap();
    s.write_all(&[1u8; 50_000]).await.unwrap();
    for _ in 0..200 {
        if !server.stored().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(server.stored().len(), 1);
    drop(s);
    for _ in 0..200 {
        if server.stored().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(server.stored().is_empty());
}

#[tokio::test]
async fn refuses_cross_site_and_unknown_uploads() {
    let server = Server::start().await;
    let mut s = TcpStream::connect(server.addr).await.unwrap();
    s.write_all(b"POST /attachments?name=a.bin HTTP/1.1\r\nhost: test\r\nsec-fetch-site: cross-site\r\nconnection: close\r\ncontent-length: 3\r\n\r\nabc")
        .await
        .unwrap();
    let mut raw = vec![];
    let _ = s.read_to_end(&mut raw).await;
    assert!(raw.starts_with(b"HTTP/1.1 403"));

    let (status, _, _) = server.send("POST /attachments/nope/thumb HTTP/1.1\r\ncontent-length: 3", b"abc").await;
    assert_eq!(status, 404);
    assert!(server.stored().is_empty());
}

#[test]
fn prepare_clears_partial_uploads() {
    let root = std::env::temp_dir().join(format!("memos-lite-test-{}", new_uid()));
    let dir = files::dir(&root);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("abc.part"), "x").unwrap();
    std::fs::write(dir.join("kept"), "x").unwrap();
    files::prepare(&root).unwrap();
    let names: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(names, ["kept"]);
    std::fs::remove_dir_all(&root).unwrap();
}

#[tokio::test]
async fn revalidates_pages_until_a_write() {
    let server = Server::start().await;
    let (status, head, _) = server.send("GET / HTTP/1.1", b"").await;
    assert_eq!(status, 200);
    let etag = head.lines().find_map(|l| l.strip_prefix("etag: w/")).unwrap();
    let revalidate = format!("GET / HTTP/1.1\r\nif-none-match: W/{etag}");
    assert_eq!(server.send(&revalidate, b"").await.0, 304);

    let body = br#"{"content":"hello"}"#;
    let post = format!("POST /memos HTTP/1.1\r\ncontent-length: {}", body.len());
    assert_eq!(server.send(&post, body).await.0, 200);
    let (status, _, page) = server.send(&revalidate, b"").await;
    assert_eq!(status, 200);
    assert!(String::from_utf8_lossy(&page).contains("hello"));
}

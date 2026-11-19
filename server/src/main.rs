use bytes::Bytes;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full};
use hyper::body::{Frame, Incoming};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::{TokioIo, TokioTimer};
use hyper_util::server::graceful::GracefulShutdown;
use memos_lite::app::App;
use memos_lite::assets::Assets;
use memos_lite::config::Config;
use memos_lite::db::Db;
use memos_lite::http::{BodyStream, Request, Response};
use std::convert::Infallible;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::mpsc;

/// Whole-body limit for buffered requests; per-frame idle limit for streamed ones.
const BODY_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_BUFFERED_BODY: usize = 16 << 20;
const SHUTDOWN_GRACE: Duration = Duration::from_secs(1);

fn stream_body(mut body: Incoming) -> BodyStream {
    let (tx, rx) = mpsc::channel(2);
    tokio::spawn(async move {
        loop {
            let data = match tokio::time::timeout(BODY_TIMEOUT, body.frame()).await {
                Ok(None) => return,
                Ok(Some(Ok(frame))) => match frame.into_data() {
                    Ok(data) => Ok(data),
                    Err(_) => continue,
                },
                _ => Err(()),
            };
            let failed = data.is_err();
            if tx.send(data).await.is_err() || failed {
                return;
            }
        }
    });
    rx
}

struct ChannelBody(BodyStream);

impl hyper::body::Body for ChannelBody {
    type Data = Bytes;
    type Error = std::io::Error;

    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, std::io::Error>>> {
        self.0.poll_recv(cx).map(|next| {
            next.map(|r| {
                r.map(Frame::data)
                    .map_err(|()| std::io::Error::other("stream aborted"))
            })
        })
    }
}

type ResBody = BoxBody<Bytes, std::io::Error>;

async fn serve(app: Arc<App>, req: hyper::Request<Incoming>) -> Result<hyper::Response<ResBody>, Infallible> {
    let (parts, body) = req.into_parts();
    let headers: Vec<(String, String)> = parts
        .headers
        .iter()
        .map(|(k, v)| (k.as_str().to_string(), String::from_utf8_lossy(v.as_bytes()).into_owned()))
        .collect();
    let (body, stream) = if memos_lite::files::streams_body(parts.method.as_str(), parts.uri.path()) {
        (None, Some(stream_body(body)))
    } else {
        let limited = http_body_util::Limited::new(body, MAX_BUFFERED_BODY);
        match tokio::time::timeout(BODY_TIMEOUT, limited.collect()).await {
            Ok(Ok(b)) => (Some(b.to_bytes().to_vec()), None),
            Ok(Err(_)) => return Ok(to_hyper(Response::text(413, "Request body too large"))),
            Err(_) => return Ok(to_hyper(Response::text(408, "Request Timeout"))),
        }
    };
    let request = Request {
        method: parts.method.as_str().to_string(),
        path: parts.uri.path().to_string(),
        query: parts.uri.query().unwrap_or("").to_string(),
        headers,
        body,
        stream,
    };
    Ok(to_hyper(app.handle(request).await))
}

fn full(data: Bytes) -> ResBody {
    Full::new(data).map_err(|never| match never {}).boxed()
}

fn to_hyper(res: Response) -> hyper::Response<ResBody> {
    let mut out = hyper::Response::builder().status(res.status);
    for (k, v) in &res.headers {
        out = out.header(k, v);
    }
    let body = match res.stream {
        Some(stream) => ChannelBody(stream).boxed(),
        None => full(res.body),
    };
    out.body(body).unwrap_or_else(|_| {
        let mut fallback = hyper::Response::new(full(Bytes::from_static(b"Internal Server Error")));
        *fallback.status_mut() = hyper::StatusCode::INTERNAL_SERVER_ERROR;
        fallback
    })
}

fn fail(msg: impl std::fmt::Display) -> ! {
    eprintln!("{msg}");
    std::process::exit(1)
}

fn open_db(config: &Config) -> Db {
    if let Err(e) = std::fs::create_dir_all(&config.data_dir) {
        fail(format!("{}: {e}", config.data_dir.display()));
    }
    let path = config.data_dir.join("memos.db");
    Db::open(&path.to_string_lossy()).unwrap_or_else(|e| fail(format!("database {}: {e}", path.display())))
}

const USAGE: &str = "usage: memos-lite [serve | backup FILE]

Environment: PORT (5230), HOST (0.0.0.0), DATA_DIR (data), CLIENT_DIR,
BASE_PATH, API_TOKEN, COMPRESS (1), MAX_UPLOAD_MB (64), TZ.";

fn main() {
    let env = |k: &str| std::env::var(k).ok();
    let config = Config::from_env(env).unwrap_or_else(|e| fail(e));
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        [] | ["serve"] => {}
        ["backup", out] => {
            let db = open_db(&config);
            memos_lite::backup::run(&db, &config.data_dir, std::path::Path::new(out)).unwrap_or_else(|e| fail(e));
            return;
        }
        _ => fail(USAGE),
    }

    let assets = Assets::load(&config.client_dir).unwrap_or_else(|e| fail(e));
    let db = open_db(&config);
    let (host, port) = (config.host.clone(), config.port);
    let app = Arc::new(App::new(db, config, assets));

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(2)
        .build()
        .expect("tokio runtime");
    runtime.block_on(async move {
        let listener = TcpListener::bind((host.as_str(), port))
            .await
            .unwrap_or_else(|e| fail(format!("{host}:{port}: {e}")));
        println!("memos-lite listening on http://{host}:{port}{}/", app.cfg.base);
        let shutdown = async {
            let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("signal handler");
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {},
                _ = term.recv() => {},
            }
        };
        tokio::pin!(shutdown);
        let graceful = GracefulShutdown::new();
        loop {
            tokio::select! {
                _ = &mut shutdown => break,
                accepted = listener.accept() => {
                    let (stream, _) = match accepted {
                        Ok(a) => a,
                        Err(e) => {
                            eprintln!("accept failed: {e}");
                            tokio::time::sleep(Duration::from_millis(100)).await;
                            continue;
                        }
                    };
                    let _ = stream.set_nodelay(true);
                    let app = app.clone();
                    let svc = service_fn(move |req| serve(app.clone(), req));
                    let conn = http1::Builder::new()
                        .timer(TokioTimer::new())
                        .header_read_timeout(Duration::from_secs(30))
                        .serve_connection(TokioIo::new(stream), svc);
                    let conn = graceful.watch(conn);
                    tokio::spawn(async move {
                        let _ = conn.await;
                    });
                }
            }
        }
        let _ = tokio::time::timeout(SHUTDOWN_GRACE, graceful.shutdown()).await;
    });
}

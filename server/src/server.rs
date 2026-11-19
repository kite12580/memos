//! The hyper side: accepts connections and turns hyper's requests and
//! responses into the app's.

use crate::app::App;
use crate::http::{BodyStream, Request, Response};
use bytes::Bytes;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full};
use hyper::body::{Frame, Incoming};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::{TokioIo, TokioTimer};
use hyper_util::server::graceful::GracefulShutdown;
use std::convert::Infallible;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::net::TcpListener;

const SHUTDOWN_GRACE: Duration = Duration::from_secs(1);

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
    let request = Request {
        method: parts.method.as_str().to_string(),
        path: parts.uri.path().to_string(),
        query: parts.uri.query().unwrap_or("").to_string(),
        headers: parts
            .headers
            .iter()
            .map(|(k, v)| (k.as_str().to_string(), String::from_utf8_lossy(v.as_bytes()).into_owned()))
            .collect(),
        body: None,
        stream: Some(body.map_err(std::io::Error::other).boxed()),
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

/// Serves connections until `shutdown` resolves, then gives open requests a
/// moment to finish.
pub async fn run(listener: TcpListener, app: Arc<App>, shutdown: impl Future<Output = ()>) {
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
}

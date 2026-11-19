use crate::app::App;
use crate::h;
use crate::http::{Request, Response};
use crate::views::{Ctx, Sidebar};
use askama::Template;
use std::sync::Arc;

#[derive(Template)]
#[template(path = "pages/stub.html")]
struct Stub<'a> {
    c: Ctx<'a>,
    sb: Sidebar,
    title: String,
}

pub async fn attachments(app: &Arc<App>, req: &Request) -> Response {
    let c = app.ctx(req);
    let _ = h::icon;
    let p = Stub { sb: Sidebar { active: "attachments", ..Default::default() }, title: "attachments".into(), c };
    super::page(app, req, &p.c, &p)
}

pub async fn attachments_fragment(_app: &Arc<App>, _req: &Request) -> Response {
    Response::not_found()
}

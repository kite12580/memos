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

pub async fn views(app: &Arc<App>, req: &Request) -> Response {
    let c = app.ctx(req);
    let _ = h::icon;
    let p = Stub { sb: Sidebar { active: "views", ..Default::default() }, title: "views".into(), c };
    super::page(app, req, &p.c, &p)
}

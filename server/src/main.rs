use memos_lite::app::App;
use memos_lite::assets::Assets;
use memos_lite::config::Config;
use memos_lite::db::Db;
use std::sync::Arc;
use tokio::net::TcpListener;

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
    memos_lite::files::prepare(&config.data_dir)
        .unwrap_or_else(|e| fail(format!("{}: {e}", config.data_dir.display())));
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
        memos_lite::server::run(listener, app, shutdown).await;
    });
}

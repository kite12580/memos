use jiff::tz::TimeZone;
use std::path::PathBuf;

pub struct Config {
    pub host: String,
    pub port: u16,
    /// `BASE_PATH` without a trailing slash; empty for `/`.
    pub base: String,
    pub data_dir: PathBuf,
    pub client_dir: PathBuf,
    /// Bearer token for `/api/`; the API is off without one.
    pub api_token: Option<String>,
    /// Off when a proxy in front compresses responses.
    pub compress: bool,
    pub max_upload: u64,
    /// For visitors whose browser has not reported its time zone yet.
    pub tz: TimeZone,
}

pub fn base_path(raw: Option<&str>) -> String {
    let trimmed = raw.unwrap_or("/").trim().trim_end_matches('/');
    if trimmed.is_empty() || trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{trimmed}")
    }
}

impl Config {
    pub fn from_env(env: impl Fn(&str) -> Option<String>) -> Result<Config, String> {
        let get = |k: &str| env(k).filter(|v| !v.trim().is_empty());
        let port = match get("PORT") {
            None => 5230,
            Some(p) => p.trim().parse().map_err(|_| format!("invalid PORT: {p}"))?,
        };
        let max_upload = match get("MAX_UPLOAD_MB") {
            None => 64,
            Some(v) => v
                .trim()
                .parse::<u64>()
                .map_err(|_| format!("invalid MAX_UPLOAD_MB: {v}"))?,
        } << 20;
        let tz = match get("TZ") {
            None => TimeZone::try_system().unwrap_or(TimeZone::UTC),
            Some(name) => TimeZone::get(name.trim()).map_err(|_| format!("unknown TZ: {name}"))?,
        };
        Ok(Config {
            host: get("HOST").unwrap_or_else(|| "0.0.0.0".into()),
            port,
            base: base_path(get("BASE_PATH").as_deref()),
            data_dir: PathBuf::from(get("DATA_DIR").unwrap_or_else(|| "data".into())),
            client_dir: PathBuf::from(get("CLIENT_DIR").unwrap_or_else(|| "../client/dist".into())),
            api_token: get("API_TOKEN"),
            compress: get("COMPRESS").is_none_or(|v| v != "0" && v != "false"),
            max_upload,
            tz,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_paths() {
        assert_eq!(base_path(None), "");
        assert_eq!(base_path(Some("/")), "");
        assert_eq!(base_path(Some("memos/")), "/memos");
        assert_eq!(base_path(Some("/a/b/")), "/a/b");
    }

    #[test]
    fn parses_env() {
        let c = Config::from_env(|k| match k {
            "PORT" => Some("8080".into()),
            "BASE_PATH" => Some("/notes".into()),
            "COMPRESS" => Some("0".into()),
            "TZ" => Some("Asia/Tokyo".into()),
            _ => None,
        })
        .unwrap();
        assert_eq!((c.port, c.base.as_str(), c.compress), (8080, "/notes", false));
        assert!(Config::from_env(|k| (k == "PORT").then(|| "x".into())).is_err());
        assert!(Config::from_env(|k| (k == "TZ").then(|| "Nowhere/City".into())).is_err());
    }
}

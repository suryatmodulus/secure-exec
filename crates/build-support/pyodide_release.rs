pub const SECURE_EXEC_RELEASE_CDN_ENV: &str = "SECURE_EXEC_RELEASE_CDN";

pub fn pyodide_release_base_url(version: &str, configured_cdn: Option<&str>) -> String {
    if let Some(configured_cdn) = configured_cdn {
        let configured_cdn = configured_cdn.trim().trim_end_matches('/');
        if !configured_cdn.is_empty() {
            return configured_cdn.to_owned();
        }
    }

    format!("https://github.com/rivet-dev/agent-os/releases/download/v{version}")
}

pub fn pyodide_release_asset_url(base_url: &str, asset: &str) -> String {
    format!("{}/{asset}", base_url.trim_end_matches('/'))
}

// Pyodide release-asset URL helpers.
//
// This file lives inside the `secure-exec-execution` crate so it is included in
// the published crate tarball; `build.rs` and `tests/pyodide_release.rs`
// `#[path]`-include it. It must not reference files outside the crate
// directory, or `cargo publish` verification fails (the tarball only contains
// in-crate files).

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

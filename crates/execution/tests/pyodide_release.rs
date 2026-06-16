#[path = "../../build-support/pyodide_release.rs"]
mod pyodide_release;

#[test]
fn secure_exec_release_cdn_env_name_is_stable() {
    assert_eq!(
        pyodide_release::SECURE_EXEC_RELEASE_CDN_ENV,
        "SECURE_EXEC_RELEASE_CDN"
    );
}

#[test]
fn pyodide_release_base_url_defaults_to_agent_os_github_release() {
    assert_eq!(
        pyodide_release::pyodide_release_base_url("1.2.3", None),
        "https://github.com/rivet-dev/agent-os/releases/download/v1.2.3"
    );
    assert_eq!(
        pyodide_release::pyodide_release_base_url("1.2.3", Some("  ")),
        "https://github.com/rivet-dev/agent-os/releases/download/v1.2.3"
    );
}

#[test]
fn pyodide_release_base_url_accepts_secure_exec_cdn_override() {
    assert_eq!(
        pyodide_release::pyodide_release_base_url(
            "1.2.3",
            Some(" https://cdn.example.com/secure-exec/v1.2.3/ "),
        ),
        "https://cdn.example.com/secure-exec/v1.2.3"
    );
}

#[test]
fn pyodide_release_asset_url_joins_without_duplicate_slashes() {
    assert_eq!(
        pyodide_release::pyodide_release_asset_url(
            "https://cdn.example.com/secure-exec/v1.2.3/",
            "pyodide.asm.wasm",
        ),
        "https://cdn.example.com/secure-exec/v1.2.3/pyodide.asm.wasm"
    );
}

use std::{env, fs, path::PathBuf};

// Stage the base filesystem fixture into OUT_DIR. In-tree builds use the
// canonical secure-exec package fixture from the current workspace; the
// published crate falls back to the vendored `assets/base-filesystem.json` copy.
fn main() {
    let manifest_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR must be set"));
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR must be set"));

    println!("cargo:rerun-if-changed=build.rs");
    generate_protocol(&manifest_dir, &out_dir);

    let workspace_fixtures = [
        manifest_dir.join("../../packages/secure-exec-core/fixtures/base-filesystem.json"),
        manifest_dir.join("../../packages/core/fixtures/base-filesystem.json"),
    ];
    let vendored = manifest_dir.join("assets/base-filesystem.json");
    let src = workspace_fixtures
        .into_iter()
        .find(|fixture| fixture.exists())
        .unwrap_or(vendored);

    println!("cargo:rerun-if-changed={}", src.display());

    let dest = out_dir.join("base-filesystem.json");
    fs::copy(&src, &dest).unwrap_or_else(|error| {
        panic!(
            "failed to stage base-filesystem.json from {} to {}: {}",
            src.display(),
            dest.display(),
            error
        )
    });
}

fn generate_protocol(manifest_dir: &std::path::Path, out_dir: &std::path::Path) {
    let source_schema = manifest_dir
        .join("protocol")
        .join("secure_exec_sidecar_v1.bare");
    println!("cargo:rerun-if-changed={}", source_schema.display());

    let schema_dir = out_dir.join("protocol-schema");
    fs::create_dir_all(&schema_dir).expect("failed to create generated protocol schema dir");
    fs::copy(&source_schema, schema_dir.join("v1.bare")).unwrap_or_else(|error| {
        panic!(
            "failed to stage protocol schema from {}: {}",
            source_schema.display(),
            error
        )
    });

    let cfg = vbare_compiler::Config::default();
    vbare_compiler::process_schemas_with_config(&schema_dir, &cfg)
        .expect("failed to generate sidecar protocol from BARE schema");
}

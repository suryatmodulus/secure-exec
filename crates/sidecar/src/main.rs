fn main() {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::ERROR)
        .init();
    if let Err(error) = secure_exec_sidecar::stdio::run() {
        tracing::error!(?error, "secure-exec-sidecar startup failed");
        std::process::exit(1);
    }
}

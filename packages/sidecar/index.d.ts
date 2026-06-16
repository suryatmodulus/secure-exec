/**
 * Resolve the absolute path to the prebuilt `secure-exec-sidecar` binary for
 * the current platform.
 *
 * Resolution priority:
 *   1. `SECURE_EXEC_SIDECAR_BIN` env var.
 *   2. A `secure-exec-sidecar` binary placed next to this package.
 *   3. The platform-specific `@secure-exec/sidecar-<platform>` package.
 *
 * @throws if the platform is unsupported or no binary can be found.
 */
export function getSidecarPath(): string;

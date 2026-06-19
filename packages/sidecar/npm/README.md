# @secure-exec/sidecar platform packages

These packages are release artifacts. Each package contains the
`secure-exec-sidecar` binary for one target. They are published by the release
workflow with `npm publish` so the executable bit is preserved.

The meta package `@secure-exec/sidecar` resolves the package for the current
platform at runtime.

# Browser ↔ Native Convergence — Hardening Spec

**Status:** PROPOSED (2026-06-22). Companion to `BROWSER-CONVERGENCE-ARCHITECTURE.md`.
**Source:** a four-lens adversarial architecture review (layering, transport/perf, parity,
simplicity) of the converged branch, with the load-bearing findings verified directly against the
code. The macro-architecture (real Rust kernel compiled to wasm + a SharedArrayBuffer synchronous
bridge, kernel as the single enforcement point) was judged correct and is **not** changed by this
spec. What follows closes the accidental complexity and the divergence surface *around* that core.

## Scope

In scope (this spec): **H1, H2, H4, H6, H7, H8** below.

> **IMPLEMENTATION STATUS (2026-06-22): all in-scope items DONE + verified on both backends.**
> - **H1** done — guest-worker `new Function()` permission eval deleted; predicates consumed only on
>   the trusted main thread; kernel is the sole fs/net enforcement point.
> - **H2** done — dead postMessage transport + `MessageFrameTransport` deleted.
> - **H4** done — `read_dir` carries dirent kind; the readDir/module-resolution N+1 lstat is gone.
> - **H7** done — `path`/`Buffer` generated from `node-stdlib-browser` + drift-gated; guest
>   `globalThis.Buffer` + `buffer` module shipped; module-resolution gate already executes both backends.
> - **H8** done — full POSIX errno table in the bridge + a shared browser `posixErrno` for kernel/fd
>   errors.
> - **H6** done **via the done-when's fail-loud branch**: the browser now FAILS LOUD on RSA-PSS
>   (`ERR_UNSUPPORTED_BROWSER_CRYPTO`) instead of silently downgrading to PKCS1, and the supported
>   asymmetric surface (RSA PKCS#1 v1.5 sign/verify, RSA-OAEP, ECDH) has cross-backend interop green via
>   the shared `crypto-basic-conformance.json` fixture (both backends assert the same vectors). **H6b
>   (the larger "route browser asymmetric through one shared RustCrypto-in-wasm implementation") is the
>   spec's other "or" branch and is NOT required by the done-when; left as a future enhancement** — it
>   would collapse the two asymmetric implementations into one and let the conformance fixture become a
>   true sign-here/verify-there matrix rather than fixed vectors.

Deferred (tracked, not specified here):
- **H3** Move the wasm kernel off the main thread into a dedicated kernel worker (perf/UX; large).
- **H5** Close the native env dead-caps (`AGENT_OS_LOOPBACK_EXEMPT_PORTS` / `AGENT_OS_ALLOWED_NODE_BUILTINS`
  re-emitted to env and read from env on native, while the browser reads them from the wire). Owned
  by the in-flight env-vs-wire migration in `crates/sidecar/CLAUDE.md`.

## Constraints (apply to every item)

- **Same-version lockstep, no compatibility.** The wire/config has no versioning. Change the BARE
  schema and all sides together; never add converters/fallbacks/negotiation.
- **Trust boundary is sidecar(TCB) ↔ executor(untrusted guest).** Client config (incl. the permission
  policy) is trusted input; the guest is the untrusted subject it binds. The kernel is the single,
  fail-closed enforcement point. A check that runs only in the guest worker is **not** a security
  control.
- **Agent-OS-agnostic**; `crates/vfs` stays generic; no per-npm-package special-casing; pure-JS
  builtins come from `node-stdlib-browser`; JS runtime config mirrors esbuild's vocabulary.
- **Present normal Linux semantics; fix the runtime, not the caller.**
- Work in the isolated jj workspace; commit each verified slice; run native + browser suites per item.

## Recommended sequencing

1. **H2** (delete dead transport) and **H1** (delete eval'd worker permissions) — the deletion batch;
   highest value-to-risk, both *remove* code/attack surface. H1 gated on its investigation step.
2. **H4** (read_dir name+kind) — self-contained wire change, kills the worst N+1.
3. **H7** (path/Buffer from upstream + guest `buffer` + real resolution gate) — npm-compat + drift.
4. **H8** (structured errno across the bridge) — touches kernel error plumbing.
5. **H6** (crypto parity) — largest; phased; do last so the differential-test harness lands on a
   stable base.

---

## H1 — Delete the `new Function()`-eval'd permission layer in the guest worker

**Severity:** architectural (security-hygiene). **Effort:** M (gated on investigation).

### Problem (verified)
The converged spawn path serializes permission predicates to source strings and reconstructs them
*inside the untrusted guest worker* via `new Function`:
- `packages/browser/src/runtime-driver.ts:134-145` `serializePermissions` → `:473` puts them in the
  spawn payload.
- `packages/browser/src/worker.ts:1159-1185` `revivePermission`/`revivePermissions`
  (`new Function("return (" + source + ");")()` at `:1168`), called on the main bootstrap path at
  `:1849`.
- The revived JS functions gate fs/network via `wrapFileSystem`/`wrapNetworkAdapter`
  (`packages/browser/src/runtime.ts:365-471`), guarded by a regex denylist
  (`permission-validation.ts`).

The kernel already enforces the declarative policy (`crates/sidecar-core/src/permissions.rs`
`permissions_from_policy` → kernel closures; `EACCES` surfaced at
`packages/browser/src/converged-driver-setup.ts:106-114`). A permission check that runs only in the
guest's own isolate is bypassable by the guest and therefore provides **no enforcement** — it is at
best redundant, at worst security theater plus an `eval` of input inside the adversary's isolate.

### Open question to resolve FIRST (blocks the fix)
Does any capability rely on the worker-side *function* permissions that the kernel never sees? Two
mechanisms coexist: the declarative `CreateVmConfig.permissions` policy (kernel-enforced) and the
callback-style `RuntimeDriverOptions.system.permissions` (worker-only). Determine whether the
callback form is (a) vestigial, (b) always derivable from / mirrored by the declarative policy, or
(c) a distinct supported input. If (c), the kernel does not currently enforce it — deleting the
worker layer would *drop* those permissions, so the callback form must first be expressed as
declarative policy that flows to the kernel (or removed from the public API).

### Fix
1. Confirm the converged path sends the full declarative policy to the kernel via `CreateVmConfig`
   (it does for `create_vm`; verify fs/network/childProcess/env domains are all represented).
2. Delete `revivePermission`/`revivePermissions` (`worker.ts:1159-1185, 1849`),
   `permission-validation.ts`, and the permission gating in `wrapFileSystem`/`wrapNetworkAdapter`
   (`runtime.ts:365-471`) — keep any non-permission wrapping those functions also do, if any.
3. Remove `serializePermissions`/`serialize(permissions.*)` of callbacks from
   `runtime-driver.ts:134-145, 473`. The browser client API should accept only declarative policy
   (the esbuild-style config), not JS predicates.
4. Net: ~250 lines, one `eval`, and a denylist removed; "one enforcement point" becomes literal.

### Tests
- A guest that overwrites/deletes the (now-absent) JS permission wrappers is still denied by the
  kernel (`EACCES`) — add a Playwright case that tampers and asserts denial.
- A policy that denies an fs read / network connect returns `EACCES` from the kernel on the converged
  path (extend the existing default-deny + `deniedFsReads` cases).
- `tsc` + vitest + the converged Playwright suite green; grep proves no remaining `new Function` in
  `packages/browser/src`.

### Risk
Medium, entirely in the open-question above. If the callback form is load-bearing and not mirrored
to the kernel, this becomes "add declarative coverage, then delete," not a pure deletion.

---

## H2 — Delete the dead second browser transport

**Severity:** debt (high). **Effort:** S.

### Problem (verified)
Two transports exist over the same wasm ABI. The inline synchronous `pushFrame`/SAB path is the only
production path (`runtime-driver.ts:633-637` throws without it; exported from `index.ts`). The
worker/postMessage variant is orphaned scaffolding from the pre-"converged-only" design: not exported
from `index.ts`, not instantiated by any production consumer, referenced only by its own unit tests
and `./internal/*` subpath exports nothing imports. Files:
`packages/browser/src/sidecar-worker.ts`, `worker-sidecar-client.ts`, `sidecar-worker-protocol.ts`,
`sidecar-wasm-module.ts`. Its tail: `worker-sidecar-client.ts` is the only live consumer of
`packages/core/src/message-frame-transport.ts`.

### Fix
1. Delete the four browser files above and their tests.
2. Remove the `./internal/*` exports in `packages/browser/package.json` and any
   `buildWorker("sidecar-worker.js")` / serve entries in the browser scripts.
3. Re-evaluate `packages/core/src/message-frame-transport.ts` + its core `package.json` export + test:
   if nothing else consumes it, delete it too. **Keep** `SidecarProtocolClient` /
   `SidecarProcessTransport` / `native-client.ts` (they back the native client).

### Tests
`pnpm --dir packages/browser build` + `pnpm --dir packages/core build` green; grep proves no
production import of the deleted modules; the converged Playwright + vitest suites unaffected.

### Risk
Low. Pure deletion; the only diligence is confirming no production import (verified: none today).

---

## H4 — `read_dir` returns dirent kind in one call (kill the readDir N+1)

**Severity:** perf-debt. **Effort:** M.

### Problem (verified)
`packages/browser/src/converged-sync-bridge-handler.ts:170-190` services `fs.readDir` by fetching
names, then issuing one **blocking** `lstat` per entry to recover Dirent types the wire `read_dir`
result does not carry. A 1000-entry directory = 1001 synchronous kernel round-trips on the guest's
critical path. The kernel already has the inode types (`crates/sidecar-browser/src/wasm.rs:223-236`
models `DirectoryEntry { name, kind }`); the type is simply not surfaced on the wire `read_dir`
result.

### Fix (kernel-side response-shape change — the correct altitude)
1. BARE schema (`crates/sidecar-protocol/protocol/secure_exec_sidecar_v1.bare`): give the
   `guest_filesystem_result` `entries` a typed shape carrying `name` + `is_directory` +
   `is_symbolic_link` (a `GuestDirEntry` struct list), or add a parallel `dirents` field. Regenerate
   Rust + TS (`build:protocol`); update `protocol-maps.ts`.
2. `crates/sidecar-core/src/guest_fs.rs` `ReadDir`: populate the kind from
   `kernel.read_dir(...)` (which already yields `VirtualDirEntry` with directory/symlink flags).
3. `packages/browser/src/converged-fs-bridge.ts`: map the typed entries straight to `VirtualDirEntry`
   (reuse `wireStatToDirEntry`'s fields).
4. `packages/browser/src/converged-sync-bridge-handler.ts:170-190`: delete the per-entry `lstat`
   loop; `readDir` is now a single round-trip.
5. `packages/browser/src/worker.ts` `readdirSync({ withFileTypes })`: consume the typed entries.

### Tests
- `readdirSync(dir, { withFileTypes: true })` returns correct `isDirectory()`/`isSymbolicLink()` for
  files, dirs, and symlinks in **one** wire call — assert on both backends (native `wasm.rs` / sidecar
  service test + browser Playwright/vitest).
- A unit test on `converged-fs-bridge` for the new typed mapping.
- Confirm native `read_dir` consumers still compile (the wire shape changed).

### Risk
Low-medium. Wire shape change is allowed (lockstep). Ensure every `read_dir` consumer (native sidecar,
Rust client) is updated in the same change.

---

## H6 — Converge asymmetric crypto (stop the three-implementation fork)

**Severity:** parity-landmine. **Effort:** L (phased).

### Problem (verified)
Guest-visible `node:crypto` asymmetric is implemented independently per backend:
- **Native:** OpenSSL via Rust (`crates/sidecar/src/execution.rs` `crypto.*` handlers).
- **Browser:** a JS reimplementation — hand-written BigInt `modPow`/Miller-Rabin/Montgomery in
  `packages/browser/src/runtime.ts` (7 such sites; crypto block ~`:1667`) plus `@noble/*` primitives
  wired through worker globals.
Verified gaps: **PSS is absent** in the browser (no `pss`/`RSA_PKCS1_PSS` in `runtime.ts`); RSA-OAEP
routes through an op (`_cryptoAsymmetricOp`) only ever *defined* as `unsupported` in the legacy worker,
so on the converged path it likely throws while native succeeds. There is **no `rsa`/`p256`/`x25519`
Rust crate in the workspace** (`Cargo.lock`), confirming there is no shared RustCrypto asymmetric
implementation today. Symmetric AES is *also* two impls in practice (native `crates/sidecar/src/
crypto_cipher.rs` RustCrypto vs browser `@noble`), though both are conformance-green. The whole
asymmetric surface is guarded by `tests/fixtures/crypto-basic-conformance.json` — ~1 RSA, ~1 ECDH, ~1
DH case, each backend self-checking against baked-in constants, **zero cross-backend interop**.

### Key enabling insight
The V8 crash that forced *native* asymmetric back to OpenSSL (decisions log #8 in the architecture
doc: `WasmCodePointerTable` SEGV on the second in-process `Isolate::New` after linking the RustCrypto
asymmetric stack) is a **native linker / in-process-V8 interaction**. It does **not** apply to the
browser: the browser never links Rust crypto into the V8 that runs the isolate; the wasm kernel is a
separate module and browser isolates are Chromium-created, one per worker. **So the browser can run a
RustCrypto-in-wasm asymmetric stack that native cannot.** That collapses three implementations toward
two, and lets the two be differential-tested against each other instead of against hand-rolled
constants.

### Fix (phased)
- **H6a — Fail loud, now (S).** Audit the browser asymmetric surface; any op native supports that the
  browser does not faithfully implement (PSS; RSA-OAEP if `_cryptoAsymmetricOp` is undefined) must
  throw a clear `ERR_UNSUPPORTED_BROWSER_CRYPTO`-style error, never silently diverge or return wrong
  output. Add negative tests.
- **H6b — Shared RustCrypto crypto over the bridge (L).** Add a shared, host-free crypto module
  (RustCrypto: `rsa`, `p256`/`elliptic-curve`, `x25519-dalek`, `sha2`, etc.) in `crates/sidecar-core`
  (or a new `crates/secure-exec-crypto` it re-exports), reachable from the wasm kernel. Reuse the
  existing `crates/sidecar/src/crypto_cipher.rs` AES (move it to the shared crate so both backends
  share one symmetric source too). Expose crypto as `crypto.*` `guest_kernel_call` ops (same pattern
  as net/dns). Route the **browser** `node:crypto` asymmetric (and AES) through the kernel; delete the
  hand-written BigInt + noble asymmetric in `runtime.ts`/`worker.ts`. **Native keeps OpenSSL for
  asymmetric** (V8-link constraint) and `crypto_cipher.rs` for AES. End state: browser crypto = one
  Rust source in wasm; native asymmetric = OpenSSL; both AES = the shared RustCrypto module.
- **H6c — Differential conformance (M).** Replace the self-check fixture with a **cross-backend interop
  matrix**: sign-on-native / verify-on-browser and vice versa; encrypt/decrypt across backends. Expand
  vectors to PSS, OAEP (multiple hashes/labels/MGF1), RSA-2048/3072/4096, all signing hashes
  (SHA-256/384/512), ECDH on secp256r1/384r1/521r1/256k1, x25519, and classic DH. Gate in CI via the
  existing `check-crypto-conformance.mjs` harness, extended to run vectors through both backends and
  diff.

### Tests
The H6c matrix is the test. Plus per-phase: H6a negative tests; H6b a browser Playwright crypto suite
that now exercises the kernel-backed path (digest/hmac/pbkdf2/scrypt/random already pass; add
RSA/ECDH/x25519 going through the bridge).

### Risk / open questions
- Per-op bridge round-trip cost for crypto: acceptable (crypto is not a hot syscall loop; correctness
  > a few microseconds). Measure keygen, which is heavier.
- Wasm binary size growth from the RustCrypto stack — measure; it ships once.
- Confirm RustCrypto covers every algorithm the guest surface exposes before deleting the JS impls
  (especially DH groups and prime generation); keep H6a fail-loud for any not yet covered.

---

## H7 — Single-source `path`/`Buffer` (WASI model) + ship the guest `buffer` module

**Severity:** debt (npm-compat landmine). **Effort:** M.

### Problem (verified)
WASI is the reference pattern: one shared source (`crates/execution/assets/runners/wasi-module.js`),
a `__agentOsWasiHost` seam, the browser file generated by `generate-wasi-polyfill.mjs`, and
`check-wasi-surface.mjs` gating byte-staleness + import-surface drift. `path`, `Buffer`, and module
resolution do **not** get this treatment:
- **`path`** — native uses real `node:path`; browser uses a hand-written POSIX module embedded in
  `runtime.ts` `POLYFILL_CODE_MAP` (~`:1041`, comment: "Minimal but correct"). No fixture, no drift
  gate. Edge cases (trailing-slash `basename`, `..` above root, `parse`/`format` round-trips,
  empty-segments) are where a hand reimplementation drifts.
- **`Buffer`** — native uses real `node:buffer`; the only browser `Buffer` is the WASI runner's
  *internal* `Uint8Array`-subclass shim (`wasi-polyfill.ts`), implementing a small subset and with a
  wrong `isBuffer` (true for any `Uint8Array`). **There is no `node:buffer`/`buffer` entry in
  `POLYFILL_CODE_MAP` and no `globalThis.Buffer` exposed to general guest code** — so npm packages
  that touch `Buffer` (a large fraction of the ecosystem) work on native and fail on the converged
  browser, violating "npm packages must work unmodified."
- **`util`** is already done right (generated from `node-stdlib-browser` via
  `build-browser-util-polyfill.mjs`) — the model to copy.
- **Module resolution** is forked (native Rust vs browser TS) and the gate
  (`check-module-resolution-conformance.mjs`) only asserts both test files *reference* the fixture; it
  does not execute resolution on both backends.

### Fix
1. **`path`:** source from `node-stdlib-browser`'s `path-browserify` (esbuild-bundled like `util`),
   emit `packages/browser/src/generated/path-polyfill.ts`, wire it into `POLYFILL_CODE_MAP`
   (`path` + `node:path`, with `path === path.posix` per Linux semantics), delete the hand-written
   module. Add `scripts/check-path-surface.mjs` (byte-staleness + method-surface). Extend the
   host-vs-guest `builtin_conformance` harness with full `path` cases (normalize/resolve/join/relative/
   parse/format/dirname/basename/extname edge cases).
2. **`Buffer`:** ship the real `buffer` package as a guest polyfill (`buffer` + `node:buffer` in
   `POLYFILL_CODE_MAP`) and expose `globalThis.Buffer` early on the converged browser, matching native
   (`v8-bridge.source.js:~31`). Fix `isBuffer`. Have the WASI runner's internal shim defer to the real
   guest `Buffer` when present. Add `scripts/check-buffer-surface.mjs` + full `buffer` conformance
   cases (write/read*Int*, fill, compare, equals, indexOf, swap*, latin1/ucs2/base64url encodings).
3. **Module-resolution gate:** make `check-module-resolution-conformance.mjs` actually execute the
   fixture's scenarios through **both** backends end-to-end and diff (ancestor `node_modules` walk,
   `exports`/`imports`/conditions ordering, `realpath`/symlink following, scoped/self-reference). Keep
   two impls for now; longer-term, compile the Rust resolver to wasm and share it (it's pure logic
   over the already-shared VFS) — tracked, not required by this item.
4. Register all new generated artifacts in `scripts/check-generated-artifacts.mjs`.

### Tests
The new `check-*-surface` gates + extended `builtin_conformance` host-vs-guest cases; a browser
Playwright test that `require("buffer")` and a representative npm package using `Buffer` both work; the
real two-backend resolution diff.

### Risk
Low-medium. Using real upstream libraries reduces surface risk; the work is wiring + gating. Watch
bundle-size from `buffer`/`path-browserify` (small).

---

## H8 — Structured errno across the bridge

**Severity:** debt (escalation risk). **Effort:** M.

### Problem (verified)
Backend errors are normalized to Node-style `{code, errno, syscall, path, message}` by
**string-matching** the message in the shared bundle (`crates/execution/assets/v8-bridge.source.js`
`createFsError`/`bridgeErrorCode`, ~`:6258`). Two issues: (a) only 5 codes get a real `errno` number
(`ENOENT/-2`, `EACCES/-13`, `EBADF/-9`, `EMFILE/-24`, `EXDEV/-18`); everything else (`EEXIST`,
`EROFS`, `ENOTDIR`, `EISDIR`, `ENOTEMPTY`, …) gets `errno: -1`, wrong vs. real Node on both backends;
(b) classification is heuristic (`msg.includes("entry not found")`), so any error the two kernels
phrase differently, or any errno outside the hardcoded ladder, falls through to the raw message and
*can* diverge. The two kernels are the same Rust code so messages likely match today, but it is
load-bearing and unguarded.

### Fix
1. Have the kernel carry a **structured errno** across the bridge: add a numeric/enum errno field to
   the guest filesystem (and kernel-call) error path in the wire/bridge result, sourced from the
   kernel's own error type, instead of relying on JS regex classification.
2. Give `createFsError` the **full POSIX errno number table** so guest `err.errno` matches real Node
   for every code, keyed off the structured field (fall back to the string heuristic only if absent).
3. Thread the errno through both shells (native `crates/sidecar` error mapping already sniffs an
   `ECODE:` prefix — replace the prefix-sniff with the structured field).

### Tests
A conformance fixture asserting `{code, errno, syscall, message}` for every fs error path (ENOENT,
EACCES, EEXIST, EROFS, ENOTDIR, EISDIR, ENOTEMPTY, EBADF, EXDEV, EMFILE, …) on **both** backends
against host Node values; gate in CI.

### Risk
Medium. Touches the kernel error type, the wire result shape, and both shells' error mapping — do it
as one lockstep change. Verify no consumer depends on the old `errno: -1` behavior.

---

## Done-when (this spec)

- H1: no `new Function` in `packages/browser/src`; tampering test denied by kernel; policy denial
  returns `EACCES`; suites green.
- H2: dead transport files + `./internal/*` exports gone; builds + suites green; no production import.
- H4: `readdir({withFileTypes})` correct in one wire round-trip on both backends.
- H6: browser asymmetric routed through shared RustCrypto-in-wasm (or fails loud where unsupported);
  cross-backend interop matrix green in CI.
- H7: `path`/`Buffer` generated from upstream + drift-gated; `globalThis.Buffer` + `buffer` module on
  the converged browser; resolution gate executes both backends.
- H8: structured errno across the bridge; full-errno conformance fixture green on both backends.

Each item lands as its own verified, committed slice with native + browser suites green.

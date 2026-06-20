# Rebase Spec: browser-convergence WIP onto upstream main (both repos)

Status: NOT STARTED. Strategy approved: **squash + rebase** (jj), **secure-exec first, then agent-os-web**.
This spec is executable end-to-end. Do NOT stop after secure-exec; the goal is met only when BOTH repos
pass their acceptance gates (Section 7) on this host.

## 0. Facts (verified 2026-06-27)

| Repo | Workspace path | merge-base | upstream tip | WIP `@` | WIP commits | upstream commits | overlap files |
|---|---|---|---|---|---|---|---|
| secure-exec | `/home/nathan/secure-exec-convwasi` | `uxmvsnqx` (#117) | bookmark `main` = `qsyppyxx` (#138) | `ynkuxrlz` | 136 | 27 | 48 |
| agent-os-web | `/home/nathan/agent-os-web` | `rxnstpkn` | `main@origin` | `kptqpzqn` | 66 | 33 | 21 |

Decisions locked in:
- **Squash** each epic to one working commit, then `jj rebase` it onto the new base. (jj propagates a conflict
  resolution to descendants, so one commit = resolve-each-conflict-once. We can `jj split` it back into reviewable
  pieces AFTER conflicts are settled.)
- **Conflicts of "same feature built twice" or "upstream improvement": TAKE UPSTREAM**, re-point WIP callers.
- **Re-apply (never drop) all upstream improvements.**
- **Re-home** WIP's browser-pi adapter onto secure-exec's relocated registry; discard WIP's in-repo `registry/` edits.
- **Rename `tool` -> `binding`** (permission scope only); verify no permission-context `tool`/`toolkit` stragglers.
- Cross-repo deps stay **local `link:`** -> `../secure-exec-convwasi`; adopt upstream's registry-in-sibling layout.
  Nothing here is pushable (convwasi is unreleased).

## 1. Safety / working-copy discipline

- Operate ONLY in `/home/nathan/secure-exec-convwasi` (rebase #1) and `/home/nathan/agent-os-web` (rebase #2).
  Both are isolated jj workspaces; do not touch the shared default `/home/nathan/secure-exec` or other workspaces.
- Before each rebase: `jj op log` checkpoint. Every step is reversible via `jj undo` / `jj op restore`.
- If something looks lost: recover via op-log, never rebuild from scratch.
- Large pyodide/sandbox assets: commit with `jj --config snapshot.max-new-file-size=16777216 ...` if needed.

## 2. Gate 0 — capture BASELINE before touching anything (REQUIRED)

The acceptance bar is **delta vs baseline**, not absolute green (R4 and some env gates are already red).
Run the full suite on BOTH current `@` heads and save pass/fail + logs to
`/home/nathan/progress/secure-exec/2026-06-27-rebase-onto-main/` as artifacts.

Baseline commands (capture exit codes + logs):
- secure-exec: `pnpm install`; `cargo build --workspace`; `cargo test --workspace`; `pnpm run check-generated`;
  `make -C registry/native wasm` (record whether it builds clean today).
- agent-os-web: `pnpm install`; TS build; `cargo build`; test suites; the browser-wasm gates (converged-runtime,
  async-echo, pi-boot, real-terminal R3, pi-tui R5) via the existing verify CLIs.
- Record which gates are ALREADY RED at baseline (expected: R4 on-device model). Those are not rebase regressions.

## 3. Rebase #1 — secure-exec (convwasi)

### 3a. Squash + rebase
1. `jj op log` checkpoint.
2. Squash the 136-commit stack (`uxmvsnqx`..`@`) into one working commit.
3. `jj rebase` that commit onto `main` (#138). Resolve textual conflicts once.

### 3b. Semantic reconciliation sites (the hard ones)
1. **Protocol crate move.** WIP relocated `crates/sidecar/protocol/*` -> `crates/sidecar-protocol/` (generator-driven)
   and added `GuestKernelCallRequest`/`GuestDirEntry`/`GuestKernelResultResponse`. Upstream added
   `ResizePtyRequest`/`PtyResizedResponse` to the OLD `.bare`+`protocol.rs`. **Hand-port upstream's PTY-resize op into
   the new crate's `.bare` union** (both op-sets coexist; strict same-version lockstep, NO version field). Also carry
   upstream's `wire.rs` `DEFAULT_MAX_FRAME_BYTES` 1MiB->16MiB into the new location.
2. **`loopback_exempt_ports` (kernel.rs + socket enforcement).** Both sides added the same field + connect/sendto
   checks. **TAKE UPSTREAM**, delete WIP's field/methods, re-point WIP callers
   (`set_permissions`/`set_/extend_loopback_exempt_ports`).
3. **WASI runner extraction.** WIP moved `NODE_WASM_RUNNER_SOURCE` out of `node_import_cache.rs` (-5047) into
   `crates/execution/assets/runners/wasi-module.js`. Upstream edited that inline source
   (`WASI_FDFLAGS_NONBLOCK`, `proc_spawn` status writes). **Port upstream's edits into `wasi-module.js`.**
4. **Crypto/time swap.** WIP: `openssl`->`sha2`/RustCrypto (`snapshot.rs`, `bridge.rs` `EMULATED_OPENSSL_VERSION`),
   `std::time`->`web_time`, `hickory_resolver::proto`->`hickory_proto`. Upstream's new `snapshot.rs` still calls
   `openssl::sha::sha256`. **Reconcile those call sites to `sha2`; verify Cargo.toml deps; grep for residual
   `openssl`/`hickory_resolver`.**
5. **Bridge-fn registry.** WIP turned static `SYNC/ASYNC_BRIDGE_FNS` arrays into `sync_bridge_fns()`/`async_bridge_fns()`
   partition fns (`session.rs`). Upstream added `_kernelIsattyRaw`/`_kernelTtySizeRaw` tty bridge fns +
   `reset_pending_promises` teardown + a userland-snapshot surface referencing the old arrays. **Land upstream's new
   fns into WIP's partition API.**
6. **`limits-inventory.json`.** Union overlapping heap-cap keys + upstream's `MAX_STDOUT_FRAME_QUEUE`/`MAX_TIMER`;
   dedupe by `name`; re-run `limits_audit`.
7. **kernel pty.rs.** Keep BOTH upstream EOF-on-empty-line (`input_eof_pending`) and WIP control-char echo; they overlap
   in the `process_control_char`/icanon region.
8. **kernel seams.** Confirm WIP's runner routes through upstream's new `pwrite_file`/`read_dir_with_types` rather than
   a parallel WIP seam.

### 3c. Regenerate derived assets (do NOT hand-merge these)
Order matters — resolve SOURCES by hand first, then:
```
cd /home/nathan/secure-exec-convwasi
# sources hand-resolved: the merged .bare, v8-bridge.source.js, bridge-contract.json, build-v8-bridge.mjs,
#   packages/core/src/{request,response}-payloads.ts, index.ts, sidecar-process.ts, package.json, scripts/ci.sh
pnpm install                                                   # relock pnpm-lock.yaml
pnpm --dir packages/build-tools build:protocol                # -> packages/core/src/generated-protocol.ts
node packages/build-tools/scripts/build-v8-bridge.mjs
node packages/build-tools/scripts/build-v8-bridge.mjs --out-dir crates/v8-runtime/assets/generated
cargo build --workspace                                        # relock Cargo.lock
make -C registry/native wasm                                   # rebuild WASM command set (REQUIRED per decision #2)
pnpm run check-generated                                       # drift gate -> must be clean
```

### 3d. Verify (secure-exec acceptance — Section 7 A1..A5)

## 4. Rebase #2 — agent-os-web (only after secure-exec is green)

### 4a. Squash 66 -> one commit; `jj rebase` onto `main@origin`.

### 4b. Semantic reconciliation
1. **`tool` -> `binding`.** Rename the permission scope field everywhere (`PatternPermissions.tool`, `tool:` permission
   entries, `.tool` access) incl. `crates/client/src/agent_os.rs`, `tests/os_instructions_e2e.rs`, `config.rs`. A clean
   `cargo build` proves completeness. Then grep-verify ZERO permission-context `tool`/`toolkit` remain (leave genuine
   ACP/agent tool-calling terms alone).
2. **registry/ deleted upstream (#1528).** Re-home WIP's browser-pi adapter changes (`__piSdkModules` bundled-runtime
   override, `process.chdir` try/catch) onto secure-exec's relocated `registry/agent/pi`. Discard WIP's in-repo
   `registry/` edits.
3. **`scripts/secure-exec-dep.mjs`.** Take upstream's `prepare-build`/`secure-exec-sha` + `AGENT_PACKAGE_SUBPATHS` +
   `siblingProvides()`; re-apply WIP's `SECURE_EXEC_LOCAL_PATH` env override + `@secure-exec/browser`; keep links ->
   `../secure-exec-convwasi`. Adopt the registry-in-sibling layout.
4. **`driver.ts` deleted by WIP / upstream injectable-fetch + F-008.** Verify the converged network adapter still forces
   `credentials:'omit'` and has equivalent coverage (the deleted `network-credentials.test.ts`).
5. **`agent_os.rs` match arms.** Merge WIP's new `GuestKernelResultResponse` arms with upstream's ACP leak-fix region
   (`output_tasks`/`abort_tracked_task`, `snapshot_userland_code: None`).
6. **`agentos-worker.js`.** Generated — do NOT hand-merge. Take WIP's bundle, fix `tool`->`binding` in source, then
   rebuild via `build-worker.ts`.

### 4c. Relock + rebuild: `pnpm install`; rebuild worker bundle; regenerate anything drift-checked.

### 4d. Verify (agent-os-web acceptance — Section 7 B1..B6, C1).

## 5. Out of scope / known-red (NOT blockers)
- **R4** Chrome on-device `LanguageModel` — cannot provision on this host (see memory `real-terminal-r4-model-blocker`).
  Stays RED; documented; does not block sign-off.
- Anything requiring push/release — local-dev only.

## 6. Validation scope (decided)
- Run the FULL suite on THIS host, **including the browser/Chromium gates** (not deferred to CI).
- **WASM command rebuild (`make -C registry/native wasm`) is REQUIRED.**
- R4 staying red is acceptable.

## 7. Acceptance criteria (the completion bar)

Baseline-delta: everything green at Gate-0 stays green; newly-arrived upstream tests pass.

secure-exec:
- A1 `cargo build --workspace` clean.
- A2 `cargo test --workspace` no regression; specifically `architecture_guards` + `limits_audit` (CLAUDE.md gates),
  `builtin_conformance`, sidecar `service`, kernel `pty`, execution `module_resolution`/`wasm`.
- A3 `pnpm run check-generated` drift-clean.
- A4 "upstream survived": PTY-resize / WASI nonblock+proc_spawn / Pyodide python-CLI tests present and green.
- A5 reconciliation review: each semantic site (3b.1..3b.8) diffed against BOTH parents to confirm both intents present
  (e.g. protocol union has PTY-resize AND GuestKernel ops).
- `make -C registry/native wasm` builds the command set clean.

agent-os-web:
- B1 TS build + `cargo build` clean (clean Rust build = `tool`->`binding` complete).
- B2 test suites no-regression vs baseline.
- B3 grep proves zero permission-context `tool`/`toolkit` stragglers.
- B4 `agentos-worker.js` rebuilt, drift-clean.
- B5 browser-wasm gates green vs baseline: converged-runtime, async-echo, pi-boot, real-terminal R3, pi-tui R5.
  R4 stays RED (documented).
- B6 F-008 `credentials:'omit'` coverage exists post-restructure.

cross-repo:
- C1 agent-os-web linked to the rebased convwasi boots the real-terminal + pi-in-browser flow (existing verify gate),
  green vs baseline.

## 8. Progress
Track in `/home/nathan/progress/secure-exec/2026-06-27-rebase-onto-main/progress.html` (TODO+ETA on top, reverse-chron
log below, artifacts saved per step). Update after every meaningful step, not just at the end.

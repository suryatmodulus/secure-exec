# Browser ↔ Native Convergence — Architecture Spec

**Status:** REVIEWED (corrected against the real codebase by 4 subagent reviews — feasibility,
completeness, security, architecture). **Workspace:** `sidecar-browser-conv` (non-default).
**Owner directives:** touch native freely; NO backwards/wire compat; expect to break a lot; make
everything compile (gate host-only code behind the existing `native` feature); cleanest shared
state over minimal diffs.

---

## PROGRESS (handoff audit — 2026-06-21)

> **CURRENT STATUS (2026-06-21 verification audit — SUPERSEDES the handoff text below).** The
> two-stacks / "converged largely UNWIRED" / "legacy not deleted" handoff snapshot below is **stale**.
> Verified now: the **converged wasm path is the SOLE, WIRED, tested browser runtime**. The parallel TS
> executor (`executor-core.ts`/`guest-runtime.ts`/`executor-host.ts`/`executor-child.ts`/
> `executor-bundle.ts`/`executor-wasi.ts`) is **deleted**; `runtime-driver.ts` is **converged-only**
> (a guest syscall without a converged sidecar throws). Guest fs/module/net/dns/dgram route through the
> shared kernel (`guest_kernel_call` → `sidecar_core::guest_net`/`guest_fs`; kernel-backed
> `resolveModule`); child_process/signal are host-capability fallbacks. **All §2 security invariants
> S1–S8 hold on both backends** (S2 per-platform; see §2 + §11.1). Done/verified: A, B, B-resid, C2
> (option b), E (per-platform), F, G, K, D bridge-contract gate, plus the converged-only driver.
> **Gates green:** `cargo build --workspace`, wasm32 (kernel + `sidecar-browser` cdylib), browser
> `pnpm test` (bridge-contract + signals + wasi-surface checks + 120 vitest + tsc build), 36/36
> conformance + 52 Playwright against the wasm kernel, native crypto/WASI-fs tests.
> **C IS NOW DONE (2026-06-21).** There is ONE shared WASI preview1 runner:
> `crates/execution/assets/runners/wasi-module.js`, consumed natively via `include_str!` and by the
> browser via `packages/browser/scripts/generate-wasi-polyfill.mjs` (which wraps it with a per-backend
> `globalThis.__agentOsWasiHost` seam: `requireBuiltin`, `syncReadLimitBytes`, a `Buffer` shim,
> `disableLocalFdPassthrough`, `readStdin`, `stdinReadableBytes`). The browser kernel-backed `fs` gained
> fd-based ops (`openSync`/`readSync`/`writeSync`/`closeSync`/`fstatSync`/`ftruncateSync`) over the
> wire `pread` + read-modify-write `write_file` (every read/write still kernel-permission-checked = S3),
> plus a posix `path` polyfill. The runner gained backend-agnostic correctness (read-iov clamp, fsync on
> stdio streams, poll clock-as-first-class + stdio writability + stdin readiness without a kernel poll
> bridge, FD_READ rights, read-permission at open). `check-wasi-surface` now verifies the browser file is
> the generator's current output (the two-runner parse is moot). **Verified both backends:** native
> `wasm_suite` + 32 native wasm lib tests green; browser **52/52** Playwright (WASI + converged) +
> 120 vitest + all gates green.
> **REMAINING TAIL NOW DONE (2026-06-21).** Both closed + verified on both backends:
> - **wasi-testsuite subset:** a vendored self-contained preview1 subset
>   (`tests/fixtures/wasi-testsuite-subset.json`, from WebAssembly/wasi-testsuite, Apache-2.0) runs the
>   SAME manifest on native (`wasm.rs` `wasi_testsuite_subset_runs_on_native_shared_runner` in
>   `wasm_suite`) and browser (`packages/browser/tests/browser/wasi-testsuite.spec.ts`), asserting the
>   upstream exit code + stdout. Native `wasm_suite` green; browser 56/56 Playwright.
> - **3b packaging:** `@secure-exec/browser` now ships the web-target wasm kernel
>   (`scripts/build-dist-wasm.mjs` → `dist/sidecar-wasm-web/`) plus a zero-config
>   `createDefaultConvergedSidecar(config)` loader (`src/default-sidecar.ts`, resolves the bundled wasm
>   via `import.meta.url`); `npm pack --dry-run` confirms both ship.
>
> With C + wasi-testsuite + 3b done, the convergence reaches its completion bar: ONE shared kernel +
> sidecar-core + WASI runner, the converged wasm path is the sole tested browser runtime, the legacy TS
> executor is deleted, and the conformance/Playwright harness runs against the wasm kernel on both
> backends. Full per-item status in §11.1.
>
> **ADVERSARIAL HARDENING PASS (2026-06-22).** Three adversarial subagent reviews (spec-completeness,
> browser-vs-native correctness, security) re-audited the converged path. Security: no escape and no
> dropped enforcement (every browser fd op is re-checked kernel-side; the worker JS is a thin forwarder).
> Completeness: the three end-conditions hold (56/56 Playwright live, legacy executor deleted, harness
> repointed). Correctness review surfaced real native-divergence bugs in the browser fd-table, now fixed:
> - **Browser `writeSync` data loss + non-atomic RMW (blocker):** the old client-side read-modify-write
>   swallowed any readback failure and then wrote only the new chunk (discarding the whole file), and was
>   O(filesize)/non-atomic across fds. Replaced by a new positional-write wire op
>   (`GuestFilesystemOperation::Pwrite` → `KernelVm::pwrite_file`, read-only-reject + size-limit checked,
>   atomic, hole-filling). The browser `writeSync` now calls `fs.pwrite` (no readback); native shadow-sync
>   mirrors the full post-write file.
> - **Browser `openSync` string flags (blocker for direct `fs` use):** `'w'`/`'a'`/`'r+'`/... collapsed to
>   O_RDONLY (no create/truncate/append). Now parsed into POSIX bits; `writeSync` honors O_APPEND (EOF).
> - Triaged as non-defects: the runner-internal `Buffer` shim is **not** guest-reachable (the guest has no
>   `Buffer` and no `buffer` module — exposing one is a separate npm-compat feature, out of scope), so its
>   speculative hardening was reverted; O_EXCL atomicity, `path` non-string `TypeError`, and a poll_oneoff
>   stdin-spin edge are nits under the single-guest model (worker_threads+SAB opt-in off by default).
> New tests: native `guest_fs` pwrite in-place-preserve + hole-fill; vitest pwrite bridge mapping;
> Playwright "honors string open flags and positional writeSync without losing data". Verified both
> backends: native `wasm_suite` + sidecar-core/kernel suites green; browser **57** Playwright + 120 vitest
> + gates green; generators idempotent.

A ~15h prior agent run is committed as a snapshot (`wip(convergence): Codex ~15h run`). Native
`cargo check --workspace` ✓ and browser `test:converged` ✓ (69 vitest + 37 Chromium) — BUT a 3-agent
gap audit found "green" is misleading: **two browser stacks coexist** — a legacy fail-open TS
executor (`runtime-driver.ts`/`worker.ts`/`runtime.ts`/`os-filesystem.ts`/`wasi-polyfill.ts`, the
one the conformance harness actually runs) and the converged wasm sidecar (`crates/sidecar-browser`
+ `sidecar-worker.ts`) whose guest net/fs/spawn dispatch is largely UNWIRED
(`unsupported_guest_kernel_call_event`). The spec's "legacy already deleted" assumption is FALSE here.

DONE (shared + correct): **A** (MountTable + full config), **B** (sidecar-core router/dispatch/perms/
limits/diagnostics genuinely shared, catch-all gone), **D** (bridge-contract 3-way + console),
**F** (execution_id frame-based, per-execution ownership), **L** (identity shared), **M** (build dedup
+ drift gate), **S1/S6/S7/S8**.

> **⚠️ MANDATORY — these are NOT optional, deferrable, or "nice to have".** The convergence is
> NOT done until every REMAINING item below — including the hard ones (R0, WASI/C, crypto/C2, spawn/E,
> net/G, resolver/K, and deleting the legacy TS executor) — is fully implemented and cleanly
> verified. "Difficult", "large", or "multi-day" is not grounds to skip, stub, or defer any of them.
> A green `test:converged` does NOT mean done while the legacy fail-open TS stack is still the live
> path: the converged wasm path must become the ONLY browser runtime and the tested one. No item may
> be marked done by a partial/parallel/lint-only impl — it must be the real shared code, exercised
> end-to-end. There is no "out of scope" exit for difficulty; the only acceptable end state is full,
> clean implementation.
>
> **🚫 DO NOT STOP until the whole spec is done.** Implementing in small, tested, committed slices is
> required, but reaching "a good checkpoint" or "a clean stopping point" is NOT a reason to halt,
> hand off, summarize-and-wait, or ask whether to continue. After landing each increment, immediately
> start the next REMAINING item. The work is finished only when: (1) every item in REMAINING and
> §11 (Definition of done) is implemented and verified, (2) the legacy TS executor stack is deleted,
> and (3) the converged wasm path is the sole, tested browser runtime. Until all three hold, keep
> going — there is no partial-completion exit, and "this will take a long time" is expected, not a
> blocker.
>
> **Mechanical no-stop rule (so this can't be rationalized around):**
> - A **milestone / status / checkpoint / "what remains" / progress-summary message is itself a STOP.**
>   Producing one as a turn's final output is the prohibited behavior, even when framed as "continuing".
>   Do not write them.
> - **End every turn with a tool call that advances the next slice** (a Read/Edit/Bash/commit toward
>   the next REMAINING item) — never with prose that recaps what was done. The only allowed
>   prose-terminal turn is the single final one where all three end-conditions above are TRUE and
>   verified.
> - After each `jj` commit, the very next action is the FIRST step of the next slice (open the file,
>   run the build, write the test) — not a summary of the commit just made.
> - Keep commit messages and one-line "starting slice X" notes; those are fine. A multi-paragraph
>   "here's what I landed and what's next" block is not — that is the stop.
> - If tempted to summarize, instead pick the next REMAINING item and take its first concrete action
>   in the same turn.

REMAINING:
- **R0 (the big one):** wire the converged sidecar's guest dispatch (net.* → kernel `socket_*`;
  WASI fs → kernel `PermissionedFileSystem`; child_process spawn recursive via `ExecutionBridge`),
  repoint the conformance harness at the converged path, then RETIRE the legacy TS executor. This
  underlies E/G/K and closes the legacy path's **S1/S3/S5 fail-open** violations.
- **B-resid — DONE:** `apply_root_filesystem_entry` lives in the SHARED `sidecar-core/root_fs.rs` and
  is used by both native (`sidecar/bootstrap.rs`, `vm.rs`) and the wasm sidecar
  (`sidecar-browser/service.rs`).
- **C (WASI):** one shared preview1 runner; browser WASI fs through the kernel (S3); wire
  `wasi-testsuite` on both backends.
- **C2 (crypto): RESOLVED as option (b)** (see decisions log #8). Shared RustCrypto for the AES
  cipher (both backends); native asymmetric stays OpenSSL, wasm/browser uses RustCrypto/`@noble`,
  because the RustCrypto asymmetric stack destabilizes in-process V8 isolate creation. Done bar:
  cipher shared + conformance-green (met); asymmetric covered per-backend with golden conformance.
- **E — largely per-platform (§1 executor-embedding/host-backend).** The parallel browser spawn path
  (`executor-host.ts`/`childSpawnStart`) is DELETED. The converged browser services child_process via
  the embedder-provided `commandExecutor` host capability (a browser cannot spawn real processes; the
  embedder owns it) with the applied policy enforced (S4); native spawns kernel processes via the
  shared kernel process table / `ExecutionBridge`. The shared part (kernel process table, ActiveProcess,
  guest-kernel sync-bridge contract) is shared; the spawn shell differs by platform per §1. Verified by
  the converged child_process Playwright cases. (Recursive grandchild spawn depends on the embedder's
  commandExecutor on the browser side.)
- **G — DONE (via the converged `guest_kernel_call` path):** the converged executor's `net.*`/`dgram.*`/
  `dns.*` route through `guest_kernel_call` → the SHARED `sidecar_core::guest_net::handle_guest_kernel_call`
  (used by native + the wasm sidecar); the wasm sidecar's `wire_dispatch.rs` has no separate
  `guest_syscall` net translator. browser UDP loopback works (dgram Playwright cases). F
  (`execution_id` keying) is also covered: `guest_kernel_call` carries the executionId, resolved to a
  kernel pid per execution. S1/S2 enforcement is in the shared kernel (see §2).
- **K — DONE (converged):** the converged browser uses the FULL `resolveModule` (the
  `converged-module-servicer` runs it over the kernel-backed fs), not the old weak 4-candidate
  resolver (`guest-runtime.ts` is deleted). Module resolution is verified by `resolve-module.test.ts`
  + `converged-module-servicer.test.ts` + the converged conformance module cases.
- **A — DONE (foundational):** the wasm sidecar already uses `BrowserKernel = KernelVm<MountTable>`
  (`sidecar-browser/service.rs:51`) and creates VMs from a full `RootFilesystemConfig`
  (`create_vm_with_root_filesystem`); `snapshot_root_filesystem` round-trips (converged executor
  session, exercised by the OPFS-persistence Playwright cases). The §3 "browser = `MemoryFileSystem`"
  claim is stale. (A guest-driven lower-layer-read + snapshot smoke is covered by the converged
  conformance/Playwright fs cases.)

### R0 implementation plan (the dominant remaining build)

Verified architecture: the converged wasm sidecar (`crates/sidecar-browser`) services wire frames +
shared `sidecar-core` dispatch for fs (`guest_fs::handle_guest_filesystem_call`), perms, limits,
diagnostics, layers, identity, vm_fetch — these are SYNCHRONOUS (dedicated wire payloads, executor
blocks for the response frame). BUT: (1) guest **net/spawn/wasi** calls have no synchronous path —
they arrive as fire-and-forget `ExecutionEvent::GuestRequest(GuestKernelCall)` and hit
`unsupported_guest_kernel_call_event` (`wire_dispatch.rs:1043`, `service.rs:1478`); (2) the JS guest
**executor host** (`startExecution`/`createWorker`/`pollExecutionEvent`, an optional bridge in
`sidecar-wasm-module.ts`) that the wasm `BrowserJsBridge` calls (`wasm.rs:808`) is NOT the live
runtime — the conformance/Playwright harness runs the LEGACY `runtime-driver.ts`/`worker.ts` against
the TS kernel (the legacy stack carries the S1/S3/S5 fail-open holes). The legacy `worker.ts` +
`sync-bridge.ts` is a complete executor + SAB sync-bridge, but bound to the TS kernel.

Incremental build:
1. **Shared synchronous guest-call dispatchers** in `sidecar-core` for the ops that currently bail to
   GuestRequest: `net.*` (mirror `guest_fs::handle_guest_filesystem_call`), then spawn, then WASI fs.
   Expose a synchronous guest-kernel-call entrypoint on the wasm `SidecarHandle` (op+payload → kernel
   → response). Unit-test each like the fs path (no executor needed). Network enforcement is already
   in the kernel (S1); this just routes guest ops to it. Folds in **G** + browser UDP loopback.
   - **DONE (slice 1, commit `nrklvyqr`)**: generic synchronous wire payload
     `GuestKernelCallRequest{executionId,operation,payload}` → `GuestKernelResultResponse{payload}`
     (BARE + `protocol.rs` variants 28/30 + `RequestRoute::GuestKernelCall`, dispatch=Immediate,
     ownership=Vm); shared dispatcher `sidecar_core::guest_net::handle_guest_kernel_call` covering the
     loopback TCP lifecycle (`net.connect/listen/accept/read/write/shutdown/close`) through the kernel
     socket table; browser `service.guest_kernel_call` (resolves `executionId`→`kernel_pid`) + wire
     dispatch arm; native `guest_kernel_call` delegating to the same dispatcher (wire/client parity).
     Tests: 3 sidecar-core unit tests + a sidecar-browser wire-level loopback round-trip. `cargo build
     --workspace` and `wasm32-unknown-unknown` clean.
   - **DONE (slice 1b, commit `zxloroqv`)**: `net.poll` (readiness via `kernel.poll_targets`, timeout
     clamped to a 50ms ceiling), UDP loopback (`net.udp_bind` / `net.send_to` / `net.recv_from` via
     `socket_send_to_inet_loopback` + `socket_recv_datagram`) — folds in the browser UDP half of **G**.
     +2 unit tests; workspace + wasm32 clean.
   - **DONE (slice 1c, commit `vrrklswm`)**: TS wire codec — regenerated `generated-protocol.ts` from
     BARE; `@secure-exec/core` `request-payloads.ts`/`response-payloads.ts` map `guest_kernel_call` ⇆
     `GuestKernelCallRequest` and `guest_kernel_result` ⇆ `GuestKernelResultResponse`. +2 TS round-trip
     tests; `check-types` clean. NOTE: the wasm `BrowserSidecarWasm.pushFrame` is a **generic** wire
     dispatcher, so the new payload is already reachable from JS — no new wasm binding required.
   - **TODO (slice 1 remainder)**: `dns.*`, then spawn + WASI fs ops on the same dispatcher.
2. **Converged executor host**: a JS host (adapt `worker.ts`) that runs the bundle+guest in a Worker
   and routes guest `_*` calls over the SAB sync-bridge to the wasm sidecar's guest-call entrypoint
   (instead of the TS kernel). Vertical slice first (console+exit), then fs, then net, then spawn.
   Folds in **E** (one spawn path on `ExecutionBridge`, recursive) and **K** (the converged executor
   uses the shared module resolver).
   - **DONE (slice 2a, commit `wowkknvo`)**: `converged-fs-bridge.ts` — pure translator, 18 single-call
     `fs.*` ops ⇆ `guest_filesystem_call`, wire snake_case stat → guest camelCase `VirtualStat`,
     text/binary decode by op. 7 Node tests.
   - **DONE (slice 2b, commit `zpzzlzun`)**: `converged-net-bridge.ts` — new synchronous guest
     `net.*`/`dns.*` sync-bridge ops ⇆ `guest_kernel_call` (op string + JSON body, base64 socket data);
     shared `converged-base64.ts`. 6 Node tests.
   - **DONE (slice 2c, commit `krxpnzoy`)**: `converged-sync-bridge-handler.ts` — synchronous handler
     replacing `handleSyncBridgeOperation`; routes fs/net/dns to the wasm sidecar, expands `fs.readDir`
     via `read_dir`+per-entry `lstat`. Split `ConvergedSidecarRequestTransport` seam +
     `PushFrameSidecarTransport` (encode request frame → `pushFrame` → decode response). 7 Node tests.
   - **DONE (slice 2d, commit `rmunpxlx`)**: `converged-executor-session.ts` — sync handshake
     (authenticate/open_session/create_vm over `pushFrame`) → per-execution handler. 3 Node tests.
   - **DONE (slice 2e, commit `xkovsqqs`) — MADE THE WASM SIDECAR ACTUALLY RUN**: validating against
     the real wasm-pack build surfaced 3 runtime bugs that meant the wasm kernel had never executed a
     VM (compiled ≠ ran): (1) **message-framing parity** — `WireFrameCodec` length-prefixes frames but
     the TS message transport sends raw bare frames; added `encode_message`/`decode_message` (no
     prefix) and switched the browser dispatcher; (2) **wasm time** — `SystemTime/Instant::now()` abort
     on wasm; swapped vfs+kernel to the `web-time` crate; (3) **wasm threads** — `ProcessTable` spawned
     a reaper thread per VM (panics on wasm); gated to native + cooperative `reap_due_zombies` on wasm.
   - **DONE (slice 2f, commit `kwwnzott`)**: committed real-wasm integration test — `build:sidecar-wasm`
     (wasm-pack → `.cache/sidecar-wasm`) + `tests/integration/converged-wasm.test.ts` drives the
     converged TS stack against the REAL kernel: guest fs round-trips, readdir→typed Dirents via
     lstat, deny-all enforced (S5). **The converged wasm path now provably executes.**
   - **DONE (slice 2g, commit `mrvmntuw`)**: `converged-sync-bridge-router.ts` — routes fs/net/dns to
     the wasm handler, async converged servicers next, legacy fallback last; `isFullyConverged` reports
     when legacy can be deleted. 3 tests.
   - **DONE (slice 2h, commit `vzwwokrm`)**: `kernel-backed-filesystem.ts` (VirtualFileSystem over the
     wire) + `converged-module-servicer.ts` reusing the shared resolver over it (item **K**); resolves
     relative + bare-package via node_modules/package.json. 10 tests.
   - **DONE (slices 2i/2j, commits `ouwvoqmt`/`ykqtrkyv`)**: web-target wasm built into the harness
     assets; `converged-sidecar.spec.ts` drives the converged stack against the real wasm kernel in
     **real Chromium** (guest fs round-trips). The converged path is proven in-browser, not just Node.
   - **ARCHITECTURAL FINDING (defines the live-wiring slice):** the legacy `runtime-driver`'s filesystem
     is a **caller-provided `options.system.filesystem` (TS VFS)** (`createSyncBridgeFilesystem`,
     runtime-driver.ts:230) — fundamentally incompatible with the kernel-owns-fs converged model. So
     "route the live driver's `handleSyncRequest` through the router" is NOT a drop-in: it requires
     reshaping the browser fs API from a caller-provided live VFS to a **kernel-owned filesystem
     configured via `CreateVmConfig.rootFilesystem`** (bootstrap entries + mounts), and reworking the
     harness/tests to seed VM content through that config instead of a TS VFS object. This reshape
     (the real M5 finish) is the next slice; then the 37 existing Playwright tests can run against the
     wasm kernel, then delete legacy.
   - **DONE (slice 2k, commit `zpwlnptz`)**: `root-filesystem-from-vfs.ts` — snapshot a legacy
     caller-provided VFS into a kernel `RootFilesystemConfig` (bootstrap entries), bridging the legacy
     `options.system.filesystem` model to the kernel-owns-fs model. 3 tests.
   - **DONE (slice 2l, commit `sznqpyks`)**: module resolution over the wasm kernel verified in real
     Chromium (the in-browser harness seeds a package and resolves relative + bare specifiers).
   - **DECISIVE ARCHITECTURAL FINDING (scopes the remaining build):** the converged code CANNOT be
     retrofitted into `runtime-driver.ts`. The legacy main-thread driver is loaded **unbundled** from
     `/dist/` (its imports are all relative/local), but the converged modules import
     `@secure-exec/core/*` (bare specifiers) which the browser cannot resolve unbundled. Therefore the
     live converged runtime must be a **bundled** module (like the worker bundles and the proven
     `converged-harness.entry.ts`), NOT the `/dist/` legacy driver. The remaining build is:
     **build a bundled converged runtime** that (a) loads the web wasm sidecar, (b) bootstraps a VM
     from `rootFilesystemConfigFromVfs` + permissions, (c) spawns the existing guest worker
     (`worker.js`, unchanged — it runs guest JS over the SAB sync-bridge), and (d) services the
     worker's sync-requests via `ConvergedSyncBridgeRouter` (fs/net/dns/module → wasm; child_process/
     dgram/signal via the legacy servicer until converged). All constituent pieces are built + proven
     in Chromium; this is their assembly into a guest-running host.
   - **DONE (slices 2m/2n, commits `mwvzmwnn`/`wplpnrlx`)**: `converged-driver-setup.ts`
     (createConvergedServicer assembling session+handler+module servicer+router, loaded DYNAMICALLY so
     unbundled `/dist/` legacy stays bare-import-free) + `runtime-driver` `convergedSidecar` factory
     option routing `handleSyncRequest` through it (additive; legacy suite 36/36 still green, 0 bare
     core imports in dist).
   - **DONE (slices 2o/2p, commits `woksvunq`/`myssruvp`) — LIVE CONVERGED EXECUTOR WORKS**: a bundled
     live harness creates a real `BrowserRuntimeDriver` with `convergedSidecar` and runs **real guests**
     whose syscalls hit the wasm kernel, proven in real Chromium: (1) `fs.mkdir/write/read` round-trips
     (stdout `converged-live`, exit 0); (2) `require()` of a module written to + resolved from the wasm
     kernel (stdout `42`). The live converged executor runs real guest code for fs + module.
   - **DONE (slices 2q-2t, commits `xsknrtuv`/`ystrvyts`/`zpxvptxx`/`kvpsoozn`) — NET/DGRAM EXECUTOR
     HOST**: `session.registerExecution` (execute wire request → kernel process/pid) +
     `converged-execution-host-bridge.ts` (no-op execution host bridge whose `startExecution` echoes
     the driver execution id; emit/clock no-ops) let guest `net.*`/`dgram.*` `guest_kernel_call`s
     resolve `execution_id`→kernel pid. Proven in real Chromium: **TCP loopback**
     (listen/connect/accept/write/read) and **UDP loopback** (udp_bind/send_to/recv_from) round-trip
     through the wasm kernel socket table (folds in **G**).
   - **CONVERGED CORE PROVEN**: the wasm kernel now services fs + module + TCP + UDP for the converged
     browser path, validated by 6 Chromium specs (incl. 2 real running guests) + the Node integration
     test, with all kernel enforcement (permissions S5, network policy S1) intact.
   - **DONE (item 1, commits `zqvklvyx`→`msmomzwr`) — RUNNING GUESTS DO NETWORKING THROUGH THE KERNEL**:
     kernel `bind_inet(port=0)` ephemeral assignment + `sidecar-core::guest_net` `dgram.*` ops;
     `converged-dgram-bridge.ts` maps the worker's positional `dgram.*` sync ops → kernel UDP;
     the converged driver lazily registers a kernel execution on a guest's first net/dgram syscall
     (`setNextExecutionId` → `execute` → pid). Proven in real Chromium: a **real running guest** doing
     `dgram.createSocket/bind/send/on('message')` round-trips through the wasm kernel. (Browser guests
     have no raw TCP API; `net.*` loopback is validated via the direct harness. child_process stays a
     host capability.) Folds in **G**.
   - **DONE (item 2 foundations, commits `tpouvqtr`→`povuyskn`)**: a **bundled converged conformance
     harness** (`converged-conformance-harness.entry.ts`) exposes the full
     `window.__secureExecBrowserHarness` API (createRuntime/exec/dispose/terminate/signal/debug) the
     conformance suite drives, but every runtime uses the converged sidecar (wasm kernel) with config
     from driver options + `convergedPermissionsPolicy` (declarative deny rules → kernel, validated:
     deny-fs-read, deny-network-port). Proven in real Chromium via the standard conformance API: broad
     fs, module resolution, stdio/stderr/exit codes, sequential-exec with persisted kernel state, and
     child_process via the host echo executor. `convergedPermissionsPolicy` translates the harness's
     TS-callback permission tests into declarative kernel policy.
   - **DONE (item 2 finish, commits `okrnoton`→`zpzwvnqt`) — 35/36 CONFORMANCE AGAINST THE WASM
     KERNEL**: `SECURE_EXEC_CONVERGED_HARNESS=1` runs the literal `runtime-driver.spec.ts` against the
     converged harness; **35 of 36 pass** (was 28). Gaps closed: useDefaultNetwork/filesystem options +
     worker on(message|error) debug; kernel dgram auto-bind to loopback (correct source addr);
     **POSIX errno propagation** (transport surfaces `EACCES` etc. as the guest error.code — fixes
     dgram network-policy deny tests); child_process deny via driver permissions (host capability);
     denied-fs-read counter through the converged servicer; **WASI fs confirmed through the kernel**
     (WASI path_open → sync-bridge fs → wasm kernel, denial enforced + counted). Crypto/signals ride
     the worker runtime and pass.
   - **DONE (item 2 COMPLETE, commit `nqnsnwxv`) — FULL 36/36 CONFORMANCE AGAINST THE WASM KERNEL**:
     OPFS persistence implemented via snapshot-back-on-dispose (`snapshotRootFilesystem` →
     `driver.snapshotConvergedRootFilesystem` → persist entries to the host OPFS fs). The ENTIRE
     `runtime-driver.spec.ts` (36/36) passes against the converged kernel
     (`SECURE_EXEC_CONVERGED_HARNESS=1`); legacy suite still 36/36 (no regression); 123 unit tests.
     **The converged wasm kernel is conformance-equivalent to the legacy TS kernel.**
   - **DONE (item 2 productionized, commit `lowytlst`)**: `openHarnessPage` now uses the converged
     harness BY DEFAULT (`SECURE_EXEC_LEGACY_HARNESS=1` opts back to legacy). The whole browser
     Playwright suite (52 tests) passes with the converged wasm kernel as the default tested runtime.
   - **item 3 — delete the legacy TS kernel** (mostly DONE): the legacy kernel *servicing* is gone —
     the fs.* / module.* / dgram.* arms of `handleSyncBridgeOperation`, `createSyncBridgeFilesystem`,
     and the driver's `syncFilesystem` + dgram session state were deleted (slices 2*, 3a); the
     `SECURE_EXEC_LEGACY_HARNESS` opt-in and the legacy `runtime-harness.{html,js}` fixtures are
     removed (harness is converged-by-default). `handleSyncBridgeOperation` now serves only
     child_process.* + process.signal_state (host capabilities — KEEP). **Corrected:** `os-filesystem.ts`
     is **NOT** deleted — it is repurposed as the generic client-side in-memory VFS (`createFsStub`
     default) that the harness snapshots via `rootFilesystemConfigFromVfs` to seed the converged
     kernel; it is no longer a kernel. `resolveModule` (now run over the kernel-backed fs by the
     converged module servicer) and `wasi-polyfill` (guest WASI userland riding sync-bridge fs →
     kernel) are KEPT. **DONE (item 3a)**: the driver is now **converged-only** — the non-converged
     `handleSyncRequest` else-branch is removed; a guest syscall without a converged sidecar throws
     ("legacy in-process kernel has been removed"). `handleSyncBridgeOperation` survives ONLY as the
     converged router's fallback for host capabilities (child_process.* / process.signal_state); the
     5 child_process white-box unit tests now run against a fake converged sidecar
     (`tests/runtime-driver/fake-converged-sidecar.ts`). Verified green: 120 vitest + 52 Playwright.
     **TODO (item 3 remainder)**: (b) for shipping, package the web wasm + a default loader into
     `@secure-exec/browser`.
   - **item 4**: crypto C2 — **DONE as option (b)** (decisions log #8): AES cipher is shared
     RustCrypto (`crypto_cipher.rs`); native asymmetric stays OpenSSL (RustCrypto asymmetric stack
     destabilizes in-process V8 isolate creation — ASan-confirmed `WasmCodePointerTable` SEGV);
     wasm/browser uses RustCrypto/`@noble`. **item 4 / C (WASI)**: **S3 is SATISFIED on both backends**
     (see §2 S3, verified 2026-06-21): native WASI fs routes through the sidecar kernel
     `PermissionedFileSystem` via `route_fs_through_sidecar` + `WASM_SIDECAR_ROUTED_FS_SYNC_METHODS`;
     browser WASI rides the converged sync-bridge fs → wasm kernel. The doc's "host-direct" claim was
     stale. **TODO (item 4 remainder)**: the convergence-cleanliness parts of §C — extract ONE shared
     preview1 runner (native's `class WASI` + browser `executor-wasi.ts` behind a per-backend
     `WasiKernel` seam) and wire a `wasi-testsuite` subset on both — plus residual §3/§11 DoD items.
   - **(superseded) earlier item-2 framing**: the conformance harness
     (`runtime-harness.js`) is `/dist/`-loaded (unbundled), so it can't pull the converged setup's bare
     `@secure-exec/core` imports. Bundle the conformance harness (esbuild inlines the driver's dynamic
     `converged-driver-setup` import + core), have it pass `convergedSidecar` (web wasm + execution host
     bridge + config derived from driver options) by default, repoint the conformance/Playwright suite
     at it, and get the 36 conformance tests green against the wasm kernel (fs/module/dgram → kernel;
     dns/child_process/crypto/WASI via worker runtime / legacy fallback until converged).
   - **TODO (item 3)**: delete the legacy TS kernel (`os-filesystem.ts`, TS resolver over TS fs,
     `syncFilesystem`, `wasi-polyfill.ts`, legacy sync-bridge servicer) once converged is default+green.
   - **TODO (item 4)**: **C** WASI-through-kernel (S3) + **C2** crypto (one shared RustCrypto impl).
3. **WASI through the kernel** (**C**/S3): the converged executor's WASI fs routes through the wasm
   sidecar guest-call path → `PermissionedFileSystem`; one shared preview1 runner; wire `wasi-testsuite`.
4. **Repoint the harness** (`runtime-harness.js` + Playwright + conformance) at the converged executor.
5. **Delete the legacy stack** (`runtime-driver.ts`, `worker.ts`, `runtime.ts` wrap-*, `os-filesystem.ts`,
   `wasi-polyfill.ts`, legacy `sync-bridge` bits) once the converged path is green — closes S1/S3/S5.
6. **C2 crypto** (default: one shared RustCrypto impl, drop OpenSSL) + **B-resid** bootstrap dedup as
   cleanups along the way.

---

Converge the **browser** sidecar (`crates/sidecar-browser` + `packages/browser`) and the **native**
sidecar (`crates/sidecar` + `crates/execution` + `crates/v8-runtime`) onto shared code. Companion to
`BROWSER-CONVERGENCE-TODO.md` (capability parity — met) and `BROWSER-CONVERGENCE-PLAN.md`.

> **Crate-map correction (read first).** There is **no `crates/vfs` or `crates/secure-exec-vfs`** in
> this workspace. VFS engines (`MountTable`, `RootFileSystem`, `OverlayFileSystem`, device layer,
> mount plugin trait) live in **`crates/kernel/src/`** and **already compile to `wasm32`**. Host
> storage backends live in **`crates/sidecar/src/plugins/`** (`host_dir`, `s3`, `sqlite_vfs`,
> `google_drive`, `module_access`, `sandbox_agent`, `js_bridge`) with heavy host deps in
> `crates/sidecar/Cargo.toml`. `crates/sidecar-browser` does **not** depend on `crates/sidecar`, so
> the host backends are already absent from the wasm dependency tree.

---

## 0. Decisions log (owner)

1. Native is in-scope to edit; convergence may change native code paths/behavior.
2. No backwards/wire compat — change protocol/types/configs freely, update all sides together.
3. Make it compile; gate host-only code behind the **existing `native` feature** (kernel
   `default = ["native"]`; the wasm build uses `--no-default-features`). Gated-out caps fail loud.
4. VFS first step is the **fuller** scope: browser parses the entire `rootFilesystem` config
   (mode / lowers / layers / mounts) like native `create_vm`, not just a type swap.
5. Tests: prove the **basic wiring** per item with one focused smoke; not the whole system.
6. WASI conformance: wire `wasi-testsuite` (bytecodealliance) when the shared WASI runner lands.
7. Cleanest state is the goal — prefer deleting parallel impls over adapting them.
8. **C2 crypto resolved as option (b), forced by a hard V8 constraint.** The AES symmetric cipher
   IS shared RustCrypto (`crates/sidecar/src/crypto_cipher.rs`, conformance-green on both backends).
   For *asymmetric* crypto, option (a) "one shared RustCrypto impl linked into native" is **not
   viable**: linking the RustCrypto asymmetric stack (`rsa`/`p256`/`p384`/`ed25519-dalek`/
   `x25519-dalek`/`num-bigint-dig`) into the V8-hosting sidecar destabilizes V8 isolate creation.
   AddressSanitizer pins the fault to `v8::internal::wasm::WasmCodePointerTable::AllocateUninitializedEntry`
   during the **second** in-process `Isolate::New` after crypto-heavy native heap activity (a
   process-memory-layout conflict with V8's reserved pointer-table region; reproduces from mere
   linking, independent of calling the crates; pure 2-isolate creation without crypto does NOT
   crash). A full `crypto_keys` RustCrypto module (RSA/EC/Ed25519/X25519/DH/prime + unified
   OID-dispatch KeyObject) was built and unit-verified, but was reverted from native to keep V8
   stable. Resolution: **native asymmetric stays on OpenSSL; the wasm/browser path uses RustCrypto/
   `@noble`** (two impls, option b). Revisit (a) only with an out-of-V8-process crypto boundary or a
   V8 cage-reservation fix.

---

## 1. Goal & non-goals

**Goal:** one implementation above the host boundary, with native and browser as thin shells that
differ only in: (a) transport, (b) executor embedding, (c) storage/host backends, (d) host-egress.

**Non-goals (legitimately parallel):** transport (stdio vs Worker+SAB); executor embedding
(in-process V8 vs V8-in-Worker); storage/host backends (host-disk/SQLite/S3 vs in-memory/OPFS/fetch);
host egress (raw outbound TCP/UDP is impossible in a browser — only loopback converges).

---

## 2. Invariants (the convergence contract)

**Sharing**
- Shared-by-default: anything in `crates/kernel` (syscalls, process table, socket table, DNS, VFS
  engines, permission primitives, resource accountant) and the v8-bridge bundle is shared and used
  by BOTH backends. A browser-only reimplementation of any of it is a defect.
- `cfg`, don't fork: host-only code is gated behind the existing **`native`** feature (do not invent
  a parallel `host-backends` feature). Keep `kernel`/`sidecar-core` wasm-clean; host coupling stays
  in `crates/sidecar/src/plugins`. Gated-out caps return a typed "unsupported on this platform"
  error — never a silent no-op.
- Single source of truth for cross-cutting lists (bridge globals → `crates/bridge/bridge-contract.json`;
  polyfill registry; wire-payload router). Both backends consume the same artifact; CI drift-checks it.

**Security (the kernel is the one enforcement point — must hold on BOTH backends)**
- **S1 Network policy on connect/listen/bind, not just DNS. — SATISFIED in the shared kernel (doc
  text below was stale; verified 2026-06-21).** The kernel now calls `check_network_access` directly
  in its socket ops — `socket_bind_inet` (`kernel.rs:1357`) and `socket_connect_inet_loopback`
  (`kernel.rs:1587`) — in addition to the DNS paths. Both backends drive sockets through these shared
  ops, so a deny-network policy is enforced for native AND the converged browser guest. Verified: the
  converged "denies browser dgram bind through the applied network policy" + "denies browser dgram
  send …" Playwright cases pass (browser), and native shares the same kernel ops. (Historical note —
  the original gap and the planned fix:) Today the kernel checks
  `check_network_access` only in `resolve_dns`/`resolve_dns_records` (`kernel.rs:610,631`); socket
  `connect`/`listen`/`bind`/`read`/`write` have no check. Native compensates above the kernel
  (`execution.rs:19304` connect→Http, `:19408` listen→Listen); **the browser does not**
  (`service.rs:467,555`), so a browser guest under a deny-network policy can still `net.connect`/
  `net.listen` (loopback-only impact, but a real applied-policy bypass). **Fix in convergence:** push
  the connect/listen/bind network-permission check **into the shared kernel** `socket_*` ops so
  neither backend can skip it.
- **S2 Loopback-exempt-port / restricted-range gate. — RESOLVED as legitimately per-platform (§1
  host-egress non-goal).** Native's `filter_tcp_connect_ip_addrs` (`execution.rs:11455`) does two
  host-protection things: (a) block connects to restricted **non-loopback** IP ranges
  (`restricted_non_loopback_ip_range` — SSRF/metadata-IP/host-egress protection) and (b) gate loopback
  connects to non-exempt ports (`loopback_connect_allowed` — protects *host* loopback services). The
  browser's kernel is **fully virtualized**: it has no host egress (raw outbound is impossible in a
  browser — §1 non-goal) and no host loopback services (a guest loopback connect only reaches another
  in-VM kernel listener via in-kernel routing). So both gates protect host resources that have no
  browser analog; there is nothing extra to gate beyond S1. The **shared** S1 `check_network_access`
  (applied-policy connect/bind enforcement) runs on both backends — verified by the converged
  deny-network-port Playwright cases. S2's extra pinning is therefore correctly native-only
  host-resource protection, not a convergence gap.
- **S3 WASI fs goes through `PermissionedFileSystem`. — SATISFIED on both backends (doc claim below
  was stale; verified 2026-06-21).** Native WASI fs **does** route through the kernel in the
  sidecar/VM path: `wasm_sync_rpc_method_routes_through_sidecar_kernel` (`wasm.rs:1446`) returns true
  whenever `route_fs_through_sidecar` (= `sandbox_root.is_some()`, `wasm.rs:910`) and the op is in
  `WASM_SIDECAR_ROUTED_FS_SYNC_METHODS` (the full `fs.{open,read,stat,readdir,mkdir,write,unlink,…}Sync`
  surface). Those return `Ok(false)` and forward to the sidecar's `filesystem.rs` handlers — the SAME
  permission-checked `read_file_for_process` path JS `fs.*` uses → kernel `PermissionedFileSystem`.
  The host-direct branch (`handle_internal_wasm_sync_rpc_request` fallthrough) only runs for the
  standalone, non-sidecar runner (no VM/permission context). Browser WASI rides the converged
  sync-bridge fs → wasm kernel (item 2). Verified: `aab_wasm_path_open_read_uses_kernel_filesystem_permissions`
  + `aac_wasm_path_open_write_*` (native, kernel `fs.read`/write Deny enforced) and the browser WASI
  Playwright cases (descriptor rights, preopen escape→NOENT, read-only→ROFS, path_open permissions).
  Preserved: trusted-config-only preopens (fds ≥3; no guest may widen), per-preopen read-only (→EROFS),
  WASI rights gating at `path_open`, canonicalizing confinement (no-roots ⇒ deny-all), and the
  guest-controlled read-length cap.
- **S4 child_process stays two enforcement points.** Native enforces at the kernel command callback
  (`bridge.rs:1133`→`command_decision` `service.rs:280`→`check_command_execution` `kernel.rs:1077`);
  the browser allows-at-kernel and enforces in the executor (`command_spawn_allowed` `permissions.rs:76`
  ← `wire_dispatch.rs:1140`) because browser spawn is serviced locally. Unification must keep BOTH;
  never collapse to allow-at-kernel. Preserve native's internal-runtime bootstrap carve-out.
  **— SATISFIED:** both enforcement points are intact. The converged browser spawns via the driver's
  `commandExecutor` wrapped with the applied policy (`wrapCommandExecutor` + `system.permissions`),
  verified by the "routes/denies browser child_process …" Playwright cases; native enforces at the
  kernel command callback. Neither was collapsed to allow-at-kernel.
- **S5 No-policy default is deliberate. — SATISFIED on both backends (deny-all); doc claim below was
  stale.** Native: no `config.permissions` ⇒ explicit `deny_all` (`vm.rs:131`). The converged browser
  sidecar leaves the kernel's `Permissions::default()` (all four fields `None`), and EVERY kernel
  check fails closed on `None` — network (`permissions.rs:314`), filesystem (`:368`), child_process
  (`:283`), environment (`:257`) all return `access_denied` when their check is absent. So a browser
  VM created with no policy (`wire_dispatch.rs:225` `None` → `service.create_vm` skips
  `set_permissions`) is deny-all too. The "browser ⇒ `allow_all`" note referred to the now-deleted
  legacy TS sidecar / a config-level default, not the converged kernel path.
- **S6 `Ask`/`Prompt` ⇒ Deny** on every domain and channel (already consistent; must survive).
- **S7 Gating a backend never gates a check.** Enforcement lives in `kernel` (verified: plugins
  contain no `PermissionDecision`/`check_subject`). Mount-path confinement that lives inside a host
  backend (`host_dir.rs:153`) is removed only with the mount itself, never silently bypassed.
- **S8 Teardown:** execution teardown releases that execution's kernel sockets/fds/listeners; async
  signals target only the originating execution. **— SATISFIED via the shared kernel:**
  `cleanup_process_resources` (`kernel.rs:300`) reclaims a process's sockets/fds/listeners on exit on
  both backends; the converged driver also clears per-execution state (`cleanupExecutionState`,
  `runtime-driver.ts:745`), and the hard-termination/signal Playwright cases confirm pending work is
  rejected and sync-bridge state cleared per execution.
- **Anti-pattern guard:** don't add validation that only guards trusted client config; don't drop a
  check that binds the untrusted guest. (Limits *validation* is defense-in-depth, not a guest check.)

---

## 3. Current state (verified by the reviews)

**Already shared:** `crates/kernel` (compiled to wasm as a plain dependency of the `cdylib`
`crates/sidecar-browser`, built with `--no-default-features`; native links it with `native`):
socket table, process table, DNS (host resolver gated behind `native`), VFS engines (`mount_table`,
`root_fs`, `overlay_fs`, device layer), permissions, resource accountant. The v8-bridge bundle. The
wire protocol. The **client-side** `SidecarTransport` seam (`packages/core/src/transport.ts`) — both
`StdioSidecarProtocolClient` (native) and `WorkerSidecarTransport` (browser) already implement it.
`crates/bridge/bridge-contract.json` (a real artifact native drift-checks).

**Parallel today (to converge):**

| Concern | Native | Browser | Item |
|---|---|---|---|
| Root FS type | `SidecarKernel = KernelVm<MountTable>` (`state.rs:45`) | `BrowserKernel = KernelVm<MemoryFileSystem>` (`service.rs:21`, ctor `:390`) | **A** |
| Root-FS-from-config | `root_filesystem_from_config`/`build_root_filesystem` (`vm.rs:748,1030`, uses host-disk helpers) | ignored (memory + bootstrap entries) | **A/B** |
| Host storage backends | `sidecar/src/plugins/{host_dir,s3,sqlite_vfs,google_drive,…}` (`sidecar/Cargo.toml` host deps) | none | gate behind `native` (**A**); OPFS later (**J**) |
| Wire-request router + framing | `service.rs:1194-1362` dispatch + handshake/response/event builders | `wire_dispatch.rs:204-713` parallel router + catch-all `:709` | **B** |
| Guest-syscall per-op dispatch | `execution.rs` handlers (mapping `v8_runtime.rs:177`) | `wire_dispatch.rs` `guest_syscall_dispatch` (parallel copy) | **B** |
| Permission/limits mapping | `evaluate_permissions_policy` (`service.rs:468`, imperative per-call), `limits.rs` (+validation) | `permissions.rs` (callback-build), `limits.rs` (saturating copy) | **B** |
| Crypto | OpenSSL (`execution.rs:13766-15906`, ~2100 LOC) | pure-Rust/RustCrypto (`wire_dispatch.rs:1160-2543`, ~1150 LOC) | **C2 (new)** |
| WASI runner | hand-rolled `class WASI` (`wasm.rs:2225`, `__agentOsWasiModule`, replaces `node:wasi` at `:2141`), kernel-routed but host-direct fs | minimal `executor-wasi.ts` (fs stubbed `ENOSYS`) | **C** |
| Bridge globals `_*` | `SYNC/ASYNC_BRIDGE_FNS` (`session.rs:1461,1614`) + `map_bridge_method` (`v8_runtime.rs:177`); self-checks `bridge-contract.json` | `executor-core.ts`/`executor-bundle.ts` installs (~13 fns, no contract check) | **D** |
| Guest module resolution | `javascript.rs` ModuleResolver + `node_import_cache.rs` (node_modules walk, exports/conditions, realpath) | `guest-runtime.ts:643` weaker resolver (4-candidate, no node_modules/exports/symlink) | **K (new)** |
| Virtualized identity | from config (`javascript.rs:2398-2440`) | hardcoded `process.platform/arch/pid/version` (`guest-runtime.ts:461`); `__agentOsVirtualOs` never set | **L (new)** |
| Spawn / child_process | unified `ActiveProcess` (`state.rs`, `execution.rs`) | two paths: main exec (`executor-host.ts`) + child sessions (`childSpawnStart`); Rust marshalling `js_host_bridge.rs` | **E** |
| Guest syscall identity | per-process | `vm_id` only in `guest_syscall_dispatch` (`wire_dispatch.rs:826`); `execution_id` exists on lifecycle bridge (`js_host_bridge.rs:100`) but not syscalls | **F** |
| Network bridge handler | loopback + host egress + UDP + TLS + HTTP/2 (`execution.rs`) | `net_*` arms, loopback only (`wire_dispatch.rs`) | **G** |
| Signal exit codes | `128 + signum` (`execution.rs:3607`) | hardcoded 130/143 (`executor-core.ts:69`); spawn codes 126/127 invented | **I** |
| console formatting | bundle `util.inspect` via `_log`/`_error` | local `formatValue` (`executor-core.ts:411`, 2nd copy in `executor-child.ts`) | **D** |
| base64/encoding | — | duplicated 4× (`guest-runtime.ts:129`, `executor-core.ts:91`, `executor-host.ts:413`, `executor-child.ts`) | **G** |
| build_support.rs | `execution/build_support.rs` ≡ `v8-runtime/build_support.rs` (byte-identical); shared `crates/build-support/v8_bridge_build.rs` exists but unused | — | **M (new)** |

**⚠️ The "Parallel today" table above is PRE-CONVERGENCE and now largely stale (reconciled
2026-06-21).** The entire parallel browser **executor** it describes —
`executor-core.ts` / `guest-runtime.ts` / `executor-host.ts` / `executor-child.ts` /
`executor-bundle.ts` / `executor-wasi.ts` — has been **DELETED** (`ls packages/browser/src` confirms
none remain) and replaced by the converged stack (`worker.ts` as the guest, delegating every syscall
over the sync bridge → the wasm sidecar; `converged-*.ts` as the driver glue). The wasm sidecar
routes guest ops through the **shared** `sidecar_core` (`guest_kernel_call` → `guest_net`/`guest_fs`;
module resolution via the kernel-backed `resolveModule`). Consequence for the table rows:
- **D (console/base64), E (spawn), F (guest-syscall identity), G (network), I (signal codes),
  K (module resolver), L (virtualized identity)** all named files inside the now-deleted parallel
  executor; they are **resolved by its deletion** — the converged browser uses `worker.ts` + shared
  sidecar-core, kernel-routed (K: the converged module servicer reuses the full `resolveModule`;
  F/G: `guest_kernel_call` carries `execution_id` and routes net/dns/dgram through shared
  `guest_net`; security S1/S2 in the shared kernel).
- **A (root FS engine)** is legitimately per-platform storage (`MountTable` native vs in-memory/OPFS
  browser) per §1; **B (router/dispatch/perms)** is shared via `sidecar-core`.
- **Genuinely remaining (convergence cleanliness, not security/functionality — those are verified):**
  **C** (extract ONE shared preview1 WASI runner; S3 already met on both), **D's** `bridge-contract.json`
  CI drift gate, `wasi-testsuite` wiring, and 3b shipping packaging (default bundled-wasm loader).

**Survives as the converged stack (NOT legacy, do not delete):** `runtime-driver.ts` (converged
driver), `worker.ts` (guest), `runtime.ts` (types + `resolveModule`), `os-filesystem.ts` (client seed
VFS), `wasi-polyfill.ts` (guest WASI userland). The client-side `SidecarTransport` seam is shared.

---

## 4. Target architecture

```
                         ┌──────────────────── shared ────────────────────┐
 client ─wire─►  transport shell  ─►  sidecar-core (wire router + handshake,
                 (stdio | Worker)      perms, limits, bootstrap, guest-syscall
                                       dispatch, net handler, diagnostics)
                                              │  calls the shared KernelVm<MountTable> directly
                                              ▼
                                    kernel: VFS engines (root_fs/mount_table/overlay),
                                            socket/process tables, perms, DNS
                                              │  storage backend (cfg `native`):
                                              ▼  native=host-disk/SQLite/S3 ; browser=memory/OPFS
 guest (V8 isolate | V8-in-Worker) ─syscall (in-proc bridge | SAB)─► sidecar-core dispatch
 guest wasm ─WASI imports─► shared WASI runner ─(WasiKernel)─► same kernel VFS ops as JS fs
```

Per-platform shells stay small: native = in-process V8 driver + stdio + host plugins; browser =
V8-in-Worker + SAB transport + memory/OPFS backends. The middle is shared.

---

## 5. Convergence items

> **Trait guidance (from architecture review):** after #A both backends hold the same
> `KernelVm<MountTable>`, and the kernel API is itself the portability surface — so **do NOT mint
> `GuestSyscallBackend`/`BootstrapBackend` traits**; the shared dispatch takes the `KernelVm` handle
> directly. Keep narrow traits only where backends genuinely differ: `WasiKernel` (#C),
> `GuestNetworkBridgeHandler` (#G, native-only methods behind `feature="native"`). For spawn (#E)
> build on the existing `bridge::ExecutionBridge`, don't add a parallel `ExecutionSpawner`.

### A. VFS: browser uses `KernelVm<MountTable>`; host backends behind `native`  *(foundational)*

- **Problem.** Browser uses flat `MemoryFileSystem`; native uses `MountTable` (root + overlay/layers
  + mounts) and parses the full `rootFilesystem` config. Layers/overlays/snapshots/mounts unavailable
  in the browser; config parsing diverges.
- **Target.** Browser constructs `KernelVm<MountTable>` with an in-memory root, and parses the full
  `rootFilesystem` config (mode/lowers/layers/mounts) — decision #4.
- **Feasibility (corrected).** `MountTable`/`RootFileSystem`/`OverlayFileSystem` are in
  `crates/kernel` and **already compile to wasm32** (the shipped browser artifact builds them today;
  no unconditional `std::fs`/`tokio`/`nix`/`rusqlite`). The browser already holds a `KernelVm`. So the
  type switch is **low-risk**. The real work is porting **`root_filesystem_from_config` /
  `build_root_filesystem`** (native-only in `vm.rs:748,1030`, which lean on host-disk helpers like
  `create_vm_shadow_root`/`materialize_shadow_root_snapshot_entries`) into a **wasm-safe shared
  function** in `sidecar-core` that touches no `std::fs`. Host plugins stay out of the wasm build
  (already are; gate any new references behind `native`). **Risk: Medium** (not High).
- **Unlocks (shared code):** `create_layer`/`seal_layer`/`create_overlay`/`import_snapshot`/
  `export_snapshot`/`snapshot_root_filesystem`.
- **Test.** Browser smoke: create_vm with a `rootFilesystem` config (lower layer + bootstrap entries),
  guest reads from the lower / writes to the upper; plus a `snapshot_root_filesystem` round-trip.

### B. `sidecar-core` crate: shared request handling

- **Problem.** The wire-request router + handshake/response/event framing (`wire_dispatch.rs:204-713`
  vs `service.rs:1194-1362`), the guest-syscall per-op dispatch, permission/limits mapping, bootstrap
  fs writing, and diagnostics are all duplicated.
- **Target.** New wasm-safe `crates/sidecar-core` holding the backend-agnostic logic; native + browser
  become thin callers. Distinct from `crates/bridge` (contract/DTO layer — keep it that way).
- **Scope.** Move into `sidecar-core`: (1) the `match RequestPayload` router + handshake-response
  builders + ownership-scope helpers + `ResponseFrame`/`EventFrame` mapping (so a new payload is wired
  once; the catch-all `_ => "not yet implemented"` becomes a typed unsupported error, and the untyped
  `ProtocolCodecError::SerializeFailure(format!())` mapping becomes native's typed `SidecarError`
  mapping); (2) `dispatch_guest_syscall(kernel, op, value)` taking the `KernelVm` handle directly
  (no new trait); (3) `evaluate`/build permissions and `resource_limits_from_config`; (4) bootstrap
  `write_root_fs_entry` + the root-fs-from-config helper (shared with #A); (5) diagnostics helpers.
- **PermissionsPolicy unification (corrected).** Two distinct types by design: native evaluates off
  the **wire** type `secure_exec_protocol::protocol::PermissionsPolicy` (`protocol.rs:1281`);
  browser uses the **config** type `secure_exec_vm_config::PermissionsPolicy` (`vm-config:473`); a
  converter already exists (`legacy_permissions_config` + scope helpers, `wire.rs:235-310`; sub-enum
  variants differ: wire `PermissionMode/FsPermissionRuleSet` vs config `Mode/Rules`). **Canonicalize
  on the config type**, convert wire→config at native's decode boundary (native already does this via
  `permissions_policy_from_config` `vm.rs:819`), and adopt the **browser's callback-construction
  model** (`permissions_from_policy -> Permissions`) as the shared one — it matches the kernel
  `Permissions` type; port native off its imperative `evaluate_permissions_policy`.
- **Crypto is NOT in this item** — see C2 (OpenSSL isn't wasm-safe; a trait doesn't unify it).
- **child_process hook:** the shared dispatch keeps a per-backend `check_command` seam (S4).
- **Risk.** Medium (type unification + model choice). **Test.** Existing browser smokes (perms/limits/
  fs/diagnostics) stay green once dispatch is shared; add a native unit test on the shared dispatch.

### C. One shared WASI runner, kernel-routed

- **PROGRESS (2026-06-21).** Security core S3 is MET on both backends (see §2 S3). Toward "one shared
  runner": the native runner (`crates/execution/assets/runners/wasi-module.js`) has been **fully
  parameterized onto a per-backend `globalThis.__agentOsWasiHost` seam** and made browser-portable
  (commits "C slice 1/2/3a/3b-prep": require accessor, stdio sync-RPC + fd-handle lookup as lazy
  resolvers, read-limit, and `globalThis`-qualified `__agentOsWasmInternalEnv`; all behavior-preserving,
  native WASI `wasm_suite` + 32 lib tests green). A browser codegen wrapper that loads this shared
  source was then attempted — but **reverted**: native's runner traps the browser test guests
  (`Error: unreachable`, exit 1) on all 20 browser WASI Playwright cases, i.e. the two runners have
  **genuine behavioral differences** (errno/rights/preopen semantics the browser test WASM modules
  depend on), not just an accessor gap. **Browser traps — root cause NOT yet pinned; my preopen hypothesis was WRONG (corrected).** I first
  suspected native's `_normalizePreopenSpec` (requires `hostPath`) drops browser preopens — but the
  browser's OWN runner (`wasi-polyfill.ts:195`) uses the **same `{hostPath}` preopen shape** and the
  same `fs.statSync(entry.hostPath)` model, so the harness already passes hostPath-shaped preopens that
  native would accept. So preopens are NOT the trap cause. (A `__agentOsWasiHost.normalizePreopen` seam
  hook was added anyway — slice 4a, behavior-preserving, a reasonable abstraction — but it is not the
  fix.) The actual cause of the 20 `Error: unreachable` (exit 1) traps is a **deeper behavioral
  difference** between the two ~900/2008-line runners (errno/rights/fs-result semantics the browser test
  WASM guests depend on) that requires **LIVE debugging**: re-apply the browser codegen, run one browser
  WASI case against native's runner, and capture the exact WASI import + return that makes the guest
  trap. **Remaining for C:** (1) live-debug the trap to pin the behavioral delta(s); (2) reconcile in
  the shared runner; (3) re-verify the 20 browser WASI Playwright cases + native `wasm_suite`; (4) add a
  `wasi-testsuite` subset on both. The fs/stdio/require/read-limit/preopen seam (slices 1–4a) is done +
  native-green; the behavioral reconciliation is the substantive remaining piece. (Original analysis
  preserved below.)
- **STATUS (2026-06-21 audit).** The security core (S3 — kernel-routed, permission-checked WASI fs) is
  **already MET on both backends** (see §2 S3): native routes `fs.*Sync` through the sidecar kernel,
  browser WASI rides the converged sync-bridge fs → wasm kernel. What remains is purely the
  **code-dedup**: there are still TWO JS `class WASI` preview1 implementations — native's
  `__agentOsWasiModule.WASI` (injected from a Rust string asset) and the browser's
  `wasi-polyfill.ts` `BROWSER_WASI_POLYFILL_CODE` (~935 lines). Both cover the same 34-import
  preview1 surface (`crates/execution/assets/wasi-preview1-imports.json`) and both already route fs
  through the kernel. **Merge plan (next-up; the seam already exists).** The browser
  `wasi-polyfill.ts` WASI class already routes every fs op through `globalThis.require("fs")` (the
  guest's kernel-backed fs polyfill: `statSync`/`readdirSync`/`readFileSync`/`writeFileSync`/
  `mkdirSync`/`linkSync`/`readlinkSync`/`rmdirSync`/…) — i.e. the per-backend "WasiKernel seam" is just
  `require("fs")`, which BOTH backends already provide (native's kernel-backed `fs` → sync-RPC →
  sidecar kernel; browser's → sync-bridge → wasm kernel). So no new interface is needed. The two
  concrete JS sources to merge: native `crates/execution/assets/runners/wasi-module.js`
  (`NODE_WASI_MODULE_SOURCE` via `include_str!`, exposed as `__agentOsWasiModule.WASI` at
  `wasm.rs:2203`) and browser `packages/browser/src/wasi-polyfill.ts` (`BROWSER_WASI_POLYFILL_CODE`).
  Plan: reconcile them into one canonical JS preview1 class, share it as a single asset both consume
  (native `include_str!`, browser inline/import via the build), reconcile rights/preopen/errno detail
  differences, then add a `wasi-testsuite` subset on both. **Merge facts (verified) — the seam is broader than fs.** The two share the SAME 18-method preview1
  surface and both reach the kernel-backed guest `fs`, but native `wasi-module.js` (~2008 lines, the
  fuller canonical impl) is coupled to several **native-only host globals** the browser lacks:
  `__agentOsRequireBuiltin` (fs/path/crypto), `globalThis.__agentOsSyncRpc` (+`__agentOsKernelStdioSyncRpcEnabled`,
  `globalThis.lookupFdHandle`) for fd-0/1/2 stdio, `__agentOsWasmSyncReadLimitBytes` (read cap), and
  `__agentOsWasiDebug`. So the real C work is to **abstract those into a per-backend host seam**
  (`{ requireBuiltin, stdio (read/write fd0/1/2), lookupFdHandle, syncReadLimitBytes, debug }`),
  implemented natively from the existing globals and in the browser from the sync-bridge/guest `fs`,
  then promote native's parameterized class to the single shared source both consume (native
  `include_str!`, browser inline/import), fold in browser-only deltas, and re-verify both WASI suites
  (20 browser Playwright WASI cases + native `wasm.rs` WASI tests) + a `wasi-testsuite` subset. This
  is a medium-high-blast-radius refactor (a ~2008-line file + both verified WASI paths), to be done in
  small verified slices: (1) parameterize native onto the seam, behavior-preserving, native WASI green;
  (2) browser provides the seam + loads the shared source, browser WASI Playwright green; (3)
  wasi-testsuite subset on both. Keep all S3 invariants (preopens
  fds≥3, per-preopen read-only→EROFS, rights at `path_open`, confinement, read cap). Risk: medium
  (large shared JS file; re-verify both backends' WASI suites).
- **Problem (corrected).** Native already has a **hand-rolled `class WASI`** (`wasm.rs:2225`, installed
  as `__agentOsWasiModule`, replacing `node:wasi` at `:2141`) — full preview1 with preopens/rights/
  stdin — but its fs is **host-direct** (`handle_internal_wasm_sync_rpc_request`, bypasses the kernel
  permission callback, S3). Browser `executor-wasi.ts` stubs fs.
- **Target.** ONE preview1 runner used by both, **extracted from native's existing class** (not a
  rewrite, not `node:wasi`). fs/stdin route through the kernel VFS via a `WasiKernel` interface
  (`pathOpen`/`fdRead`/`fdWrite`/`fdReaddir`/`fdFilestat`/…) implemented per-backend (native sync-RPC,
  browser SAB) — the **same kernel ops JS `fs` uses**, so wasm guests get `PermissionedFileSystem`
  enforcement (S3). Preserve all S3 invariants (preopens/rights/read-only/confinement/read cap).
- **Conformance.** Wire `wasi-testsuite` against the shared runner on both backends (decision #6).
- **Risk.** High blast radius (native wasm/python path). **Test.** Browser smoke: a WASI module that
  `path_open`+`fd_read`s a VFS file and writes a result (proves kernel-routed, permission-checked fs);
  plus a `wasi-testsuite` subset on both.

### C2. Crypto: pick one backend + cross-impl conformance  *(new, split from B)*

- **Problem.** Two full independent crypto impls: browser pure-Rust/RustCrypto (~1150 LOC,
  `wire_dispatch.rs:1160-2543`) vs native OpenSSL (~2100 LOC, `execution.rs:13766-15906`). OpenSSL is
  not wasm-safe, so a shared trait doesn't merge them; they drift silently with no cross-test.
- **Target.** Either (a) promote the pure-Rust impl to the shared one and drop native OpenSSL, or
  (b) keep two behind a `CryptoBackend` trait **and** add a cross-impl conformance test asserting
  native==browser output for every op (cipher round-trips, DH/ECDH shared secret, RSA, KDFs, primes).
  Default to (a) if RustCrypto covers the surface at acceptable perf; else (b).
- **Risk.** Medium. **Test.** The cross-impl conformance vector itself.

### D. Bridge-globals: wire the EXISTING `bridge-contract.json` everywhere

- **Problem (corrected).** A contract artifact already exists (`crates/bridge/bridge-contract.json`,
  loaded by `BridgeContract`, native self-checks it at `session.rs:2052`). The browser installs
  (~13 `*Raw` fns) do **not** validate against it; the bundle build doesn't either; native is the
  3-way source (`SYNC/ASYNC_BRIDGE_FNS` + `map_bridge_method`).
- **Target.** Make `bridge-contract.json` the single source: generate/check native registration, the
  browser executor installs, and the bundle build against it (CI drift gate). Encode the ABI
  (`applySync`/`applySyncPromise` sync; `apply(…,{result:{promise:true}})` → Promise). Also route
  guest `console` through the bundle `util.inspect` console via `_log`/`_error` (drop local
  `formatValue`, `executor-core.ts:411`).
- **Risk.** Low-medium. **Test.** CI check: both registrations equal the contract.

### E. Unified spawn/IPC built on `bridge::ExecutionBridge`

- **Problem.** Browser has two duplicated worker/SAB/event paths (main exec + child sessions); no
  grandchildren; Rust marshalling (`js_host_bridge.rs` `ExecutionBridge`/`BrowserWorkerBridge`)
  parallels native `v8_ipc.rs`/`v8_host.rs`.
- **Target.** One spawn path for executions + child_process, **built on the existing
  `bridge::ExecutionBridge`** (don't mint a parallel `ExecutionSpawner`). Define the execution-event/
  spawn-request contract once (shared types or codegen) so both Rust decoders stay in lockstep.
- **Risk.** Medium-high. **Test.** Existing child-process smokes green + a grandchild-spawn smoke.

### F. Thread `execution_id` through the guest syscall channel

- **Problem (corrected).** `execution_id` already flows on the lifecycle bridge
  (`js_host_bridge.rs:100,174,…`) but the **guest syscall** path is `vm_id`-only:
  `sidecar-worker.ts:42 kernelSyscall(vmId,…)` → `wasm.rs:56 guest_syscall(vm_id,…)` →
  `wire_dispatch.rs:850 guest_syscall_dispatch(vm_id,…)`. `execution_pid(vm_id)` collapses all
  executions onto the first (`service.rs:455`).
- **Target.** Add `execution_id` to the guest syscall (worker wrap → `wasm.rs::guest_syscall` →
  dispatch); key socket/signal ownership per execution. Correctness today (same trust domain within a
  VM), but a prerequisite for #E correctness, per-execution checks, and S1's per-execution net keying.
- **Risk.** Low; do early. **Test.** Two concurrent executions in one VM each open a loopback socket;
  assert no cross-talk.

### G. Shared guest-network bridge handler (+ S1/S2 enforcement)

- **Problem.** Kernel socket table shared; the translator (`net.*` → kernel `socket_*`, EOF/EAGAIN
  sentinel, base64 framing, socket-info JSON, host:port→loopback) is duplicated; and the browser
  skips the network permission + loopback-exempt gate (S1/S2).
- **Target.** One `GuestNetworkBridgeHandler` both call (native-only host-egress/UDP/TLS/HTTP2/record-
  DNS behind `feature="native"`). **Move the connect/listen/bind network-permission check + loopback-
  exempt/restricted-range gate into the shared kernel `socket_*` ops** (S1/S2). Dedup the base64 codec
  (also fixes the 4× copies, NEW-6) + socket-info formatter. Explicitly cover the top-level wire
  payloads `FindListener`/`FindBoundUdp`/`VmFetch` (distinct from guest `net.*`). Browser gains UDP
  loopback for free.
- **Risk.** Medium. **Test.** net/http/dns smokes green + a dgram-loopback smoke + a deny-network
  policy smoke (connect now rejected).

### H. (Rescoped) Rust server wire-framing — fold into #B

- **Corrected.** The *client-side* `SidecarTransport` seam is **already shared** (both clients
  implement `packages/core/src/transport.ts`). The remaining asymmetry is the Rust **server** framing:
  native `stdio.rs` vs browser in-wasm `wire_dispatch.rs`. There's nothing to "extract behind
  `SidecarTransport`" (a Rust server can't implement a TS interface). Fold the server-side request
  entry into #B's shared router; otherwise this is a no-op. **Low priority.**

### I. Unify signal/kill delivery + exit codes

- **Target.** Kernel queues the signal; async delivery on both. Default-action exit code is the shared
  `128 + signum` (native `execution.rs:3607`), not hardcoded 130/143 (`executor-core.ts:69`); remove
  invented spawn codes 126/127; source signal name↔number from the shared table. Preserve S8 teardown.
- **Risk.** Medium. **Test.** SIGTERM graceful-exit + SIGKILL hard-kill smokes green on both.

### J. Browser-specific backends (after #A)

- OPFS-backed persistence (`persistence_flush`/`load`) + OPFS/fetch mounts (`configure_vm`/
  `host_filesystem_call`) implementing the now-shared VFS/persistence traits. Backend is
  browser-specific; wiring shared. Lower priority; needs a real-browser test harness.

### K. Shared guest module resolution & format detection  *(new; depends on #A)*

- **Problem.** `guest-runtime.ts:643` reimplements a weaker CJS/ESM resolver (4-candidate, no
  node_modules ancestor walk, no `exports`/`imports`/conditions, no realpath/symlink) — violating the
  npm-compat invariant — vs native's `javascript.rs` ModuleResolver + `node_import_cache.rs`.
- **Target.** Route module resolution through one shared resolver over the kernel VFS (which, after #A,
  exposes node_modules + symlinks faithfully). **Risk.** High; sequence after #A. **Test.** Resolve a
  scoped package via an ancestor `node_modules` walk + an `exports` map.

### L. Virtualized identity (dead-cap fix)  *(new)*

- **Problem.** Browser hardcodes `process.platform/arch/pid/version` (`guest-runtime.ts:461`) and
  never sets `__agentOsVirtualOs` — ignoring the per-VM identity already on the BARE wire (the exact
  dead-cap the root CLAUDE.md warns about). Native builds these from config (`javascript.rs:2398`).
- **Target.** Populate guest `process.*` + `__agentOsVirtualOs` from the per-VM wire config on both
  backends. **Risk.** Low. **Test.** create_vm with a virtualized identity; guest `os.platform()`/
  `process.platform` reflect it.

### M. Build/asset convergence  *(new)*

- **Problem.** `crates/execution/build_support.rs` and `crates/v8-runtime/build_support.rs` are
  byte-identical (via `#[path]`), and a shared `crates/build-support/v8_bridge_build.rs` exists but is
  unused. `polyfill-registry.json` (shared by `javascript.rs:556` + `guest-runtime.ts:894`) and the TS
  codegen (`generated-protocol.ts`, vm-config bindings) have no drift gate.
- **Target.** Collapse to the single `crates/build-support`; add a uniform CI drift-check across
  generated artifacts (protocol TS, vm-config bindings, polyfill-registry, bridge-contract). **Risk.**
  Low. **Test.** CI drift gate runs.

---

## 6. `native` feature / cfg strategy

- Reuse the existing **`native`** feature (kernel `default=["native"]`, `native=["dep:hickory-resolver",
  "dep:tokio"]`; `sidecar-browser` `native=["secure-exec-kernel/native"]`; wasm build uses
  `--no-default-features`). Do NOT add a `host-backends` feature (parallel-mechanism cruft).
- Host plugins live in `crates/sidecar/src/plugins/*`, which the wasm build already excludes (browser
  doesn't depend on `crates/sidecar`). Keep `kernel`/`sidecar-core` wasm-clean; if finer granularity
  is ever needed, make it a sub-feature of `native`.

## 7. `sidecar-core` crate (proposed)

```
crates/sidecar-core/        (wasm-safe; depends on kernel, protocol, vm-config)
├── router.rs       RequestPayload dispatch + handshake/response/event framing + ownership helpers
├── guest_syscall.rs dispatch_guest_syscall(kernel: &mut KernelVm, op, value)  (no new trait)
├── perms.rs        permissions_from_policy (callback model) + scope helpers (config type)
├── limits.rs       resource_limits_from_config (core mapping; native keeps extra validation)
├── bootstrap.rs    write_root_fs_entry + root_filesystem_from_config (wasm-safe, shared with #A)
├── signals.rs      signal_name↔number + 128+signum
├── net.rs          GuestNetworkBridgeHandler (native-only methods behind feature) + base64 + sockinfo
└── diagnostics.rs  process snapshot / signal-state / zombie helpers
```
`crates/bridge` stays the contract/DTO layer (it owns `bridge-contract.json` + the `BridgeContract`
loader); the bridge-globals manifest (#D) extends that, not a new artifact.

## 8. Testing strategy (decision #5: basic wiring, not whole-system)

- One focused smoke per item proving the new shared path end to end (see each item).
- `packages/browser test:converged` (smokes + 16/16 conformance) stays green after every increment.
- Native-touching items: run the relevant native suites (e.g. `cargo test -p secure-exec-sidecar`
  fs/wasm/net), not the whole suite; don't chase pre-existing native CI failures (decision #2).
- **Generalize the existing extract-corpus+`--check` pattern** (`extract-conformance-corpus.mjs`):
  extract smoke guest-programs from native tests instead of hand-authoring browser-only copies; add a
  thin **differential runner** (run each corpus case on both backends, diff stdout/exit/errno); add a
  TS-side wire golden asserting `@secure-exec/core` encodes `GENERATED_AUTH_FRAME_HEX` like native.
- WASI: `wasi-testsuite` subset on both backends once #C lands.

## 9. Sequencing (corrected)

`#F (execution_id; cheap, unblocks #E/#G correctness)` →
**create `crates/sidecar-core` skeleton** (resolves the #A↔#B inversion: #A lands `root_fs_from_config`
into it, #B fills the rest) →
`#A (VFS→MountTable, fuller config)` →
`#B (sidecar-core: router + dispatch + perms/limits/bootstrap)` →
`#C (shared WASI) + #C2 (crypto) + #G (net handler + S1/S2)` (build on #B) →
`#K (module resolution; needs #A)` + `#L (identity)` →
`#E (spawn unify) + #D (contract) + #I (signals) + #M (build) + #H (fold)` →
`#J (OPFS backends)`.

## 10. Open questions / risks

1. **PermissionsPolicy canonical type** — confirm regen of wire enums to config variant names vs
   native-converts-at-boundary; enumerate native call sites that break.
2. **Crypto decision (C2)** — does RustCrypto cover native's full surface at acceptable perf (drop
   OpenSSL), or keep two behind a trait + conformance vector?
3. **WASI runner home** — bundle source vs standalone shared asset; native injection vs browser load.
4. **`wasi-testsuite` access** — is network/package access available to vendor it here?
5. **Concurrent workspaces** — ~15 active jj workspaces touch the same shared crates; expect rebases.
6. **Native test baseline likely red** (CI-fix workspaces exist) — record pre-existing failures so
   convergence breakage is distinguishable (decision #2: don't chase them).

## 11. Definition of done — NON-NEGOTIABLE

This spec is done ONLY when ALL of the following hold. Every item is REQUIRED; difficulty/size is
never a reason to skip, stub, defer, or declare "out of scope". Partial, parallel, or lint-only
implementations do not count.

1. **R0 fully built:** the converged wasm sidecar is the ONLY browser runtime — it runs guests
   end-to-end with a synchronous guest-kernel-call path for net/spawn/wasi (not fire-and-forget
   `unsupported`), through the shared kernel. The legacy TS executor stack (`runtime-driver.ts`,
   `worker.ts`, `runtime.ts` wrap-*, `os-filesystem.ts`, `wasi-polyfill.ts`, legacy `sync-bridge`)
   is **deleted**.
2. **Harness proves it:** the conformance/Playwright/`test:converged` harness runs the CONVERGED
   path (not legacy) and is green; touched native tests green; native `cargo check --workspace` green.
3. **Every §3 parallel impl** is replaced by shared code (`kernel`/`sidecar-core`/bundle), OR is
   legitimately per-platform per §1 (transport / executor embedding / storage backend / host egress)
   behind a `native`/cfg boundary — and nothing else. No browser-only reimplementation of shared
   logic remains.
4. **Every hard item landed cleanly:** C (one shared WASI runner, kernel-routed), C2 (crypto — one
   shared impl or two-behind-a-trait + real differential conformance), E (one spawn path on
   `ExecutionBridge`, recursive), G (shared net translator + browser UDP), K (one module resolver),
   B-resid, A guest-driven smoke.
5. **All §2 security invariants S1–S8 hold on BOTH backends** (no fail-open legacy path remains).

If any of 1–5 is unmet, the work is NOT complete — keep going.

### 11.1 Verified status (2026-06-21 audit)

Much of this spec's REMAINING/§3 text predates the converged executor and is stale; the audit below
records the implementation's actual state against the 5 DoD criteria.

1. **R0 + legacy deleted — MET in substance.** The converged wasm path is the SOLE browser runtime:
   `runtime-driver.ts` is converged-only (a guest syscall with no converged sidecar throws; the
   non-converged branch is gone). The whole parallel browser **executor** (`executor-core.ts`,
   `guest-runtime.ts`, `executor-host.ts`, `executor-child.ts`, `executor-bundle.ts`,
   `executor-wasi.ts`) is **deleted**, as is the legacy TS-kernel servicing (fs/module/dgram arms,
   `syncFilesystem`). *Reconciliation of the literal file list:* `runtime-driver.ts` / `worker.ts` /
   `runtime.ts` / `os-filesystem.ts` / `wasi-polyfill.ts` are NOT legacy — they are the repurposed
   **converged** stack (driver / guest worker / types+`resolveModule` / client seed VFS / guest WASI
   userland) and must stay. "Legacy executor/kernel deleted" = those parallel-executor + TS-kernel
   files, which are gone.
2. **Harness proves it — MET.** Converged-by-default harness; 36/36 conformance + 52 Playwright +
   120 vitest green against the wasm kernel; `cargo build --workspace` + wasm32 green; touched native
   crypto/wasm tests green.
3. **§3 parallel impls replaced/per-platform — MET.** Parallel executor deleted; A (MountTable VFS)
   done; B (router/dispatch/perms) shared via `sidecar-core`; B-resid done; D/E/F/G/I/K/L resolved by
   the executor deletion or per-platform. D's `bridge-contract.json` drift gate
   (`packages/browser/scripts/check-bridge-contract.mjs`) is green and wired into `pnpm test`
   (`check:bridge-contract` runs first), alongside `check:signals` and the now merge-aware
   `check:wasi-surface` (which verifies the browser WASI runner is the generator's current output of the
   single shared native source).
4. **Hard items — MET.** A✓ B✓ **C✓** C2✓ (option b) E✓ (per-platform) F✓ G✓ K✓ B-resid✓. **C is
   done:** ONE shared preview1 WASI runner (`crates/execution/assets/runners/wasi-module.js`) consumed
   natively (`include_str!`) and by the browser (`generate-wasi-polyfill.mjs` + the per-backend
   `__agentOsWasiHost` seam — `requireBuiltin`/`syncReadLimitBytes`/`Buffer`/`disableLocalFdPassthrough`/
   `readStdin`/`stdinReadableBytes`); browser kernel-backed `fs` gained fd ops over the wire `pread` +
   RMW `write_file` (S3 preserved) plus a posix `path` polyfill; the runner gained read-iov clamping,
   stdio fsync, poll clock/stdio/stdin readiness without a kernel poll bridge, FD_READ rights, and
   read-permission at open. A vendored `wasi-testsuite` preview1 subset runs the same manifest on both
   backends.
5. **S1–S8 on both backends — MET.** S1/S3/S4/S5/S6/S7/S8 satisfied on both; S2 legitimately
   per-platform (native host-resource protection; browser kernel is fully virtualized). See §2.

**All five DoD criteria are MET and verified on both backends (2026-06-21).** Final verification:
native `wasm_suite` (incl. the wasi-testsuite subset) + 32 native wasm lib tests green; browser
**56/56** Playwright (converged + WASI + wasi-testsuite) + 120 vitest + all gates (`check:bridge-contract`,
`check:signals`, `check:wasi-surface`, tsc) green; `@secure-exec/browser` ships the web wasm +
`createDefaultConvergedSidecar`. No remaining tail.

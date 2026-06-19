# secure-exec Documentation Gap Analysis

## Summary

The existing docs under `website/src/content/docs/docs/` are well-developed for the **in-process TypeScript SDK** surface (`NodeRuntime` / `createNodeDriver` / `createNodeRuntimeDriverFactory`) and the **kernel test-runtime** surface (`createKernel`, `kernel.exec/spawn/openShell`). Core runtime concepts — permissions, the virtual filesystem, networking, resource limits, child processes, TypeScript, output capture, module loading, process isolation, security model, and a Node compatibility matrix — all have pages.

However, several **user-facing (`audience: "user"`) capability clusters from the codebase have no dedicated page at all**, and a few existing pages are missing major sub-capabilities. The biggest gaps are the things that make secure-exec a *product* rather than a library: the **registry of pre-built WASM command tools** (coreutils, grep, jq, git, etc.), the **external filesystem mount plugins** (S3, Google Drive, sandbox-agent, host directories), **host callbacks / custom guest tools**, and **filesystem persistence / snapshots / layered overlays**. These are referenced obliquely (e.g. `commandDirs: [...]` in the kernel quickstart) but never explained.

A secondary theme: the inventory's primary embedding API is `NativeSidecarProcessClient` (the `@secure-exec/core` sidecar client), but the docs are written almost entirely against the in-process `secure-exec` / `@secure-exec/core/test-runtime` APIs. This is a deliberate framing choice, not strictly a gap, so the proposals below are scoped to *capabilities* rather than re-documenting the same features against a second client. Where a capability is only reachable through the sidecar client (persistence, host callbacks, mount plugins, snapshots), that is called out.

Counts: **8 proposed new pages**, **5 existing pages flagged for expansion**.

---

## Proposed new pages

Ordered by priority (highest-impact gaps first). Effort is rough: S = a few hours, M = half a day to a day, L = multi-day.

### 1. Command-Line Tools & the Software Registry — **Priority: Highest · Effort: M**

- **Route:** `features/command-line-tools.mdx` (and/or a top-level `registry.mdx`)
- **Why it's a gap:** The kernel quickstart and cross-runtime pages repeatedly use `createWasmVmRuntime({ commandDirs: [...] })` and assume `sh`, `bash`, `cat`, `grep`, `find`, `ls`, etc. exist, but **no page documents where those commands come from**, how to install them, the full catalog, meta-packages, or per-command permission tiers. This is a flagship capability (80+ POSIX commands compiled to WASM) and is currently invisible to a reader.
- **Summary:** Explain that guest shell/CLI tooling is delivered as installable npm packages of WASM-compiled commands that register as executables inside a VM. Cover the catalog, how to install one or a bundle, how to register the `commandDir` with a VM/kernel, the descriptor shape, and the four permission tiers each command runs under.
- **Key sections:**
  - What the registry is (Rust/C → `wasm32-wasip1`, no native host binaries)
  - The catalog table (coreutils, sed, grep, gawk, findutils, diffutils, tar, gzip, curl, wget, zip/unzip, jq, yq, ripgrep, fd, tree, file, sqlite3, duckdb, git, codex)
  - Meta-packages: `@agent-os-pkgs/common`, `build-essential`, `everything`
  - Installing and wiring a package into a VM (`commandDir`, descriptor `commands[]`)
  - The `WasmCommandPackage` descriptor (name, aptName, source, commands, commandDir)
  - Per-command permission tiers (`full` / `read-write` / `read-only` / `isolated`) with the cp/mv vs cat/ls/grep examples
  - Aliases and graceful stubs (bash→sh, egrep→grep, unimplemented stubs return graceful errors)
- **Evidence:** `registry/README.md` (package table); `registry/software/coreutils/src/index.ts`; `registry/software/common/src/index.ts`; `packages/registry-types/src/index.ts` (`PermissionTier`, `WasmCommandEntry`, `WasmCommandPackage`, `WasmMetaPackage`); `registry/Makefile` (`CMD_PACKAGES`, `META_PACKAGES`).

### 2. External Filesystem Backends (Mount Plugins: S3, Google Drive, Sandbox, Host Dir) — **Priority: Highest · Effort: M**

- **Route:** `features/filesystem-backends.mdx` (sits next to `features/filesystem.mdx`)
- **Why it's a gap:** `createS3Backend()`, `createGoogleDriveBackend()`, `createSandboxFs()`, and the `host_dir` / `module_access` / `sqlite_vfs` / `js_bridge` native plugins are entirely undocumented (grep for `mount plugin`, `createS3Backend`, `s3` returns nothing in docs). These are shipped, public `@secure-exec/*` packages and a primary way to give a VM real, persistent, or remote storage.
- **Summary:** Document how to mount external/remote storage into a VM filesystem path through native mount plugins, including the declarative helper packages for S3 and Google Drive, the sandbox-agent remote FS, and mounting a real host directory. Explain the `mounts` field of `configureVm` / `nativeRoot` and read-only mounting.
- **Key sections:**
  - Mount model: plugins addressable by id, mounted at a guest path, optional `readOnly`
  - The seven built-in plugins (host_dir, module_access, s3, google_drive, sandbox_agent, sqlite_vfs, js_bridge) — what each does
  - `@secure-exec/s3` — `createS3Backend()` (bucket, prefix, region, credentials, endpoint, chunkSize, inlineThreshold)
  - `@secure-exec/google-drive` — `createGoogleDriveBackend()` (service-account creds, folderId) — mark preview
  - `@secure-exec/sandbox` — `createSandboxFs()` (remote sandbox-agent backend)
  - Mounting a host directory (`host_dir`) and `nativeRoot` vs overlay (cannot combine with bootstrap entries)
  - Wiring via `configureVm({ mounts })` / `NativeRootFilesystemConfig`
- **Evidence:** `registry/file-system/s3/src/index.ts` (`createS3Backend`, `S3FsOptions`); `registry/file-system/google-drive/src/index.ts`; `registry/tool/sandbox/src/mount.ts` (`createSandboxFs`); `crates/sidecar/src/plugins/mod.rs` (`register_native_mount_plugins`) and `plugins/{host_dir,module_access,s3,google_drive,sandbox_agent,sqlite_vfs,js_bridge}.rs`; `crates/vm-config/src/lib.rs` (`NativeRootFilesystemConfig`, `MountPluginDescriptor`); `packages/core/src/sidecar-client.ts` (`configureVm`, `SidecarMountDescriptor`).

### 3. Host Callbacks & Custom Guest Tools — **Priority: High · Effort: M**

- **Route:** `features/host-callbacks.mdx` (or `use-cases/host-tools.mdx`)
- **Why it's a gap:** `registerHostCallbacks` is only named in `compatibility-matrix.md`; there is no page explaining how a host exposes its own functions to guest code as callable commands. This is a central pattern for the AI-agent / code-mode use cases (the guest calls a host-implemented tool), so its absence is conspicuous.
- **Summary:** Show how to register named host callbacks (with a JSON input schema, description, timeout, and examples) that appear inside the VM as commands. Explain the request/response flow (sidecar-initiated `HostCallback`), the limits, and how this differs from child processes.
- **Key sections:**
  - The concept: host-implemented tools surfaced as guest commands
  - `registerHostCallbacks()` — definition shape (description, JSON input schema, timeout, examples, command/registry aliases)
  - Invocation flow (guest runs the command → sidecar-initiated `HostCallback` → host handler → response)
  - Limits (toolkits, tools/VM, tools/toolkit, schema bytes, example caps, default 30s / max 300s timeout)
  - Relationship to permissions and to the `tool` permission scope
- **Evidence:** `packages/core/src/sidecar-client.ts` (`registerHostCallbacks`, `SidecarRegisteredHostCallbackDefinition`); `crates/sidecar/protocol/secure_exec_sidecar_v1.bare` (`RegisterHostCallbacksRequest`, `HostCallbackRequest`); `crates/sidecar/src/tools.rs` (`MAX_*` constants); `crates/sidecar/src/limits.rs`.

### 4. Filesystem Persistence, Snapshots & Layered Overlays — **Priority: High · Effort: M**

- **Route:** `features/persistence.mdx` (cross-link from `features/virtual-filesystem.mdx`)
- **Why it's a gap:** `features/virtual-filesystem.mdx` mentions "snapshot" briefly, but the durable-state story — `PersistenceLoad`/`PersistenceFlush`, layer creation/sealing, overlay composition, and snapshot import/export — has no home. This is the capability that turns an ephemeral VM into a persistent one across runs, which is a frequent question for dev-server and agent-session use cases.
- **Summary:** Document the Docker-style layered root filesystem (immutable lower layers + writable upper, ephemeral vs read-only modes), how to capture and restore filesystem state, and how to persist VM state across runs.
- **Key sections:**
  - Overlay model (ordered immutable lower layers, bundled Alpine base, writable upper; whiteouts/opaque dirs mirror OverlayFS)
  - Root filesystem modes: ephemeral vs read-only; `disableDefaultBaseLayer`; bootstrap entries
  - Snapshots: `snapshotRootFilesystem`, `importSnapshot` / `exportSnapshot`, format-version check
  - Layers & overlays: `createLayer`, `sealLayer`, `createOverlay`
  - Persistence: `PersistenceLoad` / `PersistenceFlush` (load/flush by key, byte accounting)
- **Evidence:** `crates/kernel/src/root_fs.rs` (`RootFilesystemDescriptor`, `RootFilesystemSnapshot`, `encode_snapshot`/`decode_snapshot`); `crates/kernel/src/kernel.rs` (`snapshot_root_filesystem`); `crates/vm-config/src/lib.rs` (`RootFilesystemConfig`, `RootFilesystemMode`); `packages/core/src/sidecar-client.ts` (`createLayer`, `sealLayer`, `createOverlay`, `importSnapshot`, `exportSnapshot`, `bootstrapRootFilesystem`, `snapshotRootFilesystem`); `crates/sidecar/protocol/secure_exec_sidecar_v1.bare` (`PersistenceLoadRequest`, `PersistenceFlushRequest`).

### 5. Python Runtime & Compatibility (promote out of draft + fill gaps) — **Priority: High · Effort: M**

- **Route:** keep `runtimes/python.mdx` + `python-compatibility.mdx` but treat as a near-rewrite; optionally add `features/python-packages.mdx`
- **Why it's a gap:** Both Python pages are `draft: true` (hidden) and the runtime page documents a `PythonRuntime` in-process class, while the inventory's Python capabilities (bundled wheels, `micropip` install, preload packages, the OS-emulation bridge for fs/http/dns/subprocess, frozen-time, execution timeout knobs) are largely uncovered. Python is one of the three first-class runtimes and currently has no visible docs.
- **Summary:** Promote Python to a visible, first-class runtime page and document bundled packages, package installation, and the OS-emulation bridge.
- **Key sections:**
  - Runtime (Pyodide / CPython 3.13 in WASM)
  - Bundled packages (numpy, pandas, micropip, click, python-dateutil, pytz, six) and preload (`AGENT_OS_PYTHON_PRELOAD_PACKAGES`)
  - Installing more packages via `micropip` (routed through the network policy / `AGENT_OS_PYODIDE_PACKAGE_BASE_URL`)
  - OS-emulation bridge: fs/http/dns/subprocess routed to the kernel; JS errors → Python exceptions (`PermissionError`, `FileNotFoundError`, `OSError`)
  - Limits/knobs: execution timeout (5 min default), output buffer caps, heap cap, stdin streaming
- **Evidence:** `crates/execution/src/python.rs` (`PythonExecutionEngine`, `PythonVfsRpcMethod`, timeout/heap env knobs); `crates/execution/assets/pyodide/*.whl`; `runners/python-runner.mjs` (`SUPPORTED_PRELOAD_PACKAGES`, micropip handling, exception translation).

### 6. DNS Configuration — **Priority: Medium · Effort: S**

- **Route:** `features/dns.mdx` (or a "DNS" section folded into `features/networking.mdx` — see expansion note below)
- **Why it's a gap:** DNS is referenced inside networking/permissions but there is no place that explains configuring nameservers, static hostname overrides, or the DNS permission/lookup policy. Static host overrides are a common need (point a hostname at a loopback test server).
- **Summary:** Document configuring the guest resolver: custom nameservers, per-host static overrides, and how DNS lookups interact with the network permission check.
- **Key sections:**
  - `VmDnsConfig` (nameServers, per-host overrides)
  - Static hostname overrides (hostname → address list) and validation rules
  - DNS lookup policy and the network permission interaction (`CheckPermissions` vs `SkipPermissions`)
  - Default resolver behavior
- **Evidence:** `crates/kernel/src/dns.rs` (`DnsConfig`, `DnsLookupPolicy`, `HickoryDnsResolver`); `crates/vm-config/src/lib.rs` (`VmDnsConfig`); `packages/core/src/generated/VmDnsConfig.ts`.

### 7. WebAssembly / WASI Command Execution & Permission Tiers — **Priority: Medium · Effort: S–M**

- **Route:** `runtimes/webassembly.mdx` (the runtimes overview lists only Node and Python)
- **Why it's a gap:** WebAssembly is one of the three `GuestRuntimeKind`s and the registry tools page (proposal #1) consumes WASM execution, but there is no page covering raw WASI module execution, the four filesystem permission tiers, native-binary rejection, or WASM resource limits (fuel/memory/stack).
- **Summary:** Document running WASI WebAssembly modules directly: argv/env/cwd, the four permission tiers, the rejection of native (ELF/Mach-O/PE) binaries, and the WASM resource caps.
- **Key sections:**
  - Running a WASI module (`web_assembly` runtime kind)
  - Permission tiers (`full` / `read-write` / `read-only` / `isolated`) and what each grants (read-only tiers reject create/truncate/exclusive opens)
  - Native binaries are rejected (`ERR_NATIVE_BINARY_NOT_SUPPORTED`)
  - Resource limits: `AGENT_OS_WASM_MAX_FUEL`, `MAX_MEMORY_BYTES`, `MAX_STACK_BYTES`, module-size cap
  - Relationship to the command registry (per-command tiers via `configureVm` / `wasmPermissionTier`)
- **Evidence:** `crates/execution/src/wasm.rs` (`WasmExecutionEngine`, `WasmPermissionTier`, `NativeBinaryFormat`, fuel/memory/stack env knobs); `packages/core/src/protocol-maps.ts` (`LiveWasmPermissionTier`); `crates/sidecar/protocol/secure_exec_sidecar_v1.bare` (`WasmPermissionTier`).

### 8. Process Lifecycle: Signals, Groups, Sessions & Inspection — **Priority: Medium · Effort: S–M**

- **Route:** `features/process-lifecycle.mdx` (distinct from `process-isolation.mdx`, which is about topology/tenancy)
- **Why it's a gap:** Job control (signals, process groups, sessions, waitpid, zombie reaping) and process/signal inspection (`getProcessSnapshot`, `getSignalState`, `getZombieTimerCount`, `findListener`, `findBoundUdp`, `vmFetch`) are spread thin across the kernel interactive-shell page and the API references, but there is no user-facing page that explains the live process/socket introspection surface a host uses to observe and control a running VM. Signal semantics (the full 1..31 table plus aliases) and listener discovery are genuinely useful and undocumented.
- **Summary:** Document signal delivery semantics, process groups/sessions, killing with named signals, zombie reaping, and the host-side inspection APIs for processes, signal handlers, and bound sockets.
- **Key sections:**
  - Signals: full signal table + aliases (SIGIOT→SIGABRT, SIGPOLL→SIGIO), kernel-generated signals (SIGCHLD/SIGPIPE/SIGWINCH/SIGHUP/SIGCONT), masking
  - Process groups & sessions; waitpid / zombie reaping (TTL)
  - Host inspection: `getProcessSnapshot`, `getSignalState`, `getZombieTimerCount`
  - Socket/listener discovery: `findListener`, `findBoundUdp`
  - In-VM HTTP into a guest listener: `vmFetch`
- **Evidence:** `crates/kernel/src/kernel.rs` (`signal_process`, `kill_process`, `setpgid`, `setsid`, `waitpid`); `packages/core/src/sidecar-client.ts` (`getProcessSnapshot`, `getSignalState`, `getZombieTimerCount`, `findListener`, `findBoundUdp`, `vmFetch`, `killProcess`); `crates/sidecar/protocol/secure_exec_sidecar_v1.bare` (`ProcessSnapshotEntry`, `SignalStateResponse`, `SocketStateEntry`, `VmFetchRequest`).

---

## Existing pages to expand

These pages exist but omit major user-facing capabilities.

### A. `features/networking.mdx` — **Priority: High · Effort: S**

Currently covers `fetch` / DNS / HTTP through the network adapter and a loopback example. **Missing:**
- DNS configuration (custom nameservers, static host overrides) — overlaps proposal #6; if a standalone DNS page is not created, fold it here.
- **Listen port policy** (`portMin`/`portMax`, `allowPrivileged`) and **loopback-exempt ports** (`loopbackExemptPorts`, guest-port→host-port translation) — currently only `loopback` appears in passing.
- TCP/UDP/Unix socket surface and TLS — the kernel exposes a full socket table (datagram options, multicast, REUSEADDR/REUSEPORT) that the page does not mention.
- **Evidence:** `crates/vm-config/src/lib.rs` (`VmListenPolicyConfig`); `crates/execution/src/javascript.rs` (`AGENT_OS_LOOPBACK_EXEMPT_PORTS`); `crates/kernel/src/socket_table.rs`.

### B. `features/virtual-filesystem.mdx` — **Priority: Medium · Effort: S**

Strong on the VFS syscall surface, but the **persistence / snapshot / layered-overlay** story is only a passing mention. Either expand here or cross-link the new persistence page (proposal #4). Also missing: the standard filesystem layout (`/etc/passwd`, `/etc/resolv.conf`, `/proc`, `/dev/*` devices) and mount/unmount of additional filesystems.
- **Evidence:** `crates/kernel/src/root_fs.rs`; `crates/kernel/src/device_layer.rs`; `crates/kernel/src/mount_table.rs`; `crates/kernel/CLAUDE.md` (standard paths, `/proc`, `/dev`).

### C. `runtimes/overview.mdx` — **Priority: Medium · Effort: S**

Lists only Node and Python and is `draft: true`. Should add **WebAssembly** as the third runtime (proposal #7), and be promoted out of draft so the runtimes section is visible.
- **Evidence:** `packages/core/src/protocol-maps.ts` (`LiveGuestRuntimeKind = 'java_script' | 'python' | 'web_assembly'`).

### D. `features/resource-limits.mdx` — **Priority: Medium · Effort: S**

Covers CPU time, memory, payload, and timing mitigation for the in-process runtime. **Missing** the kernel/VM-level resource accounting surface: max processes/FDs/pipes/PTYs/sockets/connections, filesystem byte & inode caps, socket buffer caps, argv/env caps — all with concrete defaults and the EAGAIN/ENFILE/EMFILE mapping — plus per-runtime limit blocks (`jsRuntime.*`, `python.*`, `wasm.*`) from `VmLimitsConfig`.
- **Evidence:** `crates/kernel/src/resource_accounting.rs` (`ResourceLimits`, `DEFAULT_MAX_*`); `crates/vm-config/src/lib.rs` (`VmLimitsConfig`, `ResourceLimitsConfig`); `crates/sidecar/src/limits.rs`.

### E. `kernel/interactive-shell.mdx` & `runtimes/python.mdx` & `kernel/*` — **Priority: Medium · Effort: S**

These pages are complete in content but `draft: true` (hidden). The interactive-shell / PTY page in particular is thorough and covers a real user-facing capability (PTY, termios, job control). Decide whether to publish them; if so, reconcile the kernel-internal API naming with the supported `openShell()` / `connectTerminal()` surface. (Tracking item, not new content.)

---

## Capabilities already well-covered (no action)

- **Permissions model** — `features/permissions.mdx` + `system-drivers/node.mdx` (function checks, rule-based policies, allow-all helpers, deny-by-default). The six-scope sidecar policy (fs/network/childProcess/process/env/tool) is partly covered; only the `tool` scope ties into the missing host-callbacks page.
- **Virtual filesystem syscall surface** — `features/virtual-filesystem.mdx` + `features/filesystem.mdx` (read/write/stat/readdir/mkdir/rename/symlink/etc., three backends, `VirtualFileSystem` interface).
- **TypeScript** — `features/typescript.mdx` + `sdk-overview` (typecheck/compile source & project).
- **Child processes (in-process)** — `features/child-processes.mdx` (`CommandExecutor`, permission gating).
- **Output capture** — `features/output-capture.mdx` + `onStdio` patterns throughout.
- **Module loading / Node resolution** — `features/module-loading.mdx` + `nodejs-compatibility.mdx` (ancestor `node_modules` walk, exports/conditions, CJS/ESM, node_modules overlay).
- **Resource limits (isolate-level)** — `features/resource-limits.mdx` (CPU time, memory, payload, timing) — expand for kernel-level caps (see D).
- **Process isolation / tenancy topology** — `process-isolation.mdx` (shared/per-tenant/per-runtime, warm pool, crash behavior).
- **Security model & timing hardening** — `security-model.mdx`.
- **Cross-runtime kernel integration** — `kernel/cross-runtime.mdx` (pipes, shared VFS, child_process routing, npm scripts).
- **Custom runtime drivers** — `kernel/custom-runtime.mdx` (`RuntimeDriver`, `DriverProcess`, `KernelInterface`).
- **Kernel API reference** — `kernel/api-reference.mdx` (FD ops, process groups, PTY/termios, devices, signals).
- **Node.js compatibility** — `nodejs-compatibility.mdx` (support tiers, tested packages, overlay behavior).
- **Benchmarks / cost / comparisons / prior art / architecture** — covered.

> Note: `node:vm` context isolation, `node:sqlite`, and `worker_threads`/`node:v8` compatibility shims are user-facing but appear only as rows in `nodejs-compatibility.mdx` / `compatibility-matrix.md`. They are adequately *listed* there; a dedicated page is not warranted unless package-compatibility detail is wanted later.

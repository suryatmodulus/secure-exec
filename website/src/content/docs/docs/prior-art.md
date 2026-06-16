---
title: Prior Art — Unix/Linux in the Browser
description: How other browser-based Unix and Linux projects approach the problem, and why wasmVM made different choices.
draft: true
---

> How other projects approach the same problem wasmVM solves, and why we made different choices.

## Landscape

| Project | Stars | Approach | Browser | Real Binaries | Process Model | Maintained |
|---------|-------|----------|---------|---------------|---------------|------------|
| **wasmVM** | — | WASM multicall + JS WASI polyfill | Yes | Yes (Rust→WASM) | Workers + SharedArrayBuffer | Yes |
| **v86** | 22K | x86 CPU emulator in WASM | Yes | Yes (x86 emulated) | Real Linux kernel | Yes |
| **WebVM** | 16K | x86 JIT (CheerpX) in browser | Yes | Yes (x86 emulated) | Real Linux kernel | Yes |
| **WebContainers** | 4.6K | Proprietary WASM OS | Chrome-focused | Yes | Proprietary | Yes (commercial) |
| **Browsix** | 3.2K | Emscripten + Workers as processes | Yes | Yes (C→Emscripten) | Workers + postMessage | No (2016-era) |
| **container2wasm** | 2.6K | Docker→WASM converter, CPU emulation | Yes | Yes (x86/RISC-V emulated) | Emulated kernel | Yes |
| **just-bash** | 1.9K | Pure TypeScript bash reimplementation | Yes | No (TS impls) | In-process | Yes |
| **Nodebox** | 870 | Node.js API reimplementation in browser | Yes | No (JS polyfills) | In-process | Yes |

## Full VM Emulation

### v86 (copy/v86) — 22K stars

x86 PC emulator written in JavaScript/WASM. Boots a real Linux kernel in the browser. Machine code is translated to WASM modules at runtime via a JIT compiler.

**How it works:** Emulates an entire x86 CPU, motherboard, disk controller, VGA, etc. Loads a Linux kernel image + filesystem image, boots like a real PC. Each task/thread runs on a separate virtual CPU managed by Web Workers.

**Trade-offs vs wasmVM:**
- Full compatibility (anything that runs on x86 works) but very slow — CPU emulation overhead is 10-100x
- Boots in seconds, not milliseconds
- Multi-gigabyte filesystem images
- Real multitasking via emulated kernel, real syscalls

**Why we don't do this:** We don't need to run arbitrary x86 binaries. We need fast execution of ~100 Unix commands. Compiling Rust to WASM directly runs at near-native speed. Emulating an x86 CPU to run the same commands is orders of magnitude slower.

### WebVM (leaningtech/webvm) — 16K stars

x86 Linux virtual machine running client-side in the browser. Uses CheerpX, a proprietary x86-to-WASM JIT compiler.

**How it works:** Similar to v86 but with a more sophisticated JIT that translates x86 instructions to WASM on the fly. Runs a full Debian-based Linux distribution. Networking via Tailscale.

**Trade-offs vs wasmVM:**
- Full Linux distribution with apt-get, gcc, python, etc.
- CheerpX is proprietary/commercial
- Still has CPU emulation overhead, though better than v86's interpreter
- Heavy — downloads a full filesystem image

**Why we don't do this:** Same as v86 — emulation overhead. Also, CheerpX is proprietary which conflicts with our Apache-2.0 licensing.

## WASM OS / Runtime

### WebContainers (StackBlitz) — 4.6K stars

WASM-based operating system that runs Node.js natively in the browser. The WASM layer abstracts the OS, making Node.js think it's running on a real system.

**How it works:** Proprietary WASM runtime that implements enough OS-level abstractions (filesystem, networking, process management) for Node.js and npm to work. Node.js runs as WASM, not emulated.

**Trade-offs vs wasmVM:**
- Production-quality, commercially backed
- Focused exclusively on Node.js/npm ecosystem — not general Unix
- Requires Chrome or Chrome-based browsers with specific headers (COEP/COOP)
- Core runtime is closed-source
- No general Unix command-line tools (no grep, sed, awk, etc.)

**Why we don't do this:** Different target. WebContainers runs Node.js; wasmVM runs a Unix userland. Also closed-source.

### container2wasm — 2.6K stars

Converts Docker container images to WASM images that run the container + Linux kernel on an emulated CPU.

**How it works:** Takes a container image, wraps it with a CPU emulator (x86 or RISC-V), and produces a WASM binary. Runs on WASI runtimes (Wasmtime) and in browsers.

**Trade-offs vs wasmVM:**
- Run any Docker container as WASM — maximum compatibility
- CPU emulation overhead (same problem as v86/WebVM)
- Output WASM binaries are very large (hundreds of MB)
- Designed for running existing containers, not for building new tools

**Why we don't do this:** We compile tools directly to WASM (no emulation). Our binary is ~8MB vs hundreds of MB for an emulated container.

## TypeScript / JS Reimplementations

### just-bash (Vercel Labs) — 1.9K stars

Pure TypeScript bash interpreter with an in-memory virtual filesystem. Designed for AI agents that need sandboxed shell execution.

**How it works:** Reimplements ~70 Unix commands as TypeScript functions. Parses bash syntax (pipes, redirects, variables, loops, functions) and dispatches to built-in TypeScript command implementations. Everything runs in a single process, no Workers.

**Trade-offs vs wasmVM:**
- Instant startup, zero overhead — no WASM compilation
- TypeScript reimplementations diverge from GNU behavior on edge cases
- No real binary execution — can't run actual grep, sed, or awk
- Commands are 60-80% complete implementations (missing flags, edge cases)
- Single-threaded — no concurrent pipeline stages

**Why we're different:** wasmVM compiles real Rust implementations (uutils, ripgrep, jaq, brush-shell) to WASM. Full GNU-compatible behavior, not approximations. True concurrent pipelines via Workers + ring buffers. The trade-off is startup time (~50ms for WASM instantiation vs instant for pure JS).

**What we borrowed:** just-bash's command coverage list was our starting point for the compatibility matrix. Their architecture (shell interpreter + VFS + command dispatch) validated the pattern.

### Nodebox (CodeSandbox) — 870 stars

Node.js-compatible runtime that runs entirely in the browser by reimplementing Node.js APIs using browser APIs.

**How it works:** Not an emulator — reimplements `fs`, `path`, `child_process`, `http`, etc. using browser equivalents (IndexedDB for fs, fetch for http, etc.). Lighter than WebContainers.

**Trade-offs vs wasmVM:**
- Node.js-focused, not Unix command-line tools
- Reimplementation approach (same limitation as just-bash — behavioral divergence)
- No WASM, no real binaries

**Why we're different:** Different problem space. Nodebox runs Node.js apps; wasmVM runs Unix commands.

## Academic

### Browsix (plasma-umass) — 3.2K stars

Academic project that maps Unix primitives (processes, syscalls) onto browser APIs (Web Workers, postMessage). Runs C, C++, Go, and Node.js programs compiled via Emscripten.

**How it works:** Each Unix process is a Web Worker. System calls are intercepted and routed to a kernel implemented in JavaScript. Shared filesystem accessible from multiple processes. Pipes via `pipe(2)`, TCP sockets for servers/clients.

**Trade-offs vs wasmVM:**
- Architecturally very similar to wasmVM — Workers as processes, JS kernel, shared filesystem
- Uses Emscripten (C/C++ to WASM) instead of Rust to WASM
- Published as academic paper, not maintained for production use
- Last meaningful activity ~2016-2017
- No SharedArrayBuffer (predates widespread support) — uses postMessage only

**What we borrowed (conceptually):** Browsix validated the "Workers as processes, JS as kernel" architecture that wasmVM uses. Our ring buffer IPC over SharedArrayBuffer is the evolution of their postMessage-based approach — same pattern but with true concurrent streaming instead of message-based batch I/O.

## Summary: Why wasmVM Exists

Every existing project makes a trade-off that wasmVM avoids:

| Project | What it gives up |
|---------|-----------------|
| v86, WebVM, container2wasm | Performance (CPU emulation overhead) |
| WebContainers | Open source, general Unix (Node.js only) |
| just-bash | Real binary execution (TypeScript approximations) |
| Nodebox | Unix tools (Node.js only) |
| Browsix | Maintenance, modern browser APIs |

wasmVM combines: real compiled binaries (not reimplementations) + near-native speed (no CPU emulation) + browser compatibility + 90+ Unix commands + full bash shell + open source (Apache-2.0). The cost is implementation complexity — we build the entire WASI polyfill, VFS, and process model ourselves.

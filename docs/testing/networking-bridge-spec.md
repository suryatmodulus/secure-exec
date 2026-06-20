# Networking Bridge Architecture And Test Matrix

## Objective

Make host, JavaScript, and WASM networking interoperate through one VM-local
transport model instead of maintaining separate HTTP-object and TCP-byte paths.

This spec covers the long-term fix for issue #88 and the follow-up requested
after PR #101:

- parallel `.exec(...)` calls in one VM must be able to communicate over
  loopback,
- host `runtime.fetch(...)` must reach any HTTP server listening inside the VM,
  regardless of whether it is implemented by JS or WASM,
- JS and WASM clients/servers must interoperate in both directions,
- inbound and outbound behavior must be covered by an auditable test matrix.

## Current State

There are currently two listener models.

### Stream-mode listeners

`net.createServer()` and WASM `host_net` listeners use the kernel socket table.

Relevant paths:

- JS `net.Server.listen()` calls `_netServerListenRaw` in
  `crates/execution/assets/v8-bridge.source.js`.
- `_netServerListenRaw` maps to `net.listen` in
  `crates/execution/src/v8_runtime.rs`.
- `net.listen` calls `ActiveTcpListener::bind_kernel(...)` in
  `crates/sidecar/src/execution.rs`.
- Kernel loopback clients connect with `socket_connect_inet_loopback(...)`.
- Accepted sockets are normal byte streams with read, write, shutdown, and close
  semantics.

This is the desired substrate.

### Object-mode HTTP listeners

Before this networking-stack work, `http.createServer()` used a separate HTTP
bridge:

- JS `Server.listen()` calls `_networkHttpServerListenRaw`.
- `_networkHttpServerListenRaw` maps to `net.http_listen`.
- The sidecar stores `ActiveHttpServer` entries in `process.http_servers`.
- Host `runtime.fetch()` calls protocol `vm_fetch`, which searches
  `process.http_servers`, sends an `http_request` stream event to the target
  process, and waits for `net.http_respond`.

This model works for host-to-JS HTTP, but it is not a real accepted TCP stream.
Before PR #101, another guest process could not reliably reach the server over
loopback because the client expected byte-stream TCP semantics while the server
only exposed object-mode HTTP dispatch.

PR #101 moves the normal `http.createServer()` path onto kernel TCP listeners.
The legacy object-mode machinery remains only as compatibility fallback while
older tests and callers are migrated.

## Target Architecture

The kernel socket table is the single authoritative transport for VM-local
networking.

### Design Rule

All guest listeners that bind a TCP port must be represented as kernel TCP
listeners. HTTP is layered on top of TCP bytes, not registered as a separate
sidecar listener type.

### Consequences

- `http.createServer()` should be implemented on top of `net.Server` inside the
  JS bridge.
- Guest `fetch()`, `http.request()`, `net.connect()`, WASM TCP clients, and host
  fetch all target the same listener table.
- `findListener` and `waitForListener` inspect one source of truth.
- Host `runtime.fetch()` becomes a VM-local HTTP client that opens a kernel
  loopback TCP connection and serializes HTTP/1.1 request bytes.
- `process.http_servers`, `net.http_listen`, `net.http_request`, and
  `loopbackHttpTarget` are deprecated compatibility machinery. They should not
  grow into a second networking stack.

## Required Data Flows

### Host to JS HTTP

```text
host runtime.fetch()
  -> sidecar host HTTP client
  -> kernel socket connect to guest listener
  -> JS net.Server accepted socket
  -> JS http.Server parser/request handler
  -> response bytes over kernel socket
  -> host response object
```

### Host to WASM HTTP

```text
host runtime.fetch()
  -> sidecar host HTTP client
  -> kernel socket connect to guest listener
  -> WASM accept/read/write
  -> response bytes over kernel socket
  -> host response object
```

### JS to JS

```text
guest JS fetch/http/net client
  -> sidecar net.connect
  -> kernel loopback socket pair
  -> JS net.Server/http.Server accepted socket
```

### JS to WASM

```text
guest JS fetch/http/net client
  -> sidecar net.connect
  -> kernel loopback socket pair
  -> WASM accept/read/write
```

### WASM to JS

```text
guest WASM TCP/HTTP client
  -> host_net connect
  -> sidecar net.connect
  -> kernel loopback socket pair
  -> JS net.Server/http.Server accepted socket
```

### WASM to WASM

```text
guest WASM TCP/HTTP client
  -> host_net connect
  -> sidecar net.connect
  -> kernel loopback socket pair
  -> WASM accept/read/write
```

### Guest outbound to host or external

Outbound connections that do not target a VM-owned loopback listener continue to
use the existing sidecar external network path:

```text
guest client
  -> sidecar net.connect
  -> permission checks and DNS pinning
  -> host TcpStream
```

Loopback host access still requires `loopbackExemptPorts`. Tests for that path
must be labeled host-loopback, not cross-runtime guest-loopback.

## Implementation Plan

### Phase 1: Host fetch over kernel TCP

Add an internal sidecar HTTP client for VM-local listeners.

Requirements:

- Resolve `{host, port}` to a VM-owned TCP listener using the existing socket
  path context and kernel listener state.
- Fail closed. `runtime.fetch()` must never use DNS, external networking,
  `loopbackExemptPorts`, or host loopback fallback. If no VM-owned kernel
  listener exists, return missing-listener except for the temporary object-mode
  fallback below.
- Create a sidecar-owned kernel TCP socket for the request.
- Account sidecar-owned host-fetch sockets against the VM's socket,
  connection, and buffered-byte limits. The accepted server-side socket must
  count too.
- Connect it with `socket_connect_inet_loopback(...)`.
- Serialize an HTTP/1.1 request with method, path, headers, and optional body.
- Bound request data through the sidecar frame cap, socket buffered-byte limits,
  and the existing `limits.http.maxFetchResponseBytes` response JSON limit.
- Read and parse the HTTP/1.1 response from the kernel socket without holding
  VM or service locks that the target process needs for accept/read/write
  sync-RPC. Response waiting must be event-driven or bounded-polling with
  explicit timeout and cancellation.
- Preserve `runtime.fetch()` response shape: status, statusText, headers, body.
- Keep existing response size limits.
- Return a clear missing-listener error when no listener exists.
- Always close the sidecar-owned host-fetch client socket on timeout, parse
  error, target process exit, or resource-limit failure. Accepted server-side
  sockets remain guest process resources unless the target process exits or the
  VM is disposed.
- Account host-fetch sockets and connections against the existing VM socket and
  connection limits before opening the sidecar-owned client socket. The current
  single-client sidecar request model serializes host `vm_fetch` requests, so a
  separate concurrent-host-fetch cap is not required until a multi-client or
  async host-fetch transport exists.

Compatibility:

- During migration, `vm_fetch` may fall back to the old object-mode
  `process.http_servers` dispatch only when no kernel listener exists.
- Tests that exercise this fallback must be labeled `H1-compat`. They do not
  count for the final kernel-transport exit criteria.
- Once `http.createServer()` moves to `net.Server`, the fallback can be removed.

### Phase 2: JS `http.createServer()` on `net.Server`

Refactor the JS bridge HTTP server to use the existing `NetServer`.

Requirements:

- `http.createServer(listener).listen(...)` internally creates a `NetServer`.
- On each accepted `NetSocket`, parse HTTP/1.1 request bytes.
- Construct `ServerIncomingMessage` and `ServerResponseBridge` using the real
  accepted socket as the response transport.
- Serialize response bytes to the accepted socket.
- Respect close, error, listening, connection, request, and basic timeout
  behavior expected by existing examples.
- Preserve same-process loopback behavior, but route it through the same socket
  path unless a local fast path is proven equivalent.
- Keep `http.ServerResponse.socket` and `res.socket.write(...)` wired to the
  real accepted socket.
- The HTTP/1.1 parser must be fail-closed and bounded: request line length,
  total header bytes, header count, body bytes, duplicate or conflicting
  `Content-Length`, malformed transfer coding, chunked decoding, keep-alive
  reuse, and pipelined request ordering all need explicit behavior and tests.

Non-goals for the first implementation:

- Full streaming upload backpressure parity. Bounded uploads are still required.
- WebSocket upgrade and CONNECT parity beyond the existing behavior.
- HTTP/2, which already has separate bridge code and should be handled in a
  follow-up.

### Phase 3: Remove or shrink object-mode HTTP bridge

After Phase 1 and Phase 2 pass the matrix:

- Stop using `process.http_servers` for new HTTP servers.
- Remove `http_loopback_targets` and `loopbackHttpTarget` from the normal path.
- Keep only compatibility code that is still needed by tests, or delete it when
  all callers are migrated.
- Keep docs aligned with the normal kernel TCP path and label any remaining
  object-mode fallback as compatibility-only.

### Phase 4: Public host TCP bridge, optional

This is optional for HTTP dev-server parity but useful for raw TCP tests and
future APIs.

Potential API:

```ts
const socket = await runtime.connect({ host: "127.0.0.1", port: 3000 });
```

This would expose a host-side stream backed by a sidecar-owned kernel socket.
It is not required for `runtime.fetch()`, but it would make host-to-guest raw TCP
tests much cleaner.

## Compatibility And Security Constraints

- Guest code remains untrusted. All guest connects, listens, reads, and writes
  go through sidecar and kernel ownership checks.
- VM configuration remains trusted. Do not add validation that treats trusted
  config as attacker input.
- Do not spawn host Node.js for guest work.
- Do not bypass network permission checks for outbound host or external
  connections.
- VM-local loopback between guest processes is allowed only when the destination
  is a VM-owned listener and the applied guest network policy allows the
  connect operation. This preserves today's permission model unless a future
  explicit VM-local-loopback policy operation is added.
- Host `runtime.fetch()` to a VM-owned listener is host control-plane traffic,
  not guest egress. It should work when the guest server is allowed to listen
  but guest outbound fetch/connect is denied.
- Host-loopback access from guest code remains separate and still requires
  `loopbackExemptPorts` plus the applied network policy.
- Long-lived waits must not block the sync-RPC thread. Prefer stream events,
  bounded polling, or kernel socket waits with explicit timeouts.
- New bridge globals must be added consistently to:
  - `crates/bridge/bridge-contract.json`,
  - `crates/execution/src/v8_runtime.rs`,
  - `crates/v8-runtime/src/session.rs`,
  - `crates/execution/assets/v8-bridge.source.js`.

## Test Matrix

Each cell should have at least one focused automated test. When a cell exercises
public TypeScript APIs, include a high-level integration test or runnable docs
example in addition to sidecar internals.

WASM cells use checked-in C fixtures such as
`registry/native/c/programs/http_server.c`. These cells count only when the C
WASM artifacts are present in the test environment or CI artifact bundle. JS-only
cells in `registry/tests/kernel/cross-runtime-network.test.ts` must still run
without those C artifacts.

| Cell | Phase | Direction | Protocol | Test file | Test name | Fixture/artifact | CI/gated | Counts for exit criteria | Required proof |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| K1 | existing | kernel internal | TCP | `crates/kernel/tests/tcp_listener.rs`, `tcp_data_plane.rs`, `loopback_routing.rs` | existing kernel TCP cases | none | yes | yes | bind/listen/accept/connect/read/write over loopback |
| K2 | existing | kernel internal | UDP | `crates/kernel/tests/udp_datagram.rs` | existing UDP loopback cases | none | yes | yes | bind/send/recv over loopback, datagram boundaries |
| H1-compat | migration | host to JS | HTTP | `crates/sidecar/tests/service.rs` | object-mode host fetch compatibility | JS `http.createServer()` | yes | no | `runtime.fetch()` reaches old `process.http_servers` path while fallback exists |
| H1-kernel | final | host to JS | HTTP | `crates/sidecar/tests/service.rs`, `examples/docs/uc-dev-servers` | `vm_fetch_reaches_javascript_http_server_over_kernel_tcp`, `vm_fetch_kernel_tcp_decodes_chunked_response_body` | JS `http.createServer()` | yes | yes | `runtime.fetch()` reaches JS `http.createServer()` through a kernel listener visible to the socket table, including streamed chunked responses |
| H2 | final | host to WASM | HTTP | `registry/tests/kernel/cross-runtime-network.test.ts` | `H2 host vmFetch -> WASM HTTP server over VM loopback` | WASM `http_server` | yes when C artifact exists | yes | `runtime.fetch()`/`vmFetch` reaches a WASM HTTP server through the same kernel listener path |
| H3 | optional | host to JS | raw TCP | none until API exists | none until API exists | public host TCP API | no | no until API exists | host raw TCP bridge reaches JS `net.Server` |
| H4 | optional | host to WASM | raw TCP | none until API exists | none until API exists | public host TCP API, WASM TCP server | no | no until API exists | host raw TCP bridge reaches WASM TCP server |
| J1 | final | JS to JS | HTTP | `registry/tests/kernel/cross-runtime-network.test.ts`, `crates/sidecar/tests/service.rs` | `J1 JS fetch -> JS node:http server over VM loopback`, `javascript_fetch_reaches_http_server_in_parallel_guest_process` | JS `http.createServer()` | yes | yes | second guest process `fetch()` reaches JS HTTP server through kernel TCP |
| J2 | final | JS to JS | raw TCP | `registry/tests/kernel/cross-runtime-network.test.ts` | `J2 JS net.connect -> JS net.Server over VM loopback` | JS `net.Server()` | yes | yes | JS `net.connect()` reaches JS `net.Server()` in another process |
| J3 | final | JS to WASM | HTTP | `registry/tests/kernel/cross-runtime-network.test.ts` | `J3 JS fetch -> WASM HTTP server over VM loopback` | WASM `http_server` | yes when C artifact exists | yes | JS guest `fetch()` reaches WASM HTTP server |
| J4 | final | JS to WASM | raw TCP | `registry/tests/kernel/cross-runtime-network.test.ts` | `J4 JS net.connect -> WASM TCP server over VM loopback` | WASM TCP server | yes when C artifact exists | yes | JS `net.connect()` reaches WASM TCP server |
| W1 | final | WASM to JS | HTTP | `registry/tests/kernel/cross-runtime-network.test.ts` | `W1 WASM http_get -> JS node:http server over VM loopback` | WASM `http_get`, JS `http.createServer()` | yes when C artifact exists | yes | WASM HTTP client reaches JS HTTP server over VM loopback, not host loopback |
| W2 | final | WASM to JS | raw TCP | `registry/tests/kernel/cross-runtime-network.test.ts` | `W2 WASM tcp_echo -> JS net.Server over VM loopback` | WASM TCP client, JS `net.Server()` | yes when C artifact exists | yes | WASM TCP client reaches JS `net.Server()` |
| W3 | final | WASM to WASM | HTTP | `registry/tests/kernel/cross-runtime-network.test.ts` | `W3 WASM http_get -> WASM HTTP server over VM loopback` | WASM `http_server`, WASM HTTP client | yes when C artifact exists | yes | WASM HTTP client reaches WASM HTTP server |
| W4 | final | WASM to WASM | raw TCP | `registry/tests/kernel/cross-runtime-network.test.ts` | `W4 WASM tcp_echo -> WASM TCP server over VM loopback` | WASM TCP client/server | yes when C artifact exists | yes | WASM TCP client reaches WASM TCP server |
| O1 | final | JS to host | HTTP/TCP | `registry/tests/kernel/cross-runtime-network.test.ts`, `crates/sidecar/tests/service.rs` | `O1 JS fetch -> host loopback requires loopback exemption`, JS permission denial service tests | host fixture | yes | yes | JS outbound reaches host fixture only with loopback exemption, and network policy denials surface `EACCES` in sidecar service coverage |
| O2 | final | WASM to host | HTTP/TCP | `registry/tests/kernel/cross-runtime-network.test.ts` | `O2 WASM http_get -> host loopback requires loopback exemption` | host fixture, WASM HTTP client | yes when C artifact exists | yes | WASM outbound reaches host fixture only with loopback exemption |
| O3 | gated | JS to external | HTTP/DNS | none yet | none yet | real network | opt-in | no | optional gated real-network JS fetch test |
| O4 | gated | WASM to external | HTTP/DNS | existing curl/wget suites | existing external cases | real network, WASM curl/wget | opt-in | no | gated real-network curl/wget tests |
| P1 | final | policy | denied listen/connect | `crates/sidecar/tests/service.rs`, `registry/tests/kernel/cross-runtime-network.test.ts` | `javascript_network_permission_denials_surface_eacces_to_guest_code`, O1/O2 denied host-loopback subcases | JS clients, WASM host-loopback client | yes, O2 only when C artifact exists | yes | denied JS listen/connect failures surface `EACCES`; denied JS/WASM host-loopback attempts fail before the host fixture is reached |
| R1 | final | resource/lifecycle | host fetch and socket-backed HTTP server | `crates/sidecar/tests/service.rs` | `vm_fetch_*` host-fetch lifecycle rows, `javascript_http_socket_backed_server_rejects_oversized_incomplete_headers` | JS HTTP and raw TCP servers | yes | yes | timeout/stalled-server cleanup, malformed response cleanup, configured response limit, over-large raw response buffer cap, oversized incomplete request-header rejection, chunked response decoding, chunked plus content-length rejection, socket-cap preflight, target-exit cleanup, response-frame overhead, and no host network on missing listener |

### Existing Tests Inventory

| Existing test area | Current classification | Notes |
| --- | --- | --- |
| `crates/kernel/tests/tcp_listener.rs`, `tcp_data_plane.rs`, `loopback_routing.rs` | K1 | Kernel TCP primitive coverage, not public API coverage. |
| `crates/kernel/tests/udp_datagram.rs` | K2 | Kernel UDP primitive coverage. |
| `crates/sidecar/tests/service.rs` JS fetch/listen cases | H1-kernel and J1, plus compatibility fallback coverage | The new H1/J1 cases assert kernel listener behavior; fallback tests should stay labeled compatibility-only. |
| `registry/tests/kernel/cross-runtime-network.test.ts` | J1, J2, J3, J4, W1, W2, W3, W4, H2, O1, O2 | Current matrix covers VM-local HTTP/raw TCP interop plus host-loopback exemption behavior without using host fixtures for guest-loopback cells. |
| `registry/tests/wasmvm/net-server.test.ts` | supporting raw TCP fixture evidence | Lower-level WASM TCP server coverage. |

## Suggested Test Layout

### Kernel

Keep primitive socket semantics in `crates/kernel/tests/`:

- `tcp_listener.rs`
- `tcp_data_plane.rs`
- `loopback_routing.rs`
- `udp_datagram.rs`

### Sidecar JS runtime

Move new JS runtime networking tests out of the giant `service.rs` when
practical:

- `crates/sidecar/tests/network_js_http.rs`
- `crates/sidecar/tests/network_js_tcp.rs`
- `crates/sidecar/tests/network_policy.rs`

### Cross-runtime and public API

Use a dedicated integration area for matrix-level behavior:

- `registry/tests/network/host_to_guest.test.ts`
- `registry/tests/network/js_to_wasm.test.ts`
- `registry/tests/network/wasm_to_js.test.ts`
- `registry/tests/network/wasm_to_wasm.test.ts`
- `registry/tests/network/outbound_policy.test.ts`

Avoid misleading names. A test that connects to a host fixture through
`loopbackExemptPorts` is host-loopback, not guest cross-runtime loopback.

## High-Level Examples

The following examples should run before declaring the networking stack healthy:

```bash
SECURE_EXEC_SIDECAR_BIN=target/debug/secure-exec-sidecar \
SECURE_EXEC_WASM_COMMANDS_DIR="$PWD/registry/native/target/wasm32-wasip1/release/commands" \
pnpm --dir examples/docs/feat-networking start

SECURE_EXEC_SIDECAR_BIN=target/debug/secure-exec-sidecar \
SECURE_EXEC_WASM_COMMANDS_DIR="$PWD/registry/native/target/wasm32-wasip1/release/commands" \
SECURE_EXEC_C_WASM_COMMANDS_DIR="$PWD/registry/native/c/build" \
pnpm --dir examples/docs/feat-networking-wasm start

SECURE_EXEC_SIDECAR_BIN=target/debug/secure-exec-sidecar \
SECURE_EXEC_WASM_COMMANDS_DIR="$PWD/registry/native/target/wasm32-wasip1/release/commands" \
pnpm --dir examples/docs/uc-dev-servers start
```

Add or update examples so that at least one high-level JS example demonstrates:

- host to JS HTTP,
- JS to JS HTTP using two `.exec()` calls,
- JS to WASM HTTP,
- WASM to JS HTTP,
- host to WASM HTTP,
- JS to host-loopback HTTP with an explicit exemption,
- WASM to host-loopback HTTP with an explicit exemption.

The WASM example coverage lives in `examples/docs/feat-networking-wasm`.

## Exit Criteria

The implementation is complete only when:

- `http.createServer()` uses the same listener substrate as `net.Server`,
- `runtime.fetch()` reaches both JS and WASM HTTP servers via kernel TCP,
- JS and WASM can each act as client and server over VM loopback,
- outbound host/external behavior remains permission-gated,
- the matrix above maps to concrete tests that pass,
- the dev-server docs and examples reflect the real architecture.

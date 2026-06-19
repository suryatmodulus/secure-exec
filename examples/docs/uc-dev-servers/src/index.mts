import { NodeRuntime } from "secure-exec";

// A user's "dev server": untrusted server-style code. It boots a real
// node:http server, then we drive requests against it - all inside the
// secure-exec VM, with no access to the host machine.
const devServer = `
import http from "node:http";

// 1. Start the user's server, exactly as they wrote it.
const app = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("hello from the sandboxed dev server");
});

// Listen on loopback inside the VM. The kernel owns this socket; it never
// touches a real host port.
await new Promise((resolve) => app.listen(3000, "127.0.0.1", resolve));
const { port } = app.address();
console.log("server listening on 127.0.0.1:" + port);

// 2. Wait for readiness by polling the health endpoint from inside the VM.
async function waitForReady(url) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return;
    } catch {
      // Not ready yet; retry.
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Timed out waiting for " + url);
}
await waitForReady("http://127.0.0.1:" + port + "/health");
console.log("health check passed");

// 3. Drive a request against the running server and capture the response.
const res = await fetch("http://127.0.0.1:" + port + "/");
const body = await res.text();
console.log("GET / ->", res.status, JSON.stringify(body));

// 4. Tear the server down so the program can exit cleanly.
await new Promise((resolve) => app.close(resolve));
console.log("server closed");

// Emit a machine-readable result line the host can parse from stdout.
console.log("RESULT " + JSON.stringify({ status: res.status, body }));

// The fetch client keeps a connection pool alive, so exit explicitly once the
// work is done rather than waiting for the event loop to drain.
process.exit(0);
`;

// The guest binds a loopback port and drives requests against it with fetch(),
// so opt in to networking. NodeRuntime.create() denies network by default;
// permissions merge over that secure default.
const runtime = await NodeRuntime.create({ permissions: { network: "allow" } });

try {
	// exec() runs the guest program (an ES module, so top-level `import` and
	// `await` work) to completion. The server is long-lived for the duration of
	// the run, but the façade is run-to-completion: the guest must finish (here,
	// by closing the server) for the call to return.
	const result = await runtime.exec(devServer, { timeout: 30_000 });

	console.log("--- host side ---");
	console.log("exitCode:", result.exitCode);
	console.log("guest stdout:\n" + result.stdout.trim());
	if (result.stderr.trim()) {
		console.log("guest stderr:\n" + result.stderr.trim());
	}

	// Recover the structured result the guest printed on its final stdout line.
	const resultLine = result.stdout
		.split("\n")
		.find((line) => line.startsWith("RESULT "));
	if (resultLine) {
		const payload = JSON.parse(resultLine.slice("RESULT ".length));
		console.log("parsed response:", JSON.stringify(payload));
	}
} finally {
	// Tear down the VM and release the sidecar.
	await runtime.dispose();
}

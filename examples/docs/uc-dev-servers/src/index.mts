import { NodeRuntime } from "secure-exec";

// A user's "dev server": untrusted, long-running server-style code. It boots a
// real node:http server and keeps serving until it is killed, all inside the
// secure-exec VM with no access to the host machine.
const devServer = `
import http from "node:http";

// Start the user's server, exactly as they wrote it.
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
// touches a real host port. The process stays alive serving requests until the
// host kills it.
app.listen(3000, "127.0.0.1", () => {
  console.log("server listening on 127.0.0.1:3000");
});
`;

// The guest binds a loopback port, so opt in to networking. NodeRuntime.create()
// denies network by default; permissions merge over that secure default.
const runtime = await NodeRuntime.create({ permissions: { network: "allow" } });

// Drive an HTTP request from the host into the guest server, retrying until the
// server is accepting connections. waitForListener would normally signal
// readiness, but it is currently buggy (issue #92), so poll fetch() instead.
async function fetchWhenReady(
	port: number,
	input: Parameters<NodeRuntime["fetch"]>[1],
) {
	let lastError: unknown;
	for (let attempt = 0; attempt < 50; attempt++) {
		try {
			return await runtime.fetch(port, input);
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
	throw new Error(
		`server on port ${port} never became ready: ${String(lastError)}`,
	);
}

try {
	// spawn() starts the server as a long-running guest process and returns a
	// handle immediately, without waiting for it to exit.
	const server = await runtime.spawn(devServer, {
		onStdout: (chunk) => process.stdout.write(new TextDecoder().decode(chunk)),
	});
	console.log("spawned guest server, pid:", server.pid);

	try {
		// Wait for readiness by driving the health endpoint from the host.
		const health = await fetchWhenReady(3000, { path: "/health" });
		console.log("health check ->", health.status, JSON.stringify(health.body));

		// Drive a real host->guest request into the running server.
		const res = await runtime.fetch(3000, { method: "GET", path: "/" });
		console.log("GET / ->", res.status, JSON.stringify(res.body));

		console.log(
			"RESULT " + JSON.stringify({ status: res.status, body: res.body }),
		);
	} finally {
		// Tear the server down and wait for the guest process to exit.
		server.kill();
		await server.wait();
		console.log("server stopped");
	}
} finally {
	// Tear down the VM and release the sidecar.
	await runtime.dispose();
}

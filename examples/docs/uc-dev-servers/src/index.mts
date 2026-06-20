import { NodeRuntime } from "secure-exec";

// A user's "dev server": untrusted, long-running server-style code. It boots a
// real node:http server and keeps serving until the host cancels this exec.
const devServer = `
import http from "node:http";

const app = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("hello from " + req.url);
});

app.listen(3000, "127.0.0.1", () => {
  console.log("server listening on 127.0.0.1:3000");
});

await new Promise(() => {});
`;

const runtime = await NodeRuntime.create({ permissions: { network: "allow" } });
const serverAbort = new AbortController();
const stdoutDecoder = new TextDecoder();
let ready!: () => void;
const serverReady = new Promise<void>((resolve) => {
	ready = resolve;
});

try {
	const serverExec = runtime
		.exec(devServer, {
			signal: serverAbort.signal,
			onStdout: (chunk) => {
				const text = stdoutDecoder.decode(chunk);
				process.stdout.write(text);
				if (text.includes("server listening")) {
					ready();
				}
			},
		})
		.catch((error: unknown) => {
			if (serverAbort.signal.aborted) {
				return;
			}
			throw error;
		});

	await serverReady;

	// Drive a host->guest request into the running server.
	const health = await runtime.fetch(3000, { path: "/health" });
	console.log("host health ->", health.status, JSON.stringify(health.body));

	const hostRes = await runtime.fetch(3000, { method: "GET", path: "/from-host" });
	console.log("host GET ->", hostRes.status, JSON.stringify(hostRes.body));

	// Run another guest program in the same VM while the server exec is still
	// active. Its fetch() reaches the server through VM loopback.
	const guestClient = await runtime.exec(`
const response = await fetch("http://127.0.0.1:3000/from-guest");
console.log(response.status + " " + await response.text());
`);
	console.log("guest fetch ->", JSON.stringify(guestClient.stdout.trim()));

	console.log(
		"RESULT " +
			JSON.stringify({
				host: { status: hostRes.status, body: hostRes.body },
				guest: guestClient.stdout.trim(),
			}),
	);

	serverAbort.abort();
	await serverExec;
	console.log("server stopped");
} finally {
	serverAbort.abort();
	await runtime.dispose();
}

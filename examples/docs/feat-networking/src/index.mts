/**
 * Networking example.
 *
 * Network access for guest code is governed by the VM permission policy. This
 * example shows both sides of the gate:
 *
 *   1. With network "allow", the guest starts a loopback HTTP server inside the
 *      VM and fetches it - the request and response stay entirely within the
 *      kernel socket table (hermetic, no real host network).
 *   2. With the default (network denied), the same outbound fetch is blocked.
 *   3. Host loopback is separate from VM loopback: even with network "allow",
 *      a guest can reach a host loopback service only when the host port is in
 *      loopbackExemptPorts.
 *
 * Run with:
 *   SECURE_EXEC_SIDECAR_BIN=../../../target/debug/secure-exec-sidecar \
 *     npx tsx src/index.mts
 */

import { NodeRuntime } from "secure-exec";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";

// Guest program: start a loopback HTTP server, then fetch it. Both the listen
// and the fetch go through the kernel socket table.
const GUEST = `
import http from "node:http";

const server = http.createServer((_req, res) => {
	res.writeHead(200, { "content-type": "text/plain" });
	res.end("network-ok");
});

await new Promise((resolve, reject) => {
	server.once("error", reject);
	server.listen(0, "127.0.0.1", resolve);
});

const { port } = server.address();
const response = await fetch("http://127.0.0.1:" + port + "/");
const body = await response.text();
console.log("status:", response.status);
console.log("body:", body);

await new Promise((resolve) => server.close(resolve));
`;

// 1. Network allowed: opt in with a partial policy. Permissions merge over the
// secure default, so you only name the scope you are changing. The default
// already grants the fs/child_process/process/env scopes the runtime needs to
// launch guest programs.
const allowed = await NodeRuntime.create({
	permissions: { network: "allow" },
});
try {
	const result = await allowed.exec(GUEST);
	console.log("[network allowed] exitCode:", result.exitCode);
	console.log("[network allowed] stdout:", JSON.stringify(result.stdout.trim()));
	console.log("[network allowed] stderr:", JSON.stringify(result.stderr.trim()));
} finally {
	await allowed.dispose();
}

// 2. Network denied: this is the default, so plain create() blocks the network.
const denied = await NodeRuntime.create();
try {
	const result = await denied.exec(GUEST);
	console.log("[network denied] exitCode:", result.exitCode);
	console.log(
		"[network denied] stderr:",
		JSON.stringify(result.stderr.trim().split("\n")[0]),
	);
} finally {
	await denied.dispose();
}

// 3. Host loopback access: network "allow" is not enough to reach real host
// loopback. The host must explicitly exempt the host port too.
const hostServer = createHttpServer((req, res) => {
	res.writeHead(200, { "content-type": "text/plain" });
	res.end("host-ok:" + req.url);
});
await new Promise<void>((resolve) => {
	hostServer.listen(0, "127.0.0.1", resolve);
});
const hostPort = (hostServer.address() as AddressInfo).port;

const HOST_FETCH_GUEST = `
try {
	const response = await fetch("http://127.0.0.1:${hostPort}/from-guest");
	console.log(response.status + ":" + await response.text());
} catch (error) {
	console.log(error.cause?.code || error.code || error.name);
	process.exit(2);
}
`;

try {
	const blockedHostLoopback = await NodeRuntime.create({
		permissions: { network: "allow" },
	});
	try {
		const result = await blockedHostLoopback.exec(HOST_FETCH_GUEST);
		console.log("[host loopback blocked] exitCode:", result.exitCode);
		console.log(
			"[host loopback blocked] stdout:",
			JSON.stringify(result.stdout.trim()),
		);
	} finally {
		await blockedHostLoopback.dispose();
	}

	const allowedHostLoopback = await NodeRuntime.create({
		permissions: { network: "allow" },
		loopbackExemptPorts: [hostPort],
	});
	try {
		const result = await allowedHostLoopback.exec(HOST_FETCH_GUEST);
		console.log("[host loopback allowed] exitCode:", result.exitCode);
		console.log(
			"[host loopback allowed] stdout:",
			JSON.stringify(result.stdout.trim()),
		);
	} finally {
		await allowedHostLoopback.dispose();
	}
} finally {
	await new Promise<void>((resolve) => hostServer.close(() => resolve()));
}

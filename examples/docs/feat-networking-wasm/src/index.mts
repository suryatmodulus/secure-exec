import { existsSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import {
	allowAll,
	createInMemoryFileSystem,
	createKernel,
	createNodeRuntime,
	createWasmVmRuntime,
	type Kernel,
} from "@secure-exec/core/test-runtime";

function resolveCommandDir(
	envName: string,
	fallbackRelativePath: string,
	requiredCommand: string,
): string {
	const fromEnv = process.env[envName];
	const candidates = [
		fromEnv,
		fileURLToPath(new URL(fallbackRelativePath, import.meta.url)),
	].filter((value): value is string => Boolean(value));
	for (const dir of candidates) {
		if (existsSync(`${dir}/${requiredCommand}`)) {
			return dir;
		}
	}
	throw new Error(
		`${requiredCommand} was not found. Set ${envName} to a built WASM command directory.`,
	);
}

const wasmCommandsDir = resolveCommandDir(
	"SECURE_EXEC_WASM_COMMANDS_DIR",
	"../../../../registry/native/target/wasm32-wasip1/release/commands",
	"sh",
);
const cWasmCommandsDir = resolveCommandDir(
	"SECURE_EXEC_C_WASM_COMMANDS_DIR",
	"../../../../registry/native/c/build",
	"http_get",
);

interface RunningProgram {
	process: ReturnType<Kernel["spawn"]>;
	stdoutChunks: Uint8Array[];
	stderrChunks: Uint8Array[];
	exitCode: () => number | null;
}

function decode(chunks: Uint8Array[]): string {
	return chunks.map((chunk) => new TextDecoder().decode(chunk)).join("");
}

function spawn(
	kernel: Kernel,
	command: string,
	args: string[],
): RunningProgram {
	const stdoutChunks: Uint8Array[] = [];
	const stderrChunks: Uint8Array[] = [];
	let code: number | null = null;
	const process = kernel.spawn(command, args, {
		onStdout: (chunk) => stdoutChunks.push(chunk),
		onStderr: (chunk) => stderrChunks.push(chunk),
	});
	void process.wait().then((exitCode) => {
		code = exitCode;
	});
	return {
		process,
		stdoutChunks,
		stderrChunks,
		exitCode: () => code,
	};
}

async function waitForOutput(
	program: RunningProgram,
	needle: string,
): Promise<void> {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		if (decode(program.stdoutChunks).includes(needle)) {
			return;
		}
		if (program.exitCode() !== null) {
			throw new Error(
				`process exited before ${JSON.stringify(needle)}\nstdout:\n${decode(
					program.stdoutChunks,
				)}\nstderr:\n${decode(program.stderrChunks)}`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`timed out waiting for ${JSON.stringify(needle)}`);
}

async function waitForListener(kernel: Kernel, port: number): Promise<void> {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		if (kernel.socketTable.findListener({ host: "0.0.0.0", port })) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`timed out waiting for listener on ${port}`);
}

function parseVmFetch(responseJson: string): { status: number; body: string } {
	const parsed = JSON.parse(responseJson) as {
		status?: number;
		body?: string;
		bodyEncoding?: string;
	};
	const encodedBody = parsed.body ?? "";
	const body =
		parsed.bodyEncoding === "base64"
			? Buffer.from(encodedBody, "base64").toString("utf8")
			: encodedBody;
	return { status: parsed.status ?? 0, body };
}

const hostServer = createHttpServer((req, res) => {
	res.writeHead(200, { "content-type": "text/plain" });
	res.end("host:" + req.url);
});
await new Promise<void>((resolve) => {
	hostServer.listen(0, "127.0.0.1", resolve);
});
const hostPort = (hostServer.address() as AddressInfo).port;

const kernel = createKernel({
	filesystem: createInMemoryFileSystem(),
	permissions: allowAll,
	loopbackExemptPorts: [hostPort],
});

try {
	await kernel.mount(
		createWasmVmRuntime({ commandDirs: [cWasmCommandsDir, wasmCommandsDir] }),
	);
	await kernel.mount(createNodeRuntime());

	const jsServer = spawn(kernel, "node", [
		"-e",
		`
const http = require("http");
const server = http.createServer((req, res) => {
	res.writeHead(200, { "content-type": "text/plain" });
	res.end("js:" + req.method + ":" + req.url);
});
server.listen(3301, "127.0.0.1", () => console.log("js listening"));
`,
	]);
	await waitForOutput(jsServer, "js listening");
	const wasmToJs = await kernel.exec("http_get 3301 /from-wasm");
	console.log("wasm -> js:", JSON.stringify(wasmToJs.stdout.trim()));
	jsServer.process.kill(15);
	await jsServer.process.wait().catch(() => {});

	const wasmServerForJs = spawn(kernel, "http_server", ["3302"]);
	await waitForListener(kernel, 3302);
	const jsToWasm = await kernel.exec(
		`node -e "fetch('http://127.0.0.1:3302/from-js').then(async r => console.log(r.status + ':' + await r.text())).catch(e => { console.error(e); process.exit(1); })"`,
	);
	console.log("js -> wasm:", JSON.stringify(jsToWasm.stdout.trim()));
	await wasmServerForJs.process.wait();

	const wasmServerForHost = spawn(kernel, "http_server", ["3303"]);
	await waitForListener(kernel, 3303);
	const hostToWasm = parseVmFetch(
		await kernel.vmFetch({
			port: 3303,
			method: "GET",
			path: "/from-host",
			headersJson: JSON.stringify({}),
		}),
	);
	console.log(
		"host -> wasm:",
		JSON.stringify(`${hostToWasm.status}:${hostToWasm.body}`),
	);
	await wasmServerForHost.process.wait();

	const wasmToHost = await kernel.exec(`http_get ${hostPort} /from-wasm-host`);
	console.log("wasm -> host:", JSON.stringify(wasmToHost.stdout.trim()));
} finally {
	await kernel.dispose();
	await new Promise<void>((resolve) => hostServer.close(() => resolve()));
}

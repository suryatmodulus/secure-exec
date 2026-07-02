import {
	NodeRuntime,
	SidecarProcess,
	type HostDirectoryMount,
	type NodeRuntimeProcess,
	type NodeRuntimeResourceSnapshot,
	type SidecarSpawnOptions,
} from "@secure-exec/core";

export interface BenchVmOptions {
	mounts?: HostDirectoryMount[];
	wasmCommandDirs?: string[];
	sidecar?: SidecarProcess;
}

export interface BenchVmProcess {
	pid: number;
	wait(): Promise<number>;
}

export interface BenchVm {
	writeFile(path: string, content: string | Uint8Array): Promise<void>;
	spawnNodeCapture(
		argsOrProgramPath: string[] | string,
		env?: Record<string, string>,
		options?: {
			onStdout?: (data: Uint8Array) => void;
			onStderr?: (data: Uint8Array) => void;
		},
	): Promise<{ stdout: string; stderr: string; exitCode: number }>;
	spawn(
		command: string,
		args: string[],
		options?: {
			env?: Record<string, string>;
			onStdout?: (data: Uint8Array) => void;
			onStderr?: (data: Uint8Array) => void;
		},
	): BenchVmProcess;
	waitProcess(pid: number): Promise<number>;
	execWasmCommand(
		cmd: string,
		args: string[],
	): Promise<{ stdout: string; stderr: string; exitCode: number }>;
	getResourceSnapshot(): Promise<NodeRuntimeResourceSnapshot>;
	dispose(): Promise<void>;
	sidecarPid(): number | null;
}

export async function createBenchVm(options: BenchVmOptions = {}): Promise<BenchVm> {
	const runtime = await NodeRuntime.create({
		permissions: {
			fs: "allow",
			network: "allow",
			childProcess: "allow",
			process: "allow",
			env: "allow",
		},
		mounts: options.mounts,
		wasmCommandDirs: options.wasmCommandDirs,
		sidecar: options.sidecar,
		// Benchmark VM: opt in to the us-resolution guest clock so sub-ms guest
		// samples are real instead of 1ms-floor artifacts. Never enable this for
		// untrusted workloads (timing side channels); off by default everywhere.
		jsRuntime: { highResolutionTime: true },
	});
	const processes = new Map<number, NodeRuntimeProcess>();

	return {
		writeFile(path, content) {
			return runtime.writeFile(path, content);
		},
		async spawnNodeCapture(argsOrProgramPath, env, captureOptions = {}) {
			const args =
				typeof argsOrProgramPath === "string"
					? [argsOrProgramPath]
					: argsOrProgramPath;
			return runtime.execCommand("node", args, {
				env,
				onStdout: captureOptions.onStdout,
				onStderr: captureOptions.onStderr,
			});
		},
	spawn(command, args, spawnOptions = {}) {
			const proc = runtime.spawnCommand(command, args, {
				env: spawnOptions.env,
				onStdout: spawnOptions.onStdout,
				onStderr: spawnOptions.onStderr,
			});
			processes.set(proc.pid, proc);
			return {
				pid: proc.pid,
				wait: async () => {
					try {
						return await proc.wait();
					} finally {
						processes.delete(proc.pid);
					}
				},
			};
		},
		async waitProcess(pid) {
			const proc = processes.get(pid);
			if (!proc) {
				throw new Error(`unknown benchmark process pid ${pid}`);
			}
			try {
				return await proc.wait();
			} finally {
				processes.delete(pid);
			}
		},
		execWasmCommand(cmd, args) {
			return runtime.execCommand(cmd, args);
		},
		getResourceSnapshot() {
			return runtime.getResourceSnapshot();
		},
		dispose() {
			return runtime.dispose();
		},
		sidecarPid() {
			return sidecarPidFromRuntime(runtime);
		},
	};
}

export function createBenchSidecar(options: SidecarSpawnOptions = {}): SidecarProcess {
	return SidecarProcess.spawn(options);
}

function sidecarPidFromRuntime(runtime: NodeRuntime): number | null {
	const pid = (runtime as unknown as {
		kernel?: { client?: { child?: { pid?: number } } };
	}).kernel?.client?.child?.pid;
	return typeof pid === "number" ? pid : null;
}

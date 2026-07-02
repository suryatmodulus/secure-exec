import {
	NodeRuntime,
	resolveNodeRuntimeCommandsDir,
	SidecarProcess,
	type HostDirectoryMount,
	type NodeRuntimeProcess,
	type NodeRuntimeResourceSnapshot,
	type SidecarSpawnOptions,
	type VirtualDirEntry,
} from "@secure-exec/core";

export interface BenchVmOptions {
	commandsDir?: string;
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
	mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
	delete(path: string, options?: { recursive?: boolean }): Promise<void>;
	readFile(path: string): Promise<Uint8Array>;
	readDir(path: string): Promise<string[]>;
	readdir(path: string): Promise<string[]>;
	readDirWithTypes(path: string): Promise<VirtualDirEntry[]>;
	exec(
		commandLine: string,
		options?: {
			env?: Record<string, string>;
			cwd?: string;
			stdin?: string | Uint8Array;
			onStdout?: (data: Uint8Array) => void;
			onStderr?: (data: Uint8Array) => void;
		},
	): Promise<{ stdout: string; stderr: string; exitCode: number }>;
	execArgv(
		command: string,
		args: string[],
		options?: {
			env?: Record<string, string>;
			cwd?: string;
			stdin?: string | Uint8Array;
			onStdout?: (data: Uint8Array) => void;
			onStderr?: (data: Uint8Array) => void;
		},
	): Promise<{ stdout: string; stderr: string; exitCode: number }>;
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
			cwd?: string;
			onStdout?: (data: Uint8Array) => void;
			onStderr?: (data: Uint8Array) => void;
		},
	): BenchVmProcess;
	waitProcess(pid: number): Promise<number>;
	execWasmCommand(
		cmd: string,
		args: string[],
		options?: {
			env?: Record<string, string>;
			cwd?: string;
			stdin?: string | Uint8Array;
			onStdout?: (data: Uint8Array) => void;
			onStderr?: (data: Uint8Array) => void;
		},
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
		commandsDir: options.commandsDir,
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
		async mkdir(path, options = {}) {
			const args = options.recursive ? ["-p", path] : [path];
			const result = await runtime.execCommand("mkdir", args);
			if (result.exitCode !== 0) {
				throw new Error(`mkdir ${path} exited ${result.exitCode}\n${result.stderr}`);
			}
		},
		async delete(path, options = {}) {
			const args = options.recursive ? ["-rf", path] : [path];
			const result = await runtime.execCommand("rm", args);
			if (result.exitCode !== 0) {
				throw new Error(`rm ${path} exited ${result.exitCode}\n${result.stderr}`);
			}
		},
		readFile(path) {
			return runtime.readFile(path);
		},
		readDir(path) {
			return runtime.readDir(path);
		},
		readdir(path) {
			return runtime.readDir(path);
		},
		readDirWithTypes(path) {
			return runtime.readDirWithTypes(path);
		},
		exec(commandLine, execOptions = {}) {
			return runtime.execCommand("sh", ["-c", commandLine], execOptions);
		},
		execArgv(command, args, execOptions = {}) {
			return runtime.execCommand(command, args, execOptions);
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
				cwd: spawnOptions.cwd,
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
		execWasmCommand(cmd, args, execOptions = {}) {
			return runtime.execCommand(cmd, args, execOptions);
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

export function resolveBenchCommandsDir(explicit?: string): string {
	return resolveNodeRuntimeCommandsDir(explicit);
}

function sidecarPidFromRuntime(runtime: NodeRuntime): number | null {
	const pid = (runtime as unknown as {
		kernel?: { client?: { child?: { pid?: number } } };
	}).kernel?.client?.child?.pid;
	return typeof pid === "number" ? pid : null;
}

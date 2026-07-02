import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandBenchmarkOp } from "../lib/layers.js";
import { nowMs } from "../lib/perf-utils.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const GIT_WASM_DIR = join(REPO_ROOT, "registry/software/git/wasm");
const VM_LS_DIR = "/tmp/ecosystem-ls-100";
const VM_GREP_FILE = "/tmp/ecosystem-grep-1m.txt";
const VM_GIT_DIR = "/tmp/ecosystem-git-init-commit";

export function ecosystemWasmCommandDirs(): string[] {
	return gitWasmAvailable() ? [GIT_WASM_DIR] : [];
}

export const ecosystemFamily: CommandBenchmarkOp[] = [
	{
		family: "ecosystem",
		name: "ls_100",
		fileLine: "packages/benchmarks/src/families/ecosystem.ts:27",
		reproducer: "ls -1 over a pre-created 100-file directory",
		runHostCmd: (iters, warmup) => {
			const dir = createHostDirWithFiles("secure-exec-ecosystem-ls-", 100);
			try {
				return sampleSyncCommand(iters, warmup, () => {
					const stdout = execFileSync("ls", ["-1", dir], { encoding: "utf8" });
					const count = stdout.trim().split("\n").filter(Boolean).length;
					if (count !== 100) throw new Error(`host ls_100 returned ${count}`);
				});
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		runVmCmd: async (vm, iters, warmup) => {
			await setupVmDirWithFiles(vm, VM_LS_DIR, 100);
			return sampleAsyncCommand(iters, warmup, async () => {
				const result = await vm.execWasmCommand("ls", ["-1", VM_LS_DIR]);
				assertExit(result, "vm ls_100");
				const count = result.stdout.trim().split("\n").filter(Boolean).length;
				if (count !== 100) throw new Error(`vm ls_100 returned ${count}`);
			});
		},
	},
	{
		family: "ecosystem",
		name: "grep_1m",
		fileLine: "packages/benchmarks/src/families/ecosystem.ts:53",
		reproducer: "grep -c needle over a pre-created ~1MiB text fixture",
		runHostCmd: (iters, warmup) => {
			const dir = mkdtempSync(join(tmpdir(), "secure-exec-ecosystem-grep-"));
			const file = join(dir, "fixture.txt");
			writeFileSync(file, grepFixture());
			try {
				return sampleSyncCommand(iters, warmup, () => {
					const stdout = execFileSync("grep", ["-c", "needle", file], {
						encoding: "utf8",
					});
					assertCount(stdout, 256, "host grep_1m");
				});
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		runVmCmd: async (vm, iters, warmup) => {
			await vm.writeFile(VM_GREP_FILE, grepFixture());
			return sampleAsyncCommand(iters, warmup, async () => {
				const result = await vm.execWasmCommand("grep", [
					"-c",
					"needle",
					VM_GREP_FILE,
				]);
				assertExit(result, "vm grep_1m");
				assertCount(result.stdout, 256, "vm grep_1m");
			});
		},
	},
	{
		family: "ecosystem",
		name: "git_init_commit",
		fileLine: "packages/benchmarks/src/families/ecosystem.ts:83",
		reproducer: "git init, add ten files, commit, and rev-parse HEAD",
		skipReason: gitWasmAvailable()
			? undefined
			: "registry/software/git/wasm is not available in this checkout",
		runHostCmd: (iters, warmup) =>
			sampleSyncCommand(iters, warmup, () => {
				const dir = createHostDirWithFiles("secure-exec-ecosystem-git-", 10);
				try {
					const stdout = execFileSync("sh", ["-c", gitScript()], {
						cwd: dir,
						encoding: "utf8",
						env: gitEnv(),
					});
					assertSha(stdout, "host git_init_commit");
				} finally {
					rmSync(dir, { recursive: true, force: true });
				}
			}),
		runVmCmd: async (vm, iters, warmup) =>
			sampleAsyncCommand(iters, warmup, async (i) => {
				const dir = `${VM_GIT_DIR}-${i}`;
				await setupVmDirWithFiles(vm, dir, 10);
				const result = await vm.execWasmCommand("sh", ["-c", gitScript()], {
					cwd: dir,
					env: gitEnv(),
				});
				assertExit(result, "vm git_init_commit");
				assertSha(result.stdout, "vm git_init_commit");
			}),
	},
	{
		family: "ecosystem",
		name: "sh_pipeline",
		fileLine: "packages/benchmarks/src/families/ecosystem.ts:118",
		reproducer: 'sh -c "ls -1 | grep -c ." over a 100-file directory',
		runHostCmd: (iters, warmup) => {
			const dir = createHostDirWithFiles("secure-exec-ecosystem-pipeline-", 100);
			try {
				return sampleSyncCommand(iters, warmup, () => {
					const stdout = execFileSync("sh", ["-c", "ls -1 | grep -c ."], {
						cwd: dir,
						encoding: "utf8",
					});
					assertCount(stdout, 100, "host sh_pipeline");
				});
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		runVmCmd: async (vm, iters, warmup) => {
			await setupVmDirWithFiles(vm, VM_LS_DIR, 100);
			return sampleAsyncCommand(iters, warmup, async () => {
				const result = await vm.execWasmCommand("sh", [
					"-c",
					"ls -1 | grep -c .",
				], { cwd: VM_LS_DIR });
				assertExit(result, "vm sh_pipeline");
				assertCount(result.stdout, 100, "vm sh_pipeline");
			});
		},
	},
];

function gitWasmAvailable(): boolean {
	return existsSync(GIT_WASM_DIR);
}

function gitEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	return {
		...env,
		GIT_AUTHOR_NAME: "Bench",
		GIT_AUTHOR_EMAIL: "bench@example.com",
		GIT_COMMITTER_NAME: "Bench",
		GIT_COMMITTER_EMAIL: "bench@example.com",
	};
}

function gitScript(): string {
	return [
		"git init -q",
		"git add .",
		"git commit -q -m init",
		"git rev-parse HEAD",
	].join(" && ");
}

function createHostDirWithFiles(prefix: string, fileCount: number): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	mkdirSync(dir, { recursive: true });
	for (let i = 0; i < fileCount; i++) {
		writeFileSync(join(dir, `file-${String(i).padStart(4, "0")}.txt`), "x\n");
	}
	return dir;
}

async function setupVmDirWithFiles(
	vm: { exec(commandLine: string): Promise<unknown>; writeFile(path: string, content: string): Promise<void> },
	dir: string,
	fileCount: number,
): Promise<void> {
	await vm.exec(`rm -rf ${dir} && mkdir -p ${dir}`);
	for (let i = 0; i < fileCount; i++) {
		await vm.writeFile(`${dir}/file-${String(i).padStart(4, "0")}.txt`, "x\n");
	}
}

function grepFixture(): string {
	const lines: string[] = [];
	for (let i = 0; i < 16_384; i++) {
		lines.push(i % 64 === 0 ? `needle line ${i}` : `plain line ${i}`);
	}
	return lines.join("\n");
}

function sampleSyncCommand(
	iters: number,
	warmup: number,
	fn: (index: number) => void,
): number[] {
	const samples: number[] = [];
	for (let i = 0; i < warmup + iters; i++) {
		const start = process.hrtime.bigint();
		fn(i);
		const ms = nowMs(start);
		if (i >= warmup) samples.push(ms);
	}
	return samples;
}

async function sampleAsyncCommand(
	iters: number,
	warmup: number,
	fn: (index: number) => Promise<void>,
): Promise<number[]> {
	const samples: number[] = [];
	for (let i = 0; i < warmup + iters; i++) {
		const start = process.hrtime.bigint();
		await fn(i);
		const ms = nowMs(start);
		if (i >= warmup) samples.push(ms);
	}
	return samples;
}

function assertExit(
	result: { exitCode: number; stderr: string },
	context: string,
): void {
	if (result.exitCode !== 0) {
		throw new Error(`${context} exited ${result.exitCode}\n${result.stderr}`);
	}
}

function assertCount(stdout: string, expected: number, context: string): void {
	const actual = Number(stdout.trim());
	if (actual !== expected) {
		throw new Error(`${context} count ${actual}, expected ${expected}`);
	}
}

function assertSha(stdout: string, context: string): void {
	if (!/^[0-9a-f]{40}$/i.test(stdout.trim())) {
		throw new Error(`${context} did not emit a commit sha: ${stdout}`);
	}
}

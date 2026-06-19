/**
 * Shared utilities for the Secure Exec cold-start, warm-start, and memory
 * benchmarks.
 *
 * The benchmarks drive the public SDK exactly as a consumer would:
 *
 *   import { NodeRuntime } from "secure-exec";
 *   const runtime = await NodeRuntime.create();
 *   await runtime.exec("export const x = 1;");
 *   await runtime.dispose();
 *
 * `NodeRuntime.create()` boots an out-of-process sidecar VM: it spawns the
 * sidecar binary, opens a session, creates a VM with a bootstrapped root
 * filesystem, and mounts the shell + Node runtimes. There is no in-process
 * isolate path. The benchmarks therefore measure full VM boot cost, not
 * isolate creation.
 */

import os from "node:os";
import { NodeRuntime } from "secure-exec";

/**
 * The full matrix matches the original harness: batch sizes 1/10/50/100/200,
 * 5 recorded iterations, 1 warmup discarded. All four are overridable via env so
 * a quick smoke run is possible without editing the file, e.g.:
 *
 *   BENCH_BATCH_SIZES=1,5 BENCH_ITERATIONS=2 BENCH_WARMUP=0 tsx coldstart.bench.ts
 */
function numList(envVar: string, fallback: number[]): number[] {
	const raw = process.env[envVar];
	if (!raw) return fallback;
	return raw
		.split(",")
		.map((s) => Number(s.trim()))
		.filter((n) => Number.isFinite(n) && n > 0);
}
function num(envVar: string, fallback: number): number {
	const raw = process.env[envVar];
	if (raw === undefined) return fallback;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export const BATCH_SIZES = numList("BENCH_BATCH_SIZES", [1, 10, 50, 100, 200]);
export const ITERATIONS = num("BENCH_ITERATIONS", 5);
export const WARMUP_ITERATIONS = num("BENCH_WARMUP", 1);
export const MEMORY_ITERATIONS = num("BENCH_MEMORY_ITERATIONS", 5);

/**
 * A trivial guest program: just enough to confirm the runtime is live and the
 * first `exec()` round-trips. Keeps the measurement focused on runtime boot,
 * not workload.
 */
export const TRIVIAL_CODE = "export const x = 1;";

/**
 * Cap concurrency below available parallelism to leave headroom for the bench
 * harness, Node's event loop, and each sidecar's own threads.
 */
export const MAX_CONCURRENCY = Math.max(1, os.availableParallelism() - 4);

export async function createBenchRuntime(): Promise<NodeRuntime> {
	return NodeRuntime.create();
}

export function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return Number.NaN;
	const idx = Math.ceil((p / 100) * sorted.length) - 1;
	return sorted[Math.max(0, idx)];
}

export function stats(samples: number[]) {
	const sorted = [...samples].sort((a, b) => a - b);
	const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
	return {
		samples: samples.length,
		mean: round(mean),
		p50: round(percentile(sorted, 50)),
		p95: round(percentile(sorted, 95)),
		p99: round(percentile(sorted, 99)),
		min: round(sorted[0]),
		max: round(sorted[sorted.length - 1]),
	};
}

export function round(n: number, decimals = 2): number {
	const f = 10 ** decimals;
	return Math.round(n * f) / f;
}

export function formatBytes(bytes: number): string {
	if (Math.abs(bytes) < 1024) return `${bytes} B`;
	const mb = bytes / (1024 * 1024);
	return `${round(mb, 2)} MB`;
}

export function getHardware() {
	const cpus = os.cpus();
	return {
		cpu: cpus[0]?.model ?? "unknown",
		cores: os.availableParallelism(),
		ram: `${round(os.totalmem() / 1024 ** 3, 1)} GB`,
		node: process.version,
		os: `${os.type()} ${os.release()}`,
		arch: os.arch(),
	};
}

export function forceGC() {
	if (global.gc) {
		global.gc();
	} else {
		console.error("WARNING: global.gc not available. Run with --expose-gc");
	}
}

export async function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/** Print a table to stderr for human readability. */
export function printTable(
	headers: string[],
	rows: (string | number)[][],
): void {
	const widths = headers.map((h, i) =>
		Math.max(h.length, ...rows.map((r) => String(r[i]).length)),
	);
	const sep = widths.map((w) => "-".repeat(w)).join(" | ");
	const fmt = (row: (string | number)[]) =>
		row.map((c, i) => String(c).padStart(widths[i])).join(" | ");

	console.error("");
	console.error(fmt(headers));
	console.error(sep);
	for (const row of rows) {
		console.error(fmt(row));
	}
	console.error("");
}

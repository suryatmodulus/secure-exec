/**
 * Cold-start and warm-start latency benchmark for the Secure Exec runtime.
 *
 * Measures, against the public `secure-exec` SDK:
 *   - Cold start: time from `NodeRuntime.create()` through the first `exec()`
 *     of a trivial program completing. This is the full out-of-process VM boot:
 *     sidecar spawn, session open, VM create, root-filesystem bootstrap, shell
 *     and Node runtime mount, plus the first guest execution.
 *   - Warm start: time for a second `exec()` on the already-booted runtime. The
 *     VM is reused, so this isolates the per-execution cost.
 *   - Both sequential and concurrent modes at various batch sizes.
 *
 * Usage:
 *   SECURE_EXEC_SIDECAR_BIN=/path/to/secure-exec-sidecar tsx coldstart.bench.ts
 *
 * Build a release sidecar first for meaningful numbers:
 *   cargo build --release -p secure-exec-sidecar
 */

import {
	BATCH_SIZES,
	createBenchRuntime,
	getHardware,
	ITERATIONS,
	MAX_CONCURRENCY,
	printTable,
	stats,
	TRIVIAL_CODE,
	WARMUP_ITERATIONS,
} from "./bench-utils.js";

interface ColdStartEntry {
	batchSize: number;
	mode: "sequential" | "concurrent";
	iterations: number;
	coldStart: ReturnType<typeof stats>;
	warmStart: ReturnType<typeof stats>;
}

async function measureOne(): Promise<{ coldMs: number; warmMs: number }> {
	const t0 = performance.now();
	const runtime = await createBenchRuntime();
	await runtime.exec(TRIVIAL_CODE);
	const coldMs = performance.now() - t0;

	const t1 = performance.now();
	await runtime.exec(TRIVIAL_CODE);
	const warmMs = performance.now() - t1;

	await runtime.dispose();
	return { coldMs, warmMs };
}

async function benchSequential(batchSize: number): Promise<ColdStartEntry> {
	const coldSamples: number[] = [];
	const warmSamples: number[] = [];

	for (let iter = 0; iter < WARMUP_ITERATIONS + ITERATIONS; iter++) {
		const iterCold: number[] = [];
		const iterWarm: number[] = [];

		for (let i = 0; i < batchSize; i++) {
			const { coldMs, warmMs } = await measureOne();
			iterCold.push(coldMs);
			iterWarm.push(warmMs);
		}

		// Skip warmup iterations
		if (iter >= WARMUP_ITERATIONS) {
			coldSamples.push(...iterCold);
			warmSamples.push(...iterWarm);
		}
	}

	return {
		batchSize,
		mode: "sequential",
		iterations: ITERATIONS,
		coldStart: stats(coldSamples),
		warmStart: stats(warmSamples),
	};
}

async function benchConcurrent(batchSize: number): Promise<ColdStartEntry> {
	const effectiveConcurrency = Math.min(batchSize, MAX_CONCURRENCY);
	const coldSamples: number[] = [];
	const warmSamples: number[] = [];

	for (let iter = 0; iter < WARMUP_ITERATIONS + ITERATIONS; iter++) {
		const iterCold: number[] = [];
		const iterWarm: number[] = [];
		let remaining = batchSize;

		// Launch in chunks up to MAX_CONCURRENCY so we never oversubscribe the
		// host beyond the configured concurrency.
		while (remaining > 0) {
			const chunk = Math.min(remaining, effectiveConcurrency);
			const results = await Promise.all(
				Array.from({ length: chunk }, () => measureOne()),
			);
			for (const { coldMs, warmMs } of results) {
				iterCold.push(coldMs);
				iterWarm.push(warmMs);
			}
			remaining -= chunk;
		}

		if (iter >= WARMUP_ITERATIONS) {
			coldSamples.push(...iterCold);
			warmSamples.push(...iterWarm);
		}
	}

	return {
		batchSize,
		mode: "concurrent",
		iterations: ITERATIONS,
		coldStart: stats(coldSamples),
		warmStart: stats(warmSamples),
	};
}

async function main() {
	const hardware = getHardware();
	console.error("=== Cold Start Benchmark ===");
	console.error(`CPU: ${hardware.cpu}`);
	console.error(
		`Cores: ${hardware.cores} | Max concurrency: ${MAX_CONCURRENCY}`,
	);
	console.error(`RAM: ${hardware.ram} | Node: ${hardware.node}`);
	console.error(`Iterations: ${ITERATIONS} (+ ${WARMUP_ITERATIONS} warmup)`);
	console.error(`Batch sizes: ${BATCH_SIZES.join(", ")}`);
	console.error(
		`Sidecar: ${process.env.SECURE_EXEC_SIDECAR_BIN ?? "(resolved from @secure-exec/sidecar)"}\n`,
	);

	const results: ColdStartEntry[] = [];

	for (const batchSize of BATCH_SIZES) {
		console.error(`\n--- batch=${batchSize}, mode=sequential ---`);
		const seq = await benchSequential(batchSize);
		results.push(seq);
		console.error(
			`  cold: mean=${seq.coldStart.mean}ms p50=${seq.coldStart.p50}ms p95=${seq.coldStart.p95}ms`,
		);
		console.error(
			`  warm: mean=${seq.warmStart.mean}ms p50=${seq.warmStart.p50}ms p95=${seq.warmStart.p95}ms`,
		);

		console.error(`\n--- batch=${batchSize}, mode=concurrent ---`);
		const conc = await benchConcurrent(batchSize);
		results.push(conc);
		console.error(
			`  cold: mean=${conc.coldStart.mean}ms p50=${conc.coldStart.p50}ms p95=${conc.coldStart.p95}ms`,
		);
		console.error(
			`  warm: mean=${conc.warmStart.mean}ms p50=${conc.warmStart.p50}ms p95=${conc.warmStart.p95}ms`,
		);
	}

	printTable(
		[
			"batch",
			"mode",
			"cold mean",
			"cold p50",
			"cold p95",
			"warm mean",
			"warm p50",
			"warm p95",
		],
		results.map((r) => [
			r.batchSize,
			r.mode,
			`${r.coldStart.mean}ms`,
			`${r.coldStart.p50}ms`,
			`${r.coldStart.p95}ms`,
			`${r.warmStart.mean}ms`,
			`${r.warmStart.p50}ms`,
			`${r.warmStart.p95}ms`,
		]),
	);

	// JSON to stdout for capture.
	console.log(JSON.stringify({ hardware, results }, null, 2));
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});

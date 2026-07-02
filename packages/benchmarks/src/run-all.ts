import { allOps } from "./families/index.js";
import { ecosystemWasmCommandDirs } from "./families/ecosystem.js";
import {
	isLayerOpResult,
	runOp,
	runCommandOp,
	supportsWasmLayer,
	wasmLayerOptions,
	type LatencyResult,
} from "./lib/layers.js";
import { createBenchVm } from "./lib/vm.js";
import { findingsFromLatency, refutedFromLatency, writeJson } from "./lib/report.js";
import { getHardware, printTable } from "./lib/perf-utils.js";
import { runFuzz } from "./fuzz/run.js";
import { runLeakSuite } from "./leak.js";
import { runFootprint } from "./footprint.js";
import { compareBaselineFile } from "./compare-baseline.js";

const RESULTS_DIR = new URL("../results/", import.meta.url).pathname;
const ITERATIONS = Number(process.env.BENCH_ITERATIONS ?? 20);
const WARMUP = Number(process.env.BENCH_WARMUP ?? 5);
const FAMILY_FILTER = process.env.BENCH_FAMILIES
	?.split(",")
	.map((family) => family.trim())
	.filter(Boolean);
const OP_FILTER = process.env.BENCH_OP_FILTER
	?.split(",")
	.map((op) => op.trim())
	.filter(Boolean);

export async function runLatencyMatrix(): Promise<LatencyResult[]> {
	const wasmOptions = wasmLayerOptions();
	if (!wasmOptions) {
		console.error("vm-wasm lane disabled: native-baseline wasm artifact was not found");
	}
	const commandDirs = ecosystemWasmCommandDirs();
	const vm = await createBenchVm({
		...(wasmOptions ?? {}),
		wasmCommandDirs: [
			...(wasmOptions?.wasmCommandDirs ?? []),
			...commandDirs,
		],
	});
	try {
		const results: LatencyResult[] = [];
		const ops = FAMILY_FILTER
			? allOps.filter((op) => FAMILY_FILTER.includes(op.family))
			: allOps;
		const filteredOps = OP_FILTER
			? ops.filter((op) => OP_FILTER.includes(op.name) || OP_FILTER.includes(`${op.family}/${op.name}`))
			: ops;
		for (const op of filteredOps) {
			console.error(`latency ${op.family}/${op.name}`);
			if (!("runHostCmd" in op) && op.nativeOp && supportsWasmLayer(op.nativeOp)) {
				console.error("  wasm lane: guest JS measured first, wasm native-baseline after");
			}
			results.push(
				"runHostCmd" in op
					? await runCommandOp(op, vm, ITERATIONS, WARMUP)
					: await runOp(op, vm, ITERATIONS, WARMUP),
			);
		}
		return results;
	} finally {
		await vm.dispose();
	}
}

async function main(): Promise<void> {
	const latency = await runLatencyMatrix();
	const layerLatency = latency.filter(isLayerOpResult);
	const findings = findingsFromLatency(layerLatency);
	const refuted = refutedFromLatency(layerLatency);
	const resourceSnapshotStubbed = false;
	const fuzz = FAMILY_FILTER
		? { programs: [], findings: [], refuted: [] }
		: await runFuzz({ iterations: ITERATIONS, warmup: WARMUP });
	const leak = FAMILY_FILTER ? { findings: [], streams: [] } : await runLeakSuite();
	const footprint = FAMILY_FILTER
		? { findings: [], components: [] }
		: await runFootprint();
	const findingsJson = {
		generatedAt: new Date().toISOString(),
		hardware: getHardware(),
		iterations: ITERATIONS,
		warmup: WARMUP,
		resourceSnapshotStubbed,
		latency,
		fuzz,
		leak,
		footprint,
		findings: [
			...findings,
			...fuzz.findings,
			...leak.findings,
			...footprint.findings,
		].sort((a, b) => b.emulation_ratio - a.emulation_ratio),
		refuted: [
			...refuted,
			...fuzz.refuted,
			{
				family: "net",
				op: "udp_echo",
				reason: "guest UDP datagrams are unsupported in the current kernel-backed V8 bridge",
				evidence: "ERR_NOT_IMPLEMENTED: external UDP datagrams are not yet supported by the kernel-backed V8 bridge",
			},
		],
		critic_gaps: criticGaps(latency, fuzz, leak, footprint),
	};
	writeJson(`${RESULTS_DIR}/latency-matrix.json`, { latency });
	writeJson(`${RESULTS_DIR}/findings.json`, findingsJson);
	const baselinePath = `${RESULTS_DIR}/baseline/findings-baseline.json`;
	const diff = compareBaselineFile(`${RESULTS_DIR}/findings.json`, baselinePath);
	writeJson(`${RESULTS_DIR}/regression-diff.json`, diff);

	printTable(
		[
			"family",
			"op",
			"native p50",
			"node p50",
			"guest p50",
			"wasm p50",
			"hostCmd p50",
			"vmCmd p50",
			"vm/host",
		],
		latency.map((result) => {
			if (isLayerOpResult(result)) {
				return [
					result.family,
					result.op,
					result.layers.native
						? `${result.layers.native.p50}ms`
						: `unsupported: ${result.unsupported?.native ?? "n/a"}`,
					`${result.layers.node.p50}ms`,
					`${result.layers.guest.p50}ms`,
					result.layers.wasm
						? `${result.layers.wasm.p50}ms`
						: result.unsupported?.wasm
							? `unsupported: ${result.unsupported.wasm}`
							: "-",
					"-",
					"-",
					"-",
				];
			}
			return [
				result.family,
				result.op,
				"-",
				"-",
				"-",
				"-",
				result.layers.hostCmd ? `${result.layers.hostCmd.p50}ms` : "-",
				result.layers.vmCmd ? `${result.layers.vmCmd.p50}ms` : "-",
				result.tax.command ?? result.skipReason ?? "-",
			];
		}),
	);

	printTable(
		["family", "op", "guest/node", "guest/native", "file:line"],
		findingsJson.findings.map((finding) => [
			finding.family,
			finding.op,
			finding.emulation_ratio,
			finding.total_ratio,
			finding.file_line,
		]),
	);
	console.log(JSON.stringify(findingsJson, null, 2));
}

function criticGaps(
	latency: LatencyResult[],
	fuzz: Awaited<ReturnType<typeof runFuzz>>,
	leak: { streams: Array<{ idleMs: number }> },
	footprint: { components?: unknown[] },
): string[] {
	const gaps: string[] = [];
	const covered = new Set(
		latency.filter(isLayerOpResult).map((result) => `${result.family}/${result.op}`),
	);
	for (const required of [
		"process/fanout_spawn_8",
		"process/wait_reap_storm_8",
		"fs/readdir_large",
		"dns/resolve_concurrent_4",
		"pipes/backpressure_chunks",
		"control/cpu_loop",
	]) {
		if (!covered.has(required)) gaps.push(`missing fixed op ${required}`);
	}
	gaps.push(
		"unsupported fixed op net/udp_echo: guest dgram send returns ERR_NOT_IMPLEMENTED for external UDP datagrams",
	);
	if (!fuzz.findings.some((finding) => finding.op === "fanout-stdout-storm")) {
		gaps.push("fuzz did not confirm the non-P2 stdout fanout slow path");
	}
	if (leak.streams.some((stream) => stream.idleMs < 61_000)) {
		gaps.push("leak suite was run in smoke mode without waiting past 60s ZOMBIE_TTL");
	}
	if (footprint.components?.length === 0) {
		gaps.push("footprint run did not emit component attribution");
	}
	return gaps;
}

main().then(
	() => process.exit(0),
	(error) => {
		console.error(error);
		process.exit(1);
	},
);

/**
 * Baseline recording + regression-gate utilities for the JS-layer benchmarks.
 *
 * Strategy (chosen): a committed `baseline.json` in this directory holds the
 * "golden" numbers plus full metadata. A bench run records its own result JSON,
 * prints a delta table vs the baseline, and — when `--gate` is passed — exits
 * non-zero if a gated metric regresses beyond a *relative* tolerance. Baselines
 * are bumped explicitly with `--update-baseline` so the change is reviewed in a PR.
 *
 * Gate philosophy:
 *   - Gate on p50 (stable) of deterministic, llmock-backed metrics only.
 *   - Use *relative* thresholds (e.g. +12%), not absolute ms, so the gate tolerates
 *     hardware drift within a class.
 *   - Also gate hardware-independent ratios (e.g. the VM tax ratio), which survive
 *     cross-machine variance far better than absolute latencies.
 *   - Never gate on LLM-bound metrics (prompt latency) — those belong to a separate,
 *     informational real-API suite.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
export const BASELINE_PATH = join(HERE, "..", "results", "baseline.json");

export interface PhaseStats {
	mean: number;
	p50: number;
	p95: number;
	p99: number;
	min: number;
	max: number;
	stddev: number;
}

export interface BenchMetadata {
	timestamp: string;
	gitSha: string;
	gitDirty: boolean;
	hardware: {
		cpu: string;
		cores: number;
		ram: string;
		node: string;
		os: string;
		arch: string;
	};
	/** Versions that move the numbers — recorded so a baseline is interpretable. */
	deps: Record<string, string>;
	llmock: boolean;
	iterations: number;
	warmup: number;
}

export interface BenchResult extends BenchMetadata {
	benchmark: string;
	/** lane -> metric -> stats (e.g. lanes.vm.sessionCreate.p50). */
	lanes: Record<string, Record<string, PhaseStats>>;
	/** Derived comparison metrics (e.g. vmTaxMs, vmTaxRatio). */
	derived: Record<string, number>;
}

/** A single gate rule. `path` is "lane.metric.field" or "derived.key". */
export interface GateRule {
	path: string;
	/** Relative tolerance, e.g. 0.12 = fail if current exceeds baseline by >12%. */
	tolerance: number;
	/**
	 * Noise floor: a regression only counts if the *absolute* delta also exceeds
	 * this. Prevents tiny-value metrics (e.g. a ~10ms vmCreate) from flaking the
	 * gate on sub-millisecond jitter that looks large in percent terms.
	 */
	noiseFloor?: number;
	/** Human label for the delta table. */
	label?: string;
}

// ── stats ────────────────────────────────────────────────────────────

export function round(n: number, decimals = 2): number {
	const f = 10 ** decimals;
	return Math.round(n * f) / f;
}

function percentile(sorted: number[], p: number): number {
	const idx = Math.ceil((p / 100) * sorted.length) - 1;
	return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

export function stats(samples: number[]): PhaseStats {
	const sorted = [...samples].sort((a, b) => a - b);
	const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
	const variance =
		samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length;
	return {
		mean: round(mean),
		p50: round(percentile(sorted, 50)),
		p95: round(percentile(sorted, 95)),
		p99: round(percentile(sorted, 99)),
		min: round(sorted[0]),
		max: round(sorted[sorted.length - 1]),
		stddev: round(Math.sqrt(variance)),
	};
}

// ── metadata ─────────────────────────────────────────────────────────

function safe<T>(fn: () => T, fallback: T): T {
	try {
		return fn();
	} catch {
		return fallback;
	}
}

function gitSha(): string {
	// Works for both git and jj (colocated or standalone) checkouts.
	const fromGit = safe(
		() =>
			execFileSync("git", ["rev-parse", "--short", "HEAD"], {
				cwd: REPO_ROOT,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim(),
		"",
	);
	if (fromGit) return fromGit;
	return safe(
		() =>
			execFileSync(
				"jj",
				["log", "-r", "@", "--no-graph", "-T", "commit_id.short()"],
				{ cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
			).trim(),
		"unknown",
	);
}

function gitDirty(): boolean {
	return safe(
		() =>
			execFileSync("git", ["status", "--porcelain"], {
				cwd: REPO_ROOT,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim().length > 0,
		false,
	);
}

/**
 * Best-effort read of an installed package version. Resolves the package's main
 * entry then walks up to its package.json — `require.resolve("<name>/package.json")`
 * fails when the package's `exports` map doesn't expose `./package.json`.
 */
function pkgVersion(name: string): string {
	return safe(() => {
		const req = createRequire(join(REPO_ROOT, "package.json"));
		let dir = dirname(req.resolve(name));
		for (let i = 0; i < 8; i++) {
			const candidate = join(dir, "package.json");
			if (existsSync(candidate)) {
				const pkg = JSON.parse(readFileSync(candidate, "utf8"));
				if (pkg.name === name && pkg.version) return pkg.version;
			}
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
		return "unknown";
	}, "absent");
}

export function collectMetadata(opts: {
	iterations: number;
	warmup: number;
	llmock: boolean;
}): BenchMetadata {
	const cpus = os.cpus();
	return {
		timestamp: new Date().toISOString(),
		gitSha: gitSha(),
		gitDirty: gitDirty(),
		hardware: {
			cpu: cpus[0]?.model ?? "unknown",
			cores: os.availableParallelism(),
			ram: `${round(os.totalmem() / 1024 ** 3, 1)} GB`,
			node: process.version,
			os: `${os.type()} ${os.release()}`,
			arch: os.arch(),
		},
		// These are the versions that swing the numbers — the published-binary vs
		// source-build gap proved versions matter for interpreting a baseline.
		deps: {
			"@secure-exec/core": pkgVersion("@secure-exec/core"),
			"@secure-exec/sidecar": pkgVersion("@secure-exec/sidecar"),
		},
		iterations: opts.iterations,
		warmup: opts.warmup,
		llmock: opts.llmock,
	};
}

// ── baseline IO ──────────────────────────────────────────────────────

export function loadBaseline(): BenchResult | null {
	if (!existsSync(BASELINE_PATH)) return null;
	return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as BenchResult;
}

export function writeBaseline(result: BenchResult): void {
	writeFileSync(BASELINE_PATH, `${JSON.stringify(result, null, 2)}\n`);
}

// ── compare + gate ───────────────────────────────────────────────────

function resolvePath(result: BenchResult, path: string): number | undefined {
	const parts = path.split(".");
	if (parts[0] === "derived") return result.derived[parts[1]];
	const [lane, metric, field] = parts;
	const s = result.lanes[lane]?.[metric];
	return s ? (s[field as keyof PhaseStats] as number) : undefined;
}

export interface GateOutcome {
	path: string;
	label: string;
	baseline: number | undefined;
	current: number | undefined;
	deltaPct: number | undefined;
	tolerance: number;
	regressed: boolean;
}

export function evaluateGate(
	current: BenchResult,
	baseline: BenchResult | null,
	rules: GateRule[],
): GateOutcome[] {
	return rules.map((rule) => {
		const cur = resolvePath(current, rule.path);
		const base = baseline ? resolvePath(baseline, rule.path) : undefined;
		const deltaPct =
			base !== undefined && base !== 0 && cur !== undefined
				? round(((cur - base) / base) * 100)
				: undefined;
		const absDelta =
			base !== undefined && cur !== undefined ? cur - base : undefined;
		const regressed =
			deltaPct !== undefined &&
			absDelta !== undefined &&
			deltaPct > rule.tolerance * 100 &&
			absDelta > (rule.noiseFloor ?? 0);
		return {
			path: rule.path,
			label: rule.label ?? rule.path,
			baseline: base,
			current: cur,
			deltaPct,
			tolerance: rule.tolerance,
			regressed,
		};
	});
}

export function printDeltaTable(outcomes: GateOutcome[]): void {
	const headers = ["metric", "baseline", "current", "delta%", "budget%", ""];
	const rows = outcomes.map((o) => [
		o.label,
		o.baseline ?? "—",
		o.current ?? "—",
		o.deltaPct === undefined ? "—" : `${o.deltaPct > 0 ? "+" : ""}${o.deltaPct}`,
		`±${round(o.tolerance * 100)}`,
		o.baseline === undefined ? "NEW" : o.regressed ? "❌ REGRESSED" : "✓",
	]);
	const widths = headers.map((h, i) =>
		Math.max(h.length, ...rows.map((r) => String(r[i]).length)),
	);
	const fmt = (row: (string | number)[]) =>
		row.map((c, i) => String(c).padStart(widths[i])).join(" | ");
	console.error("");
	console.error(fmt(headers));
	console.error(widths.map((w) => "-".repeat(w)).join("-+-"));
	for (const row of rows) console.error(fmt(row));
	console.error("");
}

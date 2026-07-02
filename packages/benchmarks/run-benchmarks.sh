#!/usr/bin/env bash
#
# Run Secure Exec benchmarks against an optimized sidecar, saving JSON and logs
# to packages/benchmarks/results/.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
cd "$REPO_ROOT"

RESULTS_DIR="$HERE/results"
mkdir -p "$RESULTS_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"

if [[ -n "${BENCH_FAMILIES:-}" && -z "${BENCH_ONLY:-}" ]]; then
	BENCH_ONLY="matrix"
else
	BENCH_ONLY="${BENCH_ONLY:-}"
fi

should_run() {
	local name="$1"
	[[ -z "$BENCH_ONLY" || "$BENCH_ONLY" == "$name" ]]
}

echo "=== Building benchmark TypeScript dependencies ===" >&2
pnpm --dir packages/core build >&2

echo "=== Building release sidecar ===" >&2
cargo build --release -p secure-exec-sidecar >&2
if [[ -n "${CARGO_TARGET_DIR:-}" ]]; then
	export SECURE_EXEC_SIDECAR_BIN="${SECURE_EXEC_SIDECAR_BIN:-$CARGO_TARGET_DIR/release/secure-exec-sidecar}"
else
	export SECURE_EXEC_SIDECAR_BIN="${SECURE_EXEC_SIDECAR_BIN:-$REPO_ROOT/target/release/secure-exec-sidecar}"
fi
echo "Using sidecar: $SECURE_EXEC_SIDECAR_BIN" >&2

build_native_baseline() {
	echo "" >&2
	echo "=== Building native-baseline ===" >&2
	cargo build --release -p native-baseline >&2
	if [[ -n "${CARGO_TARGET_DIR:-}" ]]; then
		export NATIVE_BASELINE_BIN="${NATIVE_BASELINE_BIN:-$CARGO_TARGET_DIR/release/native-baseline}"
	else
		export NATIVE_BASELINE_BIN="${NATIVE_BASELINE_BIN:-$REPO_ROOT/target/release/native-baseline}"
	fi
	echo "Using native baseline: $NATIVE_BASELINE_BIN" >&2
}

build_native_baseline_wasm() {
	if command -v rustup >/dev/null 2>&1 && ! rustup target list --installed | grep -qx "wasm32-wasip1"; then
		echo "=== Skipping vm-wasm lane: Rust target wasm32-wasip1 is not installed ===" >&2
		echo "Install it with: rustup target add wasm32-wasip1" >&2
		export NATIVE_BASELINE_WASM=""
		return
	fi
	echo "" >&2
	echo "=== Building native-baseline wasm32-wasip1 ===" >&2
	cargo build --release --target wasm32-wasip1 -p native-baseline >&2
	if [[ -n "${CARGO_TARGET_DIR:-}" ]]; then
		export NATIVE_BASELINE_WASM="${NATIVE_BASELINE_WASM:-$CARGO_TARGET_DIR/wasm32-wasip1/release/native-baseline.wasm}"
	else
		export NATIVE_BASELINE_WASM="${NATIVE_BASELINE_WASM:-$REPO_ROOT/target/wasm32-wasip1/release/native-baseline.wasm}"
	fi
	echo "Using wasm native baseline: $NATIVE_BASELINE_WASM" >&2
}

run_tsx() {
	local name="$1"
	shift
	if ! should_run "$name"; then
		echo "=== Skipping $name (BENCH_ONLY=$BENCH_ONLY) ===" >&2
		return
	fi
	echo "" >&2
	echo "=== Running $name ===" >&2
	pnpm --dir packages/benchmarks exec tsx "$@" \
		1> "$RESULTS_DIR/${name}-$STAMP.json" \
		2> >(tee "$RESULTS_DIR/${name}-$STAMP.log" >&2)
}

run_node() {
	local name="$1"
	shift
	if ! should_run "$name"; then
		echo "=== Skipping $name (BENCH_ONLY=$BENCH_ONLY) ===" >&2
		return
	fi
	echo "" >&2
	echo "=== Running $name ===" >&2
	pnpm --dir packages/benchmarks exec node "$@" \
		1> "$RESULTS_DIR/${name}-$STAMP.json" \
		2> >(tee "$RESULTS_DIR/${name}-$STAMP.log" >&2)
}

run_tsx "coldstart" "$HERE/coldstart.bench.ts"
run_node "memory" --expose-gc --import tsx/esm "$HERE/memory.bench.ts"

if should_run "matrix"; then
	build_native_baseline
	build_native_baseline_wasm
fi
run_tsx "matrix" "$HERE/src/run-all.ts"

echo "" >&2
echo "Done. Results saved under $RESULTS_DIR" >&2

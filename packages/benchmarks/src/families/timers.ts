import type { BenchmarkOp } from "../lib/layers.js";

/**
 * Timer cadence differential ops.
 *
 * There is no native timer op in the Rust baseline, so these rows use
 * `cpu_loop`. The meaningful signal is guest-vs-host Node timer cadence,
 * especially for guest net polling that is paced with setTimeout
 * (secure-exec crates/execution/src/node_import_cache.rs:4750
 * scheduleSocketPoll).
 */

export const timersFamily: BenchmarkOp[] = [
	{
		family: "timers",
		name: "settimeout_zero_x100",
		nativeOp: "cpu_loop",
		fileLine: "crates/execution/src/node_import_cache.rs:4750",
		reproducer: "100 chained setTimeout(0) awaits inside VM",
		program: `async () => {
  for (let k = 0; k < 100; k++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}`,
	},
	{
		family: "timers",
		name: "settimeout_1ms_x50",
		nativeOp: "cpu_loop",
		fileLine: "crates/execution/src/node_import_cache.rs:4750",
		reproducer: "50 chained setTimeout(1) awaits inside VM",
		program: `async () => {
  for (let k = 0; k < 50; k++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}`,
	},
	{
		family: "timers",
		name: "setimmediate_x1000",
		nativeOp: "cpu_loop",
		fileLine: "crates/execution/src/node_import_cache.rs:4750",
		reproducer: "1000 chained setImmediate awaits inside VM, falling back to setTimeout(0)",
		program: `async () => {
  const schedule = typeof setImmediate === "function"
    ? setImmediate
    : (resolve) => setTimeout(resolve, 0);
  for (let k = 0; k < 1000; k++) {
    await new Promise((resolve) => schedule(resolve));
  }
}`,
	},
];

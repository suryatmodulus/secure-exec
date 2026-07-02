import type { BenchmarkOp } from "../lib/layers.js";

/**
 * Filesystem differential ops.
 *
 * Requested but not shipped:
 *   - module_import_fresh: guest dynamic import cannot resolve a freshly written
 *     file, even when written beside the running benchmark module. Verbatim
 *     smoke error: `Cannot resolve module 'file:///tmp/fuzz-perf-import-1-0-929830bf8caa7.mjs'
 *     (imported from '/tmp/fuzz-perf-fs-module_import_fresh.mjs'): not found.`
 */

export const fsFamily: BenchmarkOp[] = [
	{
		family: "fs",
		name: "open_close_churn",
		nativeOp: "fs_open_close",
		fileLine: "crates/kernel/src/kernel.rs:1950",
		reproducer: "fs.openSync + fs.closeSync on a small fixture inside VM",
		program: `async () => {
  const fs = await import("node:fs");
  const path = "/tmp/fuzz-perf-open-close.txt";
  if (!fs.existsSync(path)) fs.writeFileSync(path, "hi");
  const fd = fs.openSync(path, "r");
  fs.closeSync(fd);
}`,
	},
	{
		family: "fs",
		name: "stat_storm",
		nativeOp: "fs_stat",
		fileLine: "crates/kernel/src/kernel.rs:1950",
		reproducer: "node fs.statSync('/tmp/fuzz-perf-stat.txt') inside VM",
		program: `async (i) => {
  const fs = await import("node:fs");
  const path = "/tmp/fuzz-perf-stat.txt";
  if (!fs.existsSync(path)) fs.writeFileSync(path, "hi");
  fs.statSync(path);
}`,
	},
	{
		family: "fs",
		name: "small_write",
		nativeOp: "fs_write",
		fileLine: "crates/kernel/src/kernel.rs:1930",
		reproducer: "node fs.writeFileSync('/tmp/fuzz-perf-write.txt', payload)",
		program: `async (i) => {
  const fs = await import("node:fs");
  fs.writeFileSync("/tmp/fuzz-perf-write.txt", "hello-" + i);
}`,
	},
	{
		family: "fs",
		name: "module_import_fresh",
		nativeUnsupportedReason: "dynamic import of guest-written JavaScript module",
		wasmUnsupportedReason: "dynamic import of guest-written JavaScript module",
		fileLine: "crates/execution/src/javascript.rs:3939",
		reproducer: "write a unique /tmp .mjs file, dynamic-import it, and verify the exported value",
		program: `async (i) => {
  const fs = await import("node:fs");
  const value = "fresh-" + process.pid + "-" + i;
  const path = "/tmp/fuzz-perf-import-" + process.pid + "-" + i + ".mjs";
  fs.writeFileSync(path, "export const value = " + JSON.stringify(value) + ";\\n");
  const mod = await import("file://" + path);
  if (mod.value !== value) throw new Error("bad fresh import");
  fs.unlinkSync(path);
}`,
	},
	{
		family: "fs",
		name: "big_read",
		nativeOp: "fs_read",
		fileLine: "crates/kernel/src/mount_table.rs:814",
		reproducer: "node fs.readFileSync('/tmp/fuzz-perf-read.bin')",
		program: `async () => {
  const fs = await import("node:fs");
  const path = "/tmp/fuzz-perf-read.bin";
  if (!fs.existsSync(path)) fs.writeFileSync(path, Buffer.alloc(64 * 1024, 7));
  const data = fs.readFileSync(path);
  if (data.length !== 64 * 1024) throw new Error("bad read");
}`,
	},
	{
		family: "fs",
		name: "mkdir_rmdir",
		nativeOp: "fs_mkdir_rmdir",
		fileLine: "crates/kernel/src/mount_table.rs:814",
		reproducer: "fs.mkdirSync + fs.rmdirSync on a fresh VM path",
		program: `async (i) => {
  const fs = await import("node:fs");
  const path = "/tmp/fuzz-perf-dir-" + i + "-" + process.pid;
  fs.mkdirSync(path);
  fs.rmSync(path, { recursive: true });
}`,
	},
	{
		family: "fs",
		name: "rename_file",
		nativeOp: "fs_rename",
		fileLine: "crates/kernel/src/mount_table.rs:814",
		reproducer: "write one file, rename it, then unlink",
		program: `async (i) => {
  const fs = await import("node:fs");
  const from = "/tmp/fuzz-perf-rename-" + i + ".a";
  const to = "/tmp/fuzz-perf-rename-" + i + ".b";
  fs.writeFileSync(from, "hi");
  fs.renameSync(from, to);
  fs.unlinkSync(to);
}`,
	},
	{
		family: "fs",
		name: "readdir_large",
		nativeOp: "fs_readdir",
		fileLine: "crates/kernel/src/mount_table.rs:814",
		reproducer: "readdirSync over a 32-entry VM directory",
		setup: `async () => {
  const fs = await import("node:fs");
  const dir = "/tmp/fuzz-perf-readdir";
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  for (let i = 0; i < 32; i++) {
    const path = dir + "/" + i + ".txt";
    if (!fs.existsSync(path)) fs.writeFileSync(path, "hi");
  }
}`,
		program: `async () => {
  const fs = await import("node:fs");
  const dir = "/tmp/fuzz-perf-readdir";
  const entries = fs.readdirSync(dir);
  if (entries.length < 32) throw new Error("short readdir");
}`,
	},
	{
		family: "fs",
		name: "fsync_small",
		nativeOp: "fs_fsync",
		fileLine: "crates/kernel/src/kernel.rs:1930",
		reproducer: "fs.writeSync then fs.fsyncSync on a small file",
		program: `async () => {
  const fs = await import("node:fs");
  const fd = fs.openSync("/tmp/fuzz-perf-fsync.txt", "w");
  fs.writeSync(fd, "hello");
  fs.fsyncSync(fd);
  fs.closeSync(fd);
}`,
	},
	{
		family: "fs",
		name: "fs_promises_stat_x32",
		nativeOp: "fs_stat",
		fileLine: "crates/kernel/src/kernel.rs:1950",
		reproducer: "32 sequential fs.promises.stat calls on one VM file",
		setup: `async () => {
  const fs = await import("node:fs");
  const path = "/tmp/fuzz-perf-promises-stat.txt";
  if (!fs.existsSync(path)) fs.writeFileSync(path, "hi");
}`,
		program: `async () => {
  const fs = await import("node:fs");
  const path = "/tmp/fuzz-perf-promises-stat.txt";
  for (let k = 0; k < 32; k++) {
    await fs.promises.stat(path);
  }
}`,
	},
	{
		family: "fs",
		name: "stream_copy_1m",
		nativeOp: "fs_read",
		fileLine: "crates/kernel/src/mount_table.rs:814",
		reproducer: "stream pipeline copies one 1MiB file inside VM",
		setup: `async () => {
  const fs = await import("node:fs");
  const src = "/tmp/fuzz-perf-stream-copy-src.bin";
  if (!fs.existsSync(src)) fs.writeFileSync(src, Buffer.alloc(1024 * 1024, 7));
}`,
		program: `async (i) => {
  const fs = await import("node:fs");
  const { pipeline } = await import("node:stream/promises");
  const src = "/tmp/fuzz-perf-stream-copy-src.bin";
  const dst = "/tmp/fuzz-perf-stream-copy-dst-" + i + ".bin";
  await pipeline(fs.createReadStream(src), fs.createWriteStream(dst));
  const stat = fs.statSync(dst);
  fs.unlinkSync(dst);
  if (stat.size !== 1024 * 1024) throw new Error("bad stream copy");
}`,
	},
];

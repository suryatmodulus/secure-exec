/**
 * Process isolation example.
 *
 * Each `NodeRuntime.create()` boots a fully virtualized VM. Two runtimes share
 * nothing: not the filesystem, not globals, not module state. And within a
 * single runtime, every `exec()` / `run()` call runs a fresh guest process, so
 * one run cannot leak in-memory state into the next.
 *
 * This example demonstrates both boundaries:
 *
 *   1. Two separate runtimes (A and B) write the same path and read it back -
 *      neither sees the other's data, proving filesystem isolation.
 *   2. Two consecutive runs in the SAME runtime mutate a global - the second
 *      run starts clean, proving each run is a fresh process with no shared
 *      in-memory state.
 *
 * Run with:
 *   SECURE_EXEC_SIDECAR_BIN=../../../target/debug/secure-exec-sidecar \
 *     npx tsx src/index.mts
 */

import { NodeRuntime } from "secure-exec";

// Boot two independent VMs. Each is its own isolation domain.
const rtA = await NodeRuntime.create();
const rtB = await NodeRuntime.create();

try {
  // --- 1. Filesystem isolation between two runtimes ---------------------
  // Both runtimes write to the exact same path. Because each runtime has its
  // own virtual filesystem, the writes never collide.
  await rtA.exec(`
    import { writeFileSync } from "node:fs";
    writeFileSync("/tmp/shared-path.txt", "data from runtime A");
  `);
  await rtB.exec(`
    import { writeFileSync } from "node:fs";
    writeFileSync("/tmp/shared-path.txt", "data from runtime B");
  `);

  // `run()` wraps the body in an async function, so use dynamic `import()`
  // (top-level `import` statements only work in `exec()`).
  const readA = await rtA.run<string>(`
    const { readFileSync } = await import("node:fs");
    __return(readFileSync("/tmp/shared-path.txt", "utf8"));
  `);
  const readB = await rtB.run<string>(`
    const { readFileSync } = await import("node:fs");
    __return(readFileSync("/tmp/shared-path.txt", "utf8"));
  `);

  console.log("runtime A reads back:", JSON.stringify(readA.value));
  console.log("runtime B reads back:", JSON.stringify(readB.value));
  console.log(
    "filesystems isolated:",
    readA.value === "data from runtime A" &&
      readB.value === "data from runtime B",
  );

  // Confirm a file created only in B does not exist in A.
  const beforeWrite = await rtA.run<boolean>(`
    const { existsSync } = await import("node:fs");
    __return(existsSync("/tmp/only-in-b.txt"));
  `);
  await rtB.exec(`
    import { writeFileSync } from "node:fs";
    writeFileSync("/tmp/only-in-b.txt", "B");
  `);
  const afterWrite = await rtA.run<boolean>(`
    const { existsSync } = await import("node:fs");
    __return(existsSync("/tmp/only-in-b.txt"));
  `);
  console.log(
    "/tmp/only-in-b.txt visible in A:",
    beforeWrite.value,
    "->",
    afterWrite.value,
  );

  // --- 2. Each run is a fresh process (no shared globals) ----------------
  // The first run sets a global. The second run, in the SAME runtime, observes
  // a clean global state because it is a brand new guest process.
  const firstRun = await rtA.run<number>(`
    globalThis.__counter = (globalThis.__counter ?? 0) + 1;
    __return(globalThis.__counter);
  `);
  const secondRun = await rtA.run<number>(`
    globalThis.__counter = (globalThis.__counter ?? 0) + 1;
    __return(globalThis.__counter);
  `);

  console.log("run 1 counter:", firstRun.value);
  console.log("run 2 counter:", secondRun.value);
  console.log(
    "globals reset per run:",
    firstRun.value === 1 && secondRun.value === 1,
  );
} finally {
  // Each runtime owns its VM and must be disposed independently.
  await rtA.dispose();
  await rtB.dispose();
}

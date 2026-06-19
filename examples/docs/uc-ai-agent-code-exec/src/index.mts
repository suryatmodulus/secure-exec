import { NodeRuntime } from "secure-exec";

// Imagine this string came from an AI agent. We never trust it: it runs fully
// sandboxed inside the secure-exec VM, with no access to the host machine.
const untrustedCode = `
const fib = [0, 1];
while (fib.length < 20) {
  fib.push(fib[fib.length - 1] + fib[fib.length - 2]);
}
console.log("computed", fib.length, "fibonacci numbers");
// Hand a JSON-serializable value back to the host.
globalThis.__return({ fibonacci: fib, sum: fib.reduce((a, b) => a + b, 0) });
`;

const rt = await NodeRuntime.create();
try {
  // rt.run() executes the guest code and decodes whatever it passes to
  // globalThis.__return(), while still capturing stdout/stderr/exitCode.
  const result = await rt.run<{ fibonacci: number[]; sum: number }>(
    untrustedCode,
    { timeout: 5000 },
  );

  console.log("exitCode:", result.exitCode);
  console.log("stdout:", result.stdout.trim());
  console.log("returned value:", JSON.stringify(result.value));

  // The sandbox presents normal Node semantics, but the code cannot touch the
  // host: it only ever sees the virtual filesystem and kernel-mediated syscalls.
  const escapeAttempt = await rt.exec(
    `import os from "node:os";\nconsole.log("guest hostname:", os.hostname());`,
    { timeout: 5000 },
  );
  console.log("\nescape attempt exitCode:", escapeAttempt.exitCode);
  console.log("escape attempt stdout:", escapeAttempt.stdout.trim());
} finally {
  await rt.dispose();
}

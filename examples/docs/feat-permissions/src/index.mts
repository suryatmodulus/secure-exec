import { NodeRuntime } from "secure-exec";

// Permissions are a per-domain policy evaluated against every guest syscall.
// Each domain (fs, network, childProcess, process, env) is configured
// independently as "allow", "deny", or a rule set. Here the guest may use the
// filesystem, but the network is fully denied - so an outbound fetch is blocked
// by the kernel before any socket is opened.
const rt = await NodeRuntime.create({
  permissions: {
    fs: "allow",
    network: "deny",
    childProcess: "allow",
    process: "allow",
    env: "allow",
  },
});

try {
  // Guest code runs as an ES module inside the VM. The filesystem write/read
  // succeeds because fs is allowed; the fetch() throws because the kernel
  // rejects the connection with EACCES from the network policy.
  const { value, stdout, stderr, exitCode } = await rt.run<{
    fileContents: string;
    networkBlocked: boolean;
    networkError: string | null;
  }>(`
    const { mkdirSync, writeFileSync, readFileSync } = await import("node:fs");

    // Allowed: filesystem access is permitted.
    mkdirSync("/workspace", { recursive: true });
    writeFileSync("/workspace/note.txt", "written inside the sandbox");
    const fileContents = readFileSync("/workspace/note.txt", "utf8");
    console.log("filesystem allowed:", fileContents);

    // Denied: the network domain is set to "deny", so fetch() is blocked.
    let networkBlocked = false;
    let networkError = null;
    try {
      await fetch("http://example.com");
      console.log("UNEXPECTED: fetch succeeded");
    } catch (error) {
      networkBlocked = true;
      networkError = (error.cause && error.cause.message) || error.message;
      console.log("network denied:", networkError);
    }

    __return({ fileContents, networkBlocked, networkError });
  `);

  console.log("---");
  console.log("exitCode:", exitCode);
  if (stderr.trim()) console.log("guest stderr:", stderr.trim());
  console.log("guest stdout:\n" + stdout.trim());
  console.log("file contents:", value?.fileContents);
  console.log("network blocked:", value?.networkBlocked);
  console.log("network error:", value?.networkError);

  if (value?.fileContents !== "written inside the sandbox") {
    throw new Error("expected allowed filesystem write/read to succeed");
  }
  if (!value?.networkBlocked) {
    throw new Error("expected denied network fetch to be blocked");
  }
  console.log("OK: filesystem allowed, network denied");
} finally {
  await rt.dispose();
}

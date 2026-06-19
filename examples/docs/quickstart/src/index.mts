import { NodeRuntime } from "secure-exec";

// Boot a fully virtualized runtime. Guest code runs inside the kernel
// isolation boundary - no host escapes.
const runtime = await NodeRuntime.create();

try {
	// run() executes guest JavaScript as an ES module and returns the value the
	// guest passes to globalThis.__return(). stdout/stderr are captured too.
	const result = await runtime.run<{ message: string; sum: number }>(`
		console.log("hello from secure-exec");
		__return({ message: "hello from secure-exec", sum: 1 + 2 });
	`);

	console.log("stdout:", JSON.stringify(result.stdout.trim()));
	console.log("value:", result.value);
	console.log("exitCode:", result.exitCode);
} finally {
	// Tear down the VM and release the sidecar.
	await runtime.dispose();
}

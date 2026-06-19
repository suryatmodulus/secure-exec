import { NodeRuntime } from "secure-exec";

const rt = await NodeRuntime.create();

try {
	const { stdout, stderr, exitCode } = await rt.exec(`
		console.log("hello from the sandbox");
		console.error("oops from the sandbox");
		process.exit(3);
	`);

	console.log("exitCode:", exitCode);
	console.log("stdout:", JSON.stringify(stdout));
	console.log("stderr:", JSON.stringify(stderr));
} finally {
	await rt.dispose();
}

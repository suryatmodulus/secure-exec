import { NodeRuntime } from "secure-exec";

// Boot a sandboxed VM for running untrusted plugin code. The plugin can use
// the filesystem, but network access is denied. (childProcess/process stay
// allowed because the kernel spawns the guest `node` process to run the
// plugin - denying it would block the runtime itself.)
const runtime = await NodeRuntime.create({
	permissions: {
		fs: "allow",
		network: "deny",
		childProcess: "allow",
		process: "allow",
		env: "allow",
	},
});

try {
	// The host owns the plugin source and the input. Here the plugin is a
	// title-case transformer; in a real system it would be uploaded by a user.
	const pluginSource = `
		function transform(input, options = {}) {
			const words = String(input)
				.split(/\\s+/)
				.filter(Boolean)
				.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
			return (options.prefix ?? "") + words.join(" ");
		}
		const manifest = { name: "title-case", version: "1.0.0" };
	`;

	const input = "hello from plugin land";
	const options = { prefix: "Plugin says: " };

	// Run the plugin in isolation and get a structured value back via run().
	// The guest calls __return() with a JSON-serializable value, decoded on the
	// host as result.value. The plugin also proves it cannot reach the network.
	const { value, stdout, exitCode } = await runtime.run<{
		manifest: { name: string; version: string };
		output: string;
		networkBlocked: boolean;
	}>(`
		${pluginSource}

		console.log("running plugin:", manifest.name);

		let networkBlocked = false;
		try {
			await fetch("http://example.com");
		} catch {
			networkBlocked = true;
		}

		__return({
			manifest,
			output: transform(${JSON.stringify(input)}, ${JSON.stringify(options)}),
			networkBlocked,
		});
	`);

	console.log("guest stdout:", stdout.trim());
	console.log("exit code:", exitCode);
	console.log("plugin name:", value?.manifest.name);
	console.log("plugin version:", value?.manifest.version);
	console.log("plugin output:", value?.output);
	console.log("network blocked:", value?.networkBlocked);
} finally {
	await runtime.dispose();
}

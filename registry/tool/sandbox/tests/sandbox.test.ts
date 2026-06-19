import { describe, expect, it } from "vitest";
import { createSandboxFs } from "../src/index.js";

describe("@secure-exec/sandbox", () => {
	it("serializes a native sandbox_agent mount descriptor", () => {
		const mount = createSandboxFs({
			client: {
				baseUrl: "https://sandbox.example.com/",
				token: "sandbox-token",
				defaultHeaders: { "x-sandbox": "enabled" },
			} as never,
			basePath: "/scoped",
			timeoutMs: 12_345,
			maxFullReadBytes: 4096,
		});

		expect(mount).toEqual({
			id: "sandbox_agent",
			config: {
				baseUrl: "https://sandbox.example.com",
				token: "sandbox-token",
				headers: { "x-sandbox": "enabled" },
				basePath: "/scoped",
				timeoutMs: 12_345,
				maxFullReadBytes: 4096,
			},
		});
	});
});

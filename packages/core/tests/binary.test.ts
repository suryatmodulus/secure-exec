import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolvePublishedSidecarBinary } from "../src/binary.js";

const ORIGINAL_OVERRIDE = process.env.SECURE_EXEC_SIDECAR_BIN;

afterEach(() => {
	if (ORIGINAL_OVERRIDE === undefined) {
		delete process.env.SECURE_EXEC_SIDECAR_BIN;
	} else {
		process.env.SECURE_EXEC_SIDECAR_BIN = ORIGINAL_OVERRIDE;
	}
});

describe("secure-exec sidecar binary resolution", () => {
	test("honors SECURE_EXEC_SIDECAR_BIN when the file exists", () => {
		const root = mkdtempSync(join(tmpdir(), "secure-exec-sidecar-bin-"));
		try {
			const binaryPath = join(root, "secure-exec-sidecar");
			writeFileSync(binaryPath, "#!/bin/sh\n", { mode: 0o755 });
			process.env.SECURE_EXEC_SIDECAR_BIN = binaryPath;

			expect(resolvePublishedSidecarBinary()).toBe(binaryPath);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects a missing SECURE_EXEC_SIDECAR_BIN override", () => {
		const binaryPath = join(
			tmpdir(),
			`secure-exec-sidecar-missing-${process.pid}-${Date.now()}`,
		);
		if (existsSync(binaryPath)) {
			rmSync(binaryPath, { force: true });
		}
		process.env.SECURE_EXEC_SIDECAR_BIN = binaryPath;

		expect(() => resolvePublishedSidecarBinary()).toThrow(
			/SECURE_EXEC_SIDECAR_BIN is set to .* but the file does not exist/,
		);
	});

	test("delegates to the secure-exec resolver package when no override is set", () => {
		delete process.env.SECURE_EXEC_SIDECAR_BIN;

		expect(() => resolvePublishedSidecarBinary()).toThrow(
			/@secure-exec\/sidecar: platform package .* is not installed/,
		);
	});
});

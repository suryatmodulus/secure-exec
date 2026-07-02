import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverRustCrates, RUST_CRATES } from "./rust-crates.js";

function withFixture(fn: (root: string) => void) {
	const root = mkdtempSync(join(tmpdir(), "publish-rust-crates-"));
	try {
		fn(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function write(root: string, rel: string, contents: string) {
	const path = join(root, rel);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, contents);
}

function assertBefore(crate: string, dependent: string) {
	const crateIndex = RUST_CRATES.indexOf(crate as (typeof RUST_CRATES)[number]);
	const dependentIndex = RUST_CRATES.indexOf(
		dependent as (typeof RUST_CRATES)[number],
	);

	assert.notEqual(crateIndex, -1, `${crate} is missing from publish order`);
	assert.notEqual(
		dependentIndex,
		-1,
		`${dependent} is missing from publish order`,
	);
	assert(
		crateIndex < dependentIndex,
		`${crate} must publish before ${dependent}`,
	);
}

test("Rust crate publish order satisfies internal dependencies", () => {
	assert.equal(new Set(RUST_CRATES).size, RUST_CRATES.length);

	assertBefore("secure-exec-build-support", "secure-exec-v8-runtime");
	assertBefore("secure-exec-build-support", "secure-exec-execution");
	assertBefore("secure-exec-bridge", "secure-exec-kernel");
	assertBefore("secure-exec-bridge", "secure-exec-v8-runtime");
	assertBefore("secure-exec-vfs-core", "secure-exec-kernel");
	assertBefore("secure-exec-vfs-core", "secure-exec-vfs");
	assertBefore("secure-exec-vfs-core", "secure-exec-sidecar-core");
	assertBefore("secure-exec-kernel", "secure-exec-sidecar-core");
	assertBefore("secure-exec-vm-config", "secure-exec-sidecar-core");
	assertBefore("secure-exec-sidecar-core", "secure-exec-sidecar");
	assertBefore("secure-exec-vfs", "secure-exec-sidecar");
	assertBefore("secure-exec-v8-runtime", "secure-exec-execution");
	assertBefore("secure-exec-execution", "secure-exec-sidecar");
	assertBefore("secure-exec-sidecar", "secure-exec-client");
});

test("discovers the publishable Rust crate subset from a secure-exec-only workspace", () => {
	withFixture((root) => {
		write(
			root,
			"Cargo.toml",
			[
				"[workspace]",
				"members = [",
				'  "crates/bridge",',
				'  "crates/build-support",',
				'  "crates/vfs",',
				'  "crates/kernel",',
				'  "crates/vm-config",',
				'  "crates/sidecar-core",',
				'  "crates/secure-exec-vfs",',
				'  "crates/v8-runtime",',
				'  "crates/execution",',
				'  "crates/sidecar",',
				'  "crates/secure-exec-client",',
				"]",
				"",
			].join("\n"),
		);
		for (const [member, name] of [
			["crates/bridge", "secure-exec-bridge"],
			["crates/build-support", "secure-exec-build-support"],
			["crates/vfs", "secure-exec-vfs-core"],
			["crates/kernel", "secure-exec-kernel"],
			["crates/vm-config", "secure-exec-vm-config"],
			["crates/sidecar-core", "secure-exec-sidecar-core"],
			["crates/secure-exec-vfs", "secure-exec-vfs"],
			["crates/v8-runtime", "secure-exec-v8-runtime"],
			["crates/execution", "secure-exec-execution"],
			["crates/sidecar", "secure-exec-sidecar"],
			["crates/secure-exec-client", "secure-exec-client"],
		]) {
			write(root, join(member, "Cargo.toml"), `[package]\nname = "${name}"\n`);
		}

		assert.deepEqual(discoverRustCrates(root), [
			"secure-exec-build-support",
			"secure-exec-bridge",
			"secure-exec-vfs-core",
			"secure-exec-kernel",
			"secure-exec-vm-config",
			"secure-exec-sidecar-core",
			"secure-exec-vfs",
			"secure-exec-v8-runtime",
			"secure-exec-execution",
			"secure-exec-sidecar",
			"secure-exec-client",
		]);
	});
});

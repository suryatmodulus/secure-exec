"use strict";

// Platform-specific resolver for the prebuilt `secure-exec-sidecar` binary.
// The binary itself ships inside one of the `@secure-exec/sidecar-<platform>`
// packages, declared as optionalDependencies at publish time so npm only
// installs the package matching the current `os`/`cpu`/`libc`.
//
// Resolution priority:
//   1. `SECURE_EXEC_SIDECAR_BIN` env var.
//   2. A `secure-exec-sidecar` binary placed next to this package.
//   3. The platform-specific `@secure-exec/sidecar-<platform>` package.

const { existsSync } = require("node:fs");
const { join, dirname } = require("node:path");

const BINARY_NAME = "secure-exec-sidecar";

// No runtime chmod. Platform packages are published with `npm publish`, which
// preserves the binary's 0755 executable bit.

function getPlatformPackageName() {
	const { platform, arch } = process;
	switch (platform) {
		case "linux":
			if (arch === "x64") return "@secure-exec/sidecar-linux-x64-gnu";
			if (arch === "arm64") return "@secure-exec/sidecar-linux-arm64-gnu";
			break;
		default:
			break;
	}
	return null;
}

function getSidecarPath() {
	const override = process.env.SECURE_EXEC_SIDECAR_BIN;
	if (override) {
		if (!existsSync(override)) {
			throw new Error(
				`SECURE_EXEC_SIDECAR_BIN is set to ${override} but the file does not exist`,
			);
		}
		return override;
	}

	const localBinary = join(__dirname, BINARY_NAME);
	if (existsSync(localBinary)) {
		return localBinary;
	}

	const platformPkg = getPlatformPackageName();
	if (!platformPkg) {
		throw new Error(
			`@secure-exec/sidecar: unsupported platform ${process.platform}/${process.arch}. ` +
				"The Secure Exec sidecar currently supports linux x64 and arm64. " +
				"Set SECURE_EXEC_SIDECAR_BIN to a local secure-exec-sidecar binary to override.",
		);
	}

	let pkgJsonPath;
	try {
		pkgJsonPath = require.resolve(`${platformPkg}/package.json`);
	} catch {
		throw new Error(
			`@secure-exec/sidecar: platform package ${platformPkg} is not installed.\n` +
				"This usually means the platform is unsupported or optionalDependencies were\n" +
				`skipped during install. Try: npm install --include=optional ${platformPkg}\n` +
				"Or set SECURE_EXEC_SIDECAR_BIN to a local secure-exec-sidecar binary.",
		);
	}

	return join(dirname(pkgJsonPath), BINARY_NAME);
}

module.exports = { getSidecarPath };

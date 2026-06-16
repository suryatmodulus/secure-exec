import { existsSync } from "node:fs";
import { createRequire } from "node:module";

interface SidecarBinaryModule {
	getSidecarPath(): string;
}

/**
 * Resolves the published secure-exec sidecar binary for Node.js clients.
 */
export function resolvePublishedSidecarBinary(): string {
	const override = process.env.SECURE_EXEC_SIDECAR_BIN;
	if (override) {
		if (!existsSync(override)) {
			throw new Error(
				`SECURE_EXEC_SIDECAR_BIN is set to ${override} but the file does not exist`,
			);
		}
		return override;
	}

	const require = createRequire(import.meta.url);
	let mod: SidecarBinaryModule;
	try {
		mod = require("@secure-exec/sidecar") as SidecarBinaryModule;
	} catch (error) {
		throw new Error(
			"failed to resolve the secure-exec sidecar binary: the @secure-exec/sidecar " +
				"package is not installed. Install it, or set SECURE_EXEC_SIDECAR_BIN to a local " +
				`secure-exec-sidecar binary. (${(error as Error).message})`,
		);
	}
	return mod.getSidecarPath();
}

/**
 * @secure-exec/typescript — run the TypeScript compiler inside the sandbox.
 *
 * The TypeScript compiler (`typescript.js`) is projected into the VM's virtual
 * filesystem and the compile/type-check program is executed in-guest through
 * the `secure-exec` `NodeRuntime`. The compiler never runs on the host: every
 * `createSourceFile`/`createProgram`/`emit` call happens inside the kernel
 * isolation boundary, over the VM's filesystem.
 */

import { createRequire } from "node:module";
import { dirname } from "node:path";
import { NodeRuntime } from "secure-exec";
import type { HostDirectoryMount, NodeRuntimeCreateOptions } from "secure-exec";

/** VM permission policy, as accepted by `NodeRuntime.create`. */
export type Permissions = NonNullable<NodeRuntimeCreateOptions["permissions"]>;

/** A single TypeScript diagnostic, normalized for host consumption. */
export interface TypeScriptDiagnostic {
	code: number;
	category: "error" | "warning" | "suggestion" | "message";
	message: string;
	filePath?: string;
	line?: number;
	column?: number;
}

/** Result of a type-check (no emit). */
export interface TypeCheckResult {
	success: boolean;
	diagnostics: TypeScriptDiagnostic[];
}

/** Result of compiling a project (emit to the VM filesystem). */
export interface ProjectCompileResult extends TypeCheckResult {
	emitSkipped: boolean;
	emittedFiles: string[];
}

/** Result of compiling a single source string (emit returned in-memory). */
export interface SourceCompileResult extends TypeCheckResult {
	outputText?: string;
	sourceMapText?: string;
}

/** Options for the project-oriented tools. */
export interface ProjectCompilerOptions {
	/** Working directory inside the VM. Defaults to `/root`. */
	cwd?: string;
	/** Explicit path to a `tsconfig.json` inside the VM. */
	configFilePath?: string;
}

/** Options for the single-source tools. */
export interface SourceCompilerOptions {
	/** TypeScript source text to compile or type-check. */
	sourceText: string;
	/** Virtual path the source should appear at. Defaults to a temp `.ts` file. */
	filePath?: string;
	/** Working directory inside the VM. Defaults to `/root`. */
	cwd?: string;
	/** Optional `tsconfig.json` whose `compilerOptions` are applied. */
	configFilePath?: string;
	/** Inline compiler options (esbuild/tsc JSON spelling). */
	compilerOptions?: Record<string, unknown>;
}

/** Options for {@link createTypeScriptTools}. */
export interface TypeScriptToolsOptions {
	/**
	 * Host directory of the `typescript` npm package to project into the VM.
	 * Defaults to the `typescript` package resolved from this package. The
	 * directory is mounted (read lazily) into the VM; the compiler never runs
	 * on the host.
	 */
	compilerPackageDir?: string;
	/**
	 * Guest path the `typescript` package is mounted at. Defaults to
	 * `/root/node_modules/typescript` so it resolves as the `typescript`
	 * package inside the VM.
	 */
	compilerGuestDir?: string;
	/** Extra files to seed into the VM (e.g. a `tsconfig.json` or sources). */
	files?: Record<string, string | Uint8Array>;
	/** Extra host directories to project into the VM, Docker-style. */
	mounts?: HostDirectoryMount[];
	/** Permission policy forwarded to the VM. */
	permissions?: Permissions;
	/** Environment variables visible to the guest compiler. */
	env?: Record<string, string>;
}

/** The in-sandbox TypeScript tools returned by {@link createTypeScriptTools}. */
export interface TypeScriptTools {
	/** Type-check a `tsconfig.json` project inside the VM. */
	typecheckProject(options?: ProjectCompilerOptions): Promise<TypeCheckResult>;
	/** Compile a `tsconfig.json` project, emitting into the VM filesystem. */
	compileProject(
		options?: ProjectCompilerOptions,
	): Promise<ProjectCompileResult>;
	/** Type-check a single TypeScript source string inside the VM. */
	typecheckSource(options: SourceCompilerOptions): Promise<TypeCheckResult>;
	/** Compile a single TypeScript source string, returning the emitted JS. */
	compileSource(options: SourceCompilerOptions): Promise<SourceCompileResult>;
}

const DEFAULT_COMPILER_GUEST_DIR = "/root/node_modules/typescript";

type CompilerRequest =
	| { kind: "typecheckProject"; options: ProjectCompilerOptions }
	| { kind: "compileProject"; options: ProjectCompilerOptions }
	| { kind: "typecheckSource"; options: SourceCompilerOptions }
	| { kind: "compileSource"; options: SourceCompilerOptions };

type CompilerResponse =
	| TypeCheckResult
	| ProjectCompileResult
	| SourceCompileResult;

function resolveCompilerPackageDir(explicit?: string): string {
	if (explicit) {
		return explicit;
	}
	const require = createRequire(import.meta.url);
	// `lib/typescript.js` is the full compiler bundle; its grandparent is the
	// `typescript` package directory (containing package.json + lib/).
	return dirname(dirname(require.resolve("typescript/lib/typescript.js")));
}

/**
 * Create a set of TypeScript tools whose compiler runs entirely inside the
 * secure-exec sandbox. The compiler bundle is read from the host and projected
 * into the VM filesystem; all compilation happens in-guest.
 */
export function createTypeScriptTools(
	options: TypeScriptToolsOptions = {},
): TypeScriptTools {
	const compilerPackageDir = resolveCompilerPackageDir(
		options.compilerPackageDir,
	);
	const compilerGuestDir =
		options.compilerGuestDir ?? DEFAULT_COMPILER_GUEST_DIR;
	const compilerGuestPath = `${compilerGuestDir}/lib/typescript.js`;
	const compilerMount: HostDirectoryMount = {
		guestPath: compilerGuestDir,
		hostPath: compilerPackageDir,
		readOnly: true,
	};

	const run = <T extends CompilerResponse>(
		request: CompilerRequest,
	): Promise<T> =>
		runCompilerRequest<T>(request, compilerGuestPath, options, compilerMount);

	return {
		typecheckProject: (requestOptions = {}) =>
			run<TypeCheckResult>({
				kind: "typecheckProject",
				options: requestOptions,
			}),
		compileProject: (requestOptions = {}) =>
			run<ProjectCompileResult>({
				kind: "compileProject",
				options: requestOptions,
			}),
		typecheckSource: (requestOptions) =>
			run<TypeCheckResult>({ kind: "typecheckSource", options: requestOptions }),
		compileSource: (requestOptions) =>
			run<SourceCompileResult>({
				kind: "compileSource",
				options: requestOptions,
			}),
	};
}

async function runCompilerRequest<T extends CompilerResponse>(
	request: CompilerRequest,
	compilerGuestPath: string,
	toolsOptions: TypeScriptToolsOptions,
	compilerMount: HostDirectoryMount,
): Promise<T> {
	const createOptions: NodeRuntimeCreateOptions = {
		files: toolsOptions.files,
		mounts: [compilerMount, ...(toolsOptions.mounts ?? [])],
		permissions: toolsOptions.permissions,
		env: toolsOptions.env,
	};

	const rt = await NodeRuntime.create(createOptions);
	try {
		const guestSource = buildCompilerGuestSource(request, compilerGuestPath);
		const result = await rt.run<T>(guestSource);
		if (result.exitCode === 0 && result.value !== undefined) {
			return result.value;
		}
		return createFailureResult<T>(
			request.kind,
			result.stderr.trim() || `compiler exited with code ${result.exitCode}`,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return createFailureResult<T>(request.kind, message);
	} finally {
		await rt.dispose();
	}
}

function createFailureResult<T extends CompilerResponse>(
	kind: CompilerRequest["kind"],
	errorMessage: string,
): T {
	const diagnostic: TypeScriptDiagnostic = {
		code: 0,
		category: "error",
		message: errorMessage || "TypeScript compiler failed",
	};
	if (kind === "compileProject") {
		return {
			success: false,
			diagnostics: [diagnostic],
			emitSkipped: true,
			emittedFiles: [],
		} as unknown as T;
	}
	return { success: false, diagnostics: [diagnostic] } as unknown as T;
}

/**
 * Build the guest ES module that loads the projected compiler and runs the
 * requested compile/type-check entirely inside the VM, then hands the result
 * back to the host via `__return`.
 */
function buildCompilerGuestSource(
	request: CompilerRequest,
	compilerGuestPath: string,
): string {
	return [
		`import { createRequire } from "node:module";`,
		`import fs from "node:fs";`,
		`import path from "node:path";`,
		`const require = createRequire(${JSON.stringify(compilerGuestPath)});`,
		`const ts = require(${JSON.stringify(compilerGuestPath)});`,
		`const request = ${JSON.stringify(request)};`,
		`const result = (${compilerGuestMain.toString()})(ts, fs, path, request);`,
		`globalThis.__return(result);`,
	].join("\n");
}

// NOTE: This function is serialized with `.toString()` and executed INSIDE the
// VM. It must be self-contained: it may only reference its parameters and the
// in-guest globals. Do not capture host-side variables.
function compilerGuestMain(
	ts: typeof import("typescript"),
	fs: typeof import("node:fs"),
	path: typeof import("node:path"),
	request: CompilerRequest,
): CompilerResponse {
	function toDiagnostic(
		diagnostic: import("typescript").Diagnostic,
	): TypeScriptDiagnostic {
		const message = ts
			.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
			.trim();
		const result: TypeScriptDiagnostic = {
			code: diagnostic.code,
			category: toDiagnosticCategory(diagnostic.category),
			message,
		};
		if (!diagnostic.file || diagnostic.start === undefined) {
			return result;
		}
		const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(
			diagnostic.start,
		);
		result.filePath = diagnostic.file.fileName.replace(/\\/g, "/");
		result.line = line + 1;
		result.column = character + 1;
		return result;
	}

	function toDiagnosticCategory(
		category: import("typescript").DiagnosticCategory,
	): TypeScriptDiagnostic["category"] {
		switch (category) {
			case ts.DiagnosticCategory.Warning:
				return "warning";
			case ts.DiagnosticCategory.Suggestion:
				return "suggestion";
			case ts.DiagnosticCategory.Message:
				return "message";
			default:
				return "error";
		}
	}

	function hasErrors(diagnostics: TypeScriptDiagnostic[]): boolean {
		return diagnostics.some((diagnostic) => diagnostic.category === "error");
	}

	function convertCompilerOptions(
		compilerOptions: Record<string, unknown> | undefined,
		basePath: string,
	): import("typescript").CompilerOptions {
		if (!compilerOptions) {
			return {};
		}
		const converted = ts.convertCompilerOptionsFromJson(
			compilerOptions,
			basePath,
		);
		if (converted.errors.length > 0) {
			throw new Error(
				converted.errors
					.map((diagnostic) => toDiagnostic(diagnostic).message)
					.join("\n"),
			);
		}
		return converted.options;
	}

	function resolveProjectConfig(
		options: ProjectCompilerOptions,
		overrideCompilerOptions: import("typescript").CompilerOptions = {},
	) {
		const cwd = path.resolve(options.cwd ?? "/root");
		const configFilePath = options.configFilePath
			? path.resolve(cwd, options.configFilePath)
			: ts.findConfigFile(cwd, ts.sys.fileExists, "tsconfig.json");
		if (!configFilePath) {
			throw new Error(`Unable to find tsconfig.json from '${cwd}'`);
		}
		const configFile = ts.readConfigFile(configFilePath, ts.sys.readFile);
		if (configFile.error) {
			return { parsed: null, diagnostics: [toDiagnostic(configFile.error)] };
		}
		const parsed = ts.parseJsonConfigFileContent(
			configFile.config,
			ts.sys,
			path.dirname(configFilePath),
			overrideCompilerOptions,
			configFilePath,
		);
		return { parsed, diagnostics: parsed.errors.map(toDiagnostic) };
	}

	function createSourceProgram(
		options: SourceCompilerOptions,
		overrideCompilerOptions: import("typescript").CompilerOptions = {},
	) {
		const cwd = path.resolve(options.cwd ?? "/root");
		const filePath = path.resolve(
			cwd,
			options.filePath ?? "__secure_exec_typescript_input__.ts",
		);
		const projectCompilerOptions = options.configFilePath
			? resolveProjectConfig(
					{ cwd, configFilePath: options.configFilePath },
					overrideCompilerOptions,
				)
			: { parsed: null, diagnostics: [] as TypeScriptDiagnostic[] };
		if (projectCompilerOptions.diagnostics.length > 0) {
			return {
				filePath,
				program: null,
				diagnostics: projectCompilerOptions.diagnostics,
			};
		}
		const compilerOptions = {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.ESNext,
			...projectCompilerOptions.parsed?.options,
			...convertCompilerOptions(options.compilerOptions, cwd),
			...overrideCompilerOptions,
		};
		const host = ts.createCompilerHost(compilerOptions);
		const normalize = (candidate: string) =>
			ts.sys.useCaseSensitiveFileNames ? candidate : candidate.toLowerCase();
		const normalizedFilePath = normalize(filePath);
		const defaultGetSourceFile = host.getSourceFile.bind(host);
		const defaultReadFile = host.readFile.bind(host);
		const defaultFileExists = host.fileExists.bind(host);

		host.fileExists = (candidate) =>
			normalize(candidate) === normalizedFilePath ||
			defaultFileExists(candidate);
		host.readFile = (candidate) =>
			normalize(candidate) === normalizedFilePath
				? options.sourceText
				: defaultReadFile(candidate);
		host.getSourceFile = (candidate, languageVersion, onError, shouldCreate) =>
			normalize(candidate) === normalizedFilePath
				? ts.createSourceFile(candidate, options.sourceText, languageVersion, true)
				: defaultGetSourceFile(candidate, languageVersion, onError, shouldCreate);

		return {
			filePath,
			program: ts.createProgram([filePath], compilerOptions, host),
			diagnostics: [] as TypeScriptDiagnostic[],
		};
	}

	switch (request.kind) {
		case "typecheckProject": {
			const { parsed, diagnostics } = resolveProjectConfig(request.options, {
				noEmit: true,
			});
			if (!parsed) {
				return { success: false, diagnostics };
			}
			const program = ts.createProgram({
				rootNames: parsed.fileNames,
				options: parsed.options,
				projectReferences: parsed.projectReferences,
			});
			const combined = ts
				.sortAndDeduplicateDiagnostics([
					...parsed.errors,
					...ts.getPreEmitDiagnostics(program),
				])
				.map(toDiagnostic);
			return { success: !hasErrors(combined), diagnostics: combined };
		}
		case "compileProject": {
			const { parsed, diagnostics } = resolveProjectConfig(request.options);
			if (!parsed) {
				return {
					success: false,
					diagnostics,
					emitSkipped: true,
					emittedFiles: [],
				};
			}
			const program = ts.createProgram({
				rootNames: parsed.fileNames,
				options: parsed.options,
				projectReferences: parsed.projectReferences,
			});
			const emittedFiles: string[] = [];
			const emitResult = program.emit(undefined, (fileName, text) => {
				fs.mkdirSync(path.dirname(fileName), { recursive: true });
				fs.writeFileSync(fileName, text, "utf8");
				emittedFiles.push(fileName.replace(/\\/g, "/"));
			});
			const combined = ts
				.sortAndDeduplicateDiagnostics([
					...parsed.errors,
					...ts.getPreEmitDiagnostics(program),
					...emitResult.diagnostics,
				])
				.map(toDiagnostic);
			return {
				success: !hasErrors(combined),
				diagnostics: combined,
				emitSkipped: emitResult.emitSkipped,
				emittedFiles,
			};
		}
		case "typecheckSource": {
			const { program, diagnostics } = createSourceProgram(request.options, {
				noEmit: true,
			});
			if (!program) {
				return { success: false, diagnostics };
			}
			const combined = ts
				.sortAndDeduplicateDiagnostics(ts.getPreEmitDiagnostics(program))
				.map(toDiagnostic);
			return { success: !hasErrors(combined), diagnostics: combined };
		}
		case "compileSource": {
			const { program, diagnostics } = createSourceProgram(request.options);
			if (!program) {
				return { success: false, diagnostics };
			}
			let outputText: string | undefined;
			let sourceMapText: string | undefined;
			const emitResult = program.emit(undefined, (fileName, text) => {
				if (
					fileName.endsWith(".js") ||
					fileName.endsWith(".mjs") ||
					fileName.endsWith(".cjs")
				) {
					outputText = text;
				} else if (fileName.endsWith(".map")) {
					sourceMapText = text;
				}
			});
			const combined = ts
				.sortAndDeduplicateDiagnostics([
					...ts.getPreEmitDiagnostics(program),
					...emitResult.diagnostics,
				])
				.map(toDiagnostic);
			return {
				success: !hasErrors(combined),
				diagnostics: combined,
				outputText,
				sourceMapText,
			};
		}
	}
}

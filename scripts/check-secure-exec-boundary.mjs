import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const agentOsPackagePattern = /^@rivet-dev\/agent-os(?:-|$)/;
const dependencySections = [
	'dependencies',
	'devDependencies',
	'peerDependencies',
	'optionalDependencies',
];
const ignoredDirectories = new Set([
	'.git',
	'.jj',
	'.turbo',
	'coverage',
	'dist',
	'node_modules',
	'target',
]);
const sourceExtensions = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const importSpecifierPatterns = [
	/\bimport\s+(?:type\s+)?(?:[^\"'()]*?\s+from\s+)?[\"']([^\"']+)[\"']/g,
	/\bexport\s+(?:type\s+)?[^\"'()]*?\s+from\s+[\"']([^\"']+)[\"']/g,
	/\bimport\s*\(\s*[\"']([^\"']+)[\"']\s*\)/g,
	/\brequire\s*\(\s*[\"']([^\"']+)[\"']\s*\)/g,
];
const forbiddenCargoPatterns = [
	[/\bagent-os-protocol\b/g, 'agent-os-protocol'],
	[/\bagent-os-client\b/g, 'agent-os-client'],
	[/\bagent-os-sidecar\b/g, 'agent-os-sidecar'],
];
const forbiddenRustPatterns = [
	[/\bagent_os_protocol\b/g, 'agent_os_protocol'],
	[/\bagent_os_client\b/g, 'agent_os_client'],
	[/\bagent_os_sidecar\b/g, 'agent_os_sidecar'],
];

function parseArgs(argv) {
	const options = { root: defaultRoot };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--root') {
			options.root = argv[++i];
			continue;
		}
		if (arg.startsWith('--root=')) {
			options.root = arg.slice('--root='.length);
			continue;
		}
		throw new Error(`unknown argument: ${arg}`);
	}
	return { root: resolve(options.root) };
}

function readJson(path) {
	return JSON.parse(readFileSync(path, 'utf8'));
}

function shouldSkipFile(relPath) {
	return relPath === 'scripts/check-secure-exec-boundary.mjs' ||
		relPath === 'scripts/check-secure-exec-boundary.test.mjs';
}

function collectImportSpecifiers(source) {
	const specifiers = [];
	for (const pattern of importSpecifierPatterns) {
		pattern.lastIndex = 0;
		let match;
		while ((match = pattern.exec(source))) {
			specifiers.push(match[1]);
		}
	}
	return specifiers;
}

function checkPackageManifest(root, relPath, violations) {
	const manifest = readJson(join(root, relPath));
	for (const section of dependencySections) {
		const dependencies = manifest[section];
		if (!dependencies || typeof dependencies !== 'object') continue;
		for (const name of Object.keys(dependencies)) {
			if (agentOsPackagePattern.test(name)) {
				violations.push(`${relPath} ${section} references ${name}`);
			}
		}
	}
}

function checkSourceFile(root, relPath, violations) {
	const source = readFileSync(join(root, relPath), 'utf8');
	for (const specifier of collectImportSpecifiers(source)) {
		if (agentOsPackagePattern.test(specifier)) {
			violations.push(`${relPath} imports ${specifier}`);
		}
	}
}

function checkPatternFile(root, relPath, patterns, violations) {
	const source = readFileSync(join(root, relPath), 'utf8');
	for (const [pattern, label] of patterns) {
		pattern.lastIndex = 0;
		if (pattern.test(source)) {
			violations.push(`${relPath} references ${label}`);
		}
	}
}

function walk(root, dir, violations) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
		const path = join(dir, entry.name);
		const relPath = relative(root, path);
		if (entry.isDirectory()) {
			walk(root, path, violations);
			continue;
		}
		if (!entry.isFile() || shouldSkipFile(relPath)) continue;
		if (entry.name === 'package.json') {
			checkPackageManifest(root, relPath, violations);
			continue;
		}
		if (entry.name === 'Cargo.toml') {
			checkPatternFile(root, relPath, forbiddenCargoPatterns, violations);
			continue;
		}
		if (entry.name.endsWith('.rs')) {
			checkPatternFile(root, relPath, forbiddenRustPatterns, violations);
			continue;
		}
		if (sourceExtensions.has(extname(entry.name))) {
			checkSourceFile(root, relPath, violations);
		}
	}
}

export function auditSecureExecBoundary(options = {}) {
	const root = resolve(options.root ?? defaultRoot);
	const violations = [];
	if (!existsSync(root)) {
		return { root, ok: false, violations: [`${root} does not exist`] };
	}
	walk(root, root, violations);
	violations.sort();
	return { root, ok: violations.length === 0, violations };
}

export function main(argv = process.argv.slice(2)) {
	const options = parseArgs(argv);
	const result = auditSecureExecBoundary(options);
	if (result.ok) {
		console.log('secure-exec boundary ok');
		return 0;
	}
	console.error('secure-exec boundary violations:');
	for (const violation of result.violations) {
		console.error(`- ${violation}`);
	}
	return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	process.exitCode = main();
}

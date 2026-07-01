#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const fixturePath = path.join(
	repoRoot,
	"tests",
	"fixtures",
	"module-resolution-conformance.json",
);
const nativeTestPath = path.join(
	repoRoot,
	"crates",
	"execution",
	"tests",
	"module_resolution.rs",
);
const browserTestPath = path.join(
	repoRoot,
	"packages",
	"browser",
	"tests",
	"runtime",
	"resolve-module.test.ts",
);

const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const nativeTest = fs.readFileSync(nativeTestPath, "utf8");
const browserTest = fs.readFileSync(browserTestPath, "utf8");

const errors = [];

function assert(condition, message) {
	if (!condition) errors.push(message);
}

function assertFixturePath(source, label) {
	assert(
		source.includes("module-resolution-conformance.json"),
		`${label} must load tests/fixtures/module-resolution-conformance.json`,
	);
}

function assertSourceMentions(source, label, tokens) {
	for (const token of tokens) {
		assert(source.includes(token), `${label} must exercise shared fixture token ${token}`);
	}
}

assert(Array.isArray(fixture.cases), "fixture must define cases");
assert(fixture.cases?.length > 0, "fixture must contain at least one case");
assert(Array.isArray(fixture.formats), "fixture must define formats");
assert(fixture.formats?.length > 0, "fixture must contain at least one format case");

const expectations = [];
const formatExpectations = [];
for (const [caseIndex, testCase] of (fixture.cases ?? []).entries()) {
	assert(typeof testCase.name === "string" && testCase.name.length > 0, `case ${caseIndex} must define name`);
	assert(testCase.files && typeof testCase.files === "object" && !Array.isArray(testCase.files), `${testCase.name} must define files`);
	assert(Array.isArray(testCase.resolves) && testCase.resolves.length > 0, `${testCase.name} must define resolves`);

	for (const [filePath, contents] of Object.entries(testCase.files ?? {})) {
		assert(typeof filePath === "string" && filePath.length > 0, `${testCase.name} has an empty fixture file path`);
		assert(typeof contents === "string", `${testCase.name}:${filePath} contents must be a string`);
	}

	for (const [resolutionIndex, resolution] of (testCase.resolves ?? []).entries()) {
		assert(typeof resolution.specifier === "string" && resolution.specifier.length > 0, `${testCase.name} resolution ${resolutionIndex} must define specifier`);
		assert(typeof resolution.from === "string" && resolution.from.length > 0, `${testCase.name} resolution ${resolutionIndex} must define from`);
		assert(["import", "require"].includes(resolution.mode), `${testCase.name} resolution ${resolutionIndex} mode must be import or require`);
		assert(
			typeof resolution.expected === "string" || resolution.expected === null,
			`${testCase.name} resolution ${resolutionIndex} expected must be a string or null`,
		);
		expectations.push(resolution);
	}
}

for (const [caseIndex, testCase] of (fixture.formats ?? []).entries()) {
	assert(typeof testCase.name === "string" && testCase.name.length > 0, `format case ${caseIndex} must define name`);
	assert(testCase.files && typeof testCase.files === "object" && !Array.isArray(testCase.files), `${testCase.name} must define files`);
	assert(typeof testCase.path === "string" && testCase.path.length > 0, `${testCase.name} must define path`);
	assert(
		["module", "commonjs", "json", null].includes(testCase.expected),
		`${testCase.name} expected must be module, commonjs, json, or null`,
	);

	for (const [filePath, contents] of Object.entries(testCase.files ?? {})) {
		assert(typeof filePath === "string" && filePath.length > 0, `${testCase.name} has an empty fixture file path`);
		assert(typeof contents === "string", `${testCase.name}:${filePath} contents must be a string`);
	}

	formatExpectations.push(testCase);
}

function hasExpectation(match) {
	return expectations.some(
		(resolution) =>
			resolution.specifier === match.specifier &&
			resolution.from === match.from &&
			resolution.mode === match.mode &&
			resolution.expected === match.expected,
	);
}

function hasFormatExpectation(match) {
	return formatExpectations.some(
		(format) =>
			format.path === match.path &&
			format.expected === match.expected,
	);
}

for (const required of [
	{
		label: "file URL parsing",
		specifier: "file:///root/project/space%20name.js?cache=1",
		from: "/root/project/app.js",
		mode: "require",
		expected: "/root/project/space name.js",
	},
	{
		label: "package imports",
		specifier: "#utils/math",
		from: "/root/project/src/app.js",
		mode: "import",
		expected: "/root/project/src/utils/math.js",
	},
	{
		label: "native node condition order",
		specifier: "pkg",
		from: "/root/project/app.js",
		mode: "import",
		expected: "/root/node_modules/pkg/node.js",
	},
	{
		label: "missing package export target",
		specifier: "missing-export",
		from: "/root/project/app.js",
		mode: "import",
		expected: "/root/node_modules/missing-export/dist/missing.js",
	},
	{
		label: "extension probing",
		specifier: "./dual",
		from: "/root/project/src/app.js",
		mode: "import",
		expected: "/root/project/src/dual.js",
	},
	{
		label: "package self-reference exports",
		specifier: "self-pkg/feature",
		from: "/root/project/src/app.js",
		mode: "import",
		expected: "/root/project/src/feature.mjs",
	},
	{
		label: "root node_modules fallback",
		specifier: "root-fallback",
		from: "/workspace/app.js",
		mode: "require",
		expected: "/root/node_modules/root-fallback/index.js",
	},
]) {
	assert(hasExpectation(required), `fixture must include shared case for ${required.label}`);
}

for (const required of [
	{
		label: "ESM extension format",
		path: "/root/project/src/module.mjs",
		expected: "module",
	},
	{
		label: "CJS extension format",
		path: "/root/project/src/module.cjs",
		expected: "commonjs",
	},
	{
		label: "nearest module package type",
		path: "/root/project/src/app.js",
		expected: "module",
	},
	{
		label: "nearest commonjs package type",
		path: "/root/project/src/cjs/app.js",
		expected: "commonjs",
	},
	{
		label: "unknown extension format",
		path: "/root/project/src/readme.txt",
		expected: null,
	},
]) {
	assert(hasFormatExpectation(required), `fixture must include shared format case for ${required.label}`);
}

assertFixturePath(nativeTest, "native module resolution test");
assertFixturePath(browserTest, "browser module resolution test");
assertSourceMentions(nativeTest, "native module resolution test", [
	"matches_shared_native_browser_conformance_fixture",
	"SharedModuleResolutionFixture",
	"resolve_import",
	"resolve_require",
	"module_format",
]);
assertSourceMentions(browserTest, "browser module resolution test", [
	"matches the shared native/browser conformance fixture",
	"ModuleResolutionConformanceFixture",
	"resolveModule",
	"moduleFormat",
]);

if (errors.length > 0) {
	console.error("Module resolution conformance fixture drift detected:");
	for (const error of errors) {
		console.error(`  - ${error}`);
	}
	process.exit(1);
}

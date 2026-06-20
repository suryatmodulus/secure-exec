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
	"crypto-basic-conformance.json",
);
const browserTestPath = path.join(
	repoRoot,
	"packages",
	"browser",
	"tests",
	"browser",
	"runtime-driver.spec.ts",
);
const nativeBuiltinTestPath = path.join(
	repoRoot,
	"crates",
	"sidecar",
	"tests",
	"builtin_conformance.rs",
);
const nativeServiceTestPath = path.join(
	repoRoot,
	"crates",
	"sidecar",
	"tests",
	"service.rs",
);

const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const browserTest = fs.readFileSync(browserTestPath, "utf8");
const nativeBuiltinTest = fs.readFileSync(nativeBuiltinTestPath, "utf8");
const nativeServiceTest = fs.readFileSync(nativeServiceTestPath, "utf8");

const errors = [];

function assert(condition, message) {
	if (!condition) errors.push(message);
}

function assertFixturePath(source, label) {
	assert(
		source.includes("crypto-basic-conformance.json"),
		`${label} must load tests/fixtures/crypto-basic-conformance.json`,
	);
}

function assertSourceMentions(source, label, tokens) {
	for (const token of tokens) {
		assert(source.includes(token), `${label} must assert shared crypto vector ${token}`);
	}
}

assert(Array.isArray(fixture.expected?.hashes), "fixture must list expected.hashes");
assert(Array.isArray(fixture.expected?.ciphers), "fixture must list expected.ciphers");
assert(Array.isArray(fixture.expected?.curves), "fixture must list expected.curves");
assert(typeof fixture.expected?.primes === "object", "fixture must define expected.primes");

for (const field of [
	"md5",
	"sha224",
	"sha256",
	"sha384",
	"hmacSha256",
	"hmacSha384",
	"pbkdf2Sha256",
	"pbkdf2Sha384",
	"scrypt",
	"aes256CbcCiphertext",
	"aes256GcmCiphertext",
	"aes256GcmAuthTag",
	"aes256GcmWebCryptoCiphertext",
]) {
	assert(
		typeof fixture.expected?.[field] === "string",
		`fixture must define expected.${field}`,
	);
}

for (const field of ["algorithm", "plaintext", "aad", "keyHex", "ivHex"]) {
	assert(typeof fixture.aesGcm?.[field] === "string", `fixture must define aesGcm.${field}`);
}
assert(
	typeof fixture.aesGcm?.authTagLength === "number",
	"fixture must define aesGcm.authTagLength",
);

for (const [section, fields] of Object.entries({
	aesCbc: ["algorithm", "plaintext", "keyHex", "ivHex"],
	rsa: ["message", "privatePem", "publicPem", "sha256SignatureHex"],
	dh: ["primeHex", "generatorHex", "privateAHex", "privateBHex", "publicAHex", "publicBHex", "secretHex"],
	ecdh: ["curve", "privateAHex", "privateBHex", "publicAHex", "publicBHex", "secretHex"],
	"expected.primes": ["bits", "safeBits", "bufferBits", "bufferByteLength"],
})) {
	for (const field of fields) {
		const source = section === "expected.primes" ? fixture.expected?.primes : fixture[section];
		assert(
			typeof source?.[field] === (section === "expected.primes" ? "number" : "string"),
			`fixture must define ${section}.${field}`,
		);
	}
}

assertFixturePath(browserTest, "browser runtime crypto test");
assertFixturePath(nativeBuiltinTest, "native builtin crypto conformance test");
assertFixturePath(nativeServiceTest, "native crypto sync-RPC test");

assertSourceMentions(browserTest, "browser runtime crypto test", [
	"cryptoBasicFixture.expected.hashes",
	"cryptoBasicFixture.expected.ciphers",
	"cryptoBasicFixture.expected.curves",
	"cryptoBasicFixture.expected.md5",
	"cryptoBasicFixture.expected.sha224",
	"cryptoBasicFixture.expected.sha256",
	"cryptoBasicFixture.expected.sha384",
	"cryptoBasicFixture.expected.hmacSha256",
	"cryptoBasicFixture.expected.hmacSha384",
	"cryptoBasicFixture.expected.pbkdf2Sha256",
	"cryptoBasicFixture.expected.pbkdf2Sha384",
	"cryptoBasicFixture.expected.scrypt",
	"cryptoBasicFixture.expected.aes256CbcCiphertext",
	"cryptoBasicFixture.expected.aes256GcmCiphertext",
	"cryptoBasicFixture.expected.aes256GcmAuthTag",
	"cryptoBasicFixture.expected.aes256GcmWebCryptoCiphertext",
	"cryptoBasicFixture.expected.primes.bits",
	"cryptoBasicFixture.expected.primes.safeBits",
	"cryptoBasicFixture.expected.primes.bufferBits",
	"cryptoBasicFixture.expected.primes.bufferByteLength",
	"cryptoBasicFixture.rsa.sha256SignatureHex",
	"cryptoBasicFixture.dh.secretHex",
	"cryptoBasicFixture.ecdh.secretHex",
]);

assertSourceMentions(nativeServiceTest, "native crypto sync-RPC test", [
	"fixture.expected.md5",
	"fixture.expected.sha224",
	"fixture.expected.sha256",
	"fixture.expected.sha384",
	"fixture.expected.hmac_sha256",
	"fixture.expected.hmac_sha384",
	"fixture.expected.pbkdf2_sha256",
	"fixture.expected.pbkdf2_sha384",
	"fixture.expected.scrypt",
	"fixture.expected.aes256_cbc_ciphertext",
	"fixture.expected.aes256_gcm_ciphertext",
	"fixture.expected.aes256_gcm_auth_tag",
	"fixture.expected.aes256_gcm_web_crypto_ciphertext",
	"fixture.expected.primes.bits",
	"fixture.expected.primes.safe_bits",
	"fixture.expected.primes.buffer_bits",
	"fixture.expected.primes.buffer_byte_length",
]);

assertSourceMentions(nativeBuiltinTest, "native builtin crypto conformance test", [
	"fixture[\"rsa\"][\"sha256SignatureHex\"]",
	"fixture[\"dh\"][\"secretHex\"]",
	"fixture[\"ecdh\"][\"secretHex\"]",
	"expected[\"primes\"][\"bits\"]",
	"expected[\"primes\"][\"safeBits\"]",
	"expected[\"primes\"][\"bufferBits\"]",
	"expected[\"primes\"][\"bufferByteLength\"]",
	"expected[\"aes256GcmCiphertext\"]",
	"expected[\"aes256GcmAuthTag\"]",
	"expected[\"aes256GcmWebCryptoCiphertext\"]",
	"expected[\"hashes\"]",
	"expected[\"ciphers\"]",
	"expected[\"curves\"]",
]);

if (errors.length > 0) {
	console.error("Crypto conformance fixture drift detected:");
	for (const error of errors) {
		console.error(`  - ${error}`);
	}
	process.exit(1);
}

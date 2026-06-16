import { describe, expect, test } from "vitest";
import {
	encodeLengthPrefixedPayload,
	LENGTH_PREFIX_BYTES,
	tryDecodeLengthPrefixedPayload,
} from "../src/framing.js";

describe("length-prefixed framing", () => {
	test("encodes payload length as a four-byte big-endian prefix", () => {
		const encoded = encodeLengthPrefixedPayload(Uint8Array.from([1, 2, 3]));

		expect(encoded.readUInt32BE(0)).toBe(3);
		expect([...encoded.subarray(LENGTH_PREFIX_BYTES)]).toEqual([1, 2, 3]);
	});

	test("waits for complete prefixes and payloads", () => {
		expect(tryDecodeLengthPrefixedPayload(Uint8Array.from([0, 0]))).toBeNull();

		const encoded = encodeLengthPrefixedPayload(Uint8Array.from([4, 5, 6]));
		expect(tryDecodeLengthPrefixedPayload(encoded.subarray(0, 5))).toBeNull();
	});

	test("decodes one payload and returns remaining bytes", () => {
		const first = encodeLengthPrefixedPayload(Uint8Array.from([7, 8]));
		const second = encodeLengthPrefixedPayload(Uint8Array.from([9]));
		const decoded = tryDecodeLengthPrefixedPayload(
			Buffer.concat([first, second]),
		);

		expect(decoded).not.toBeNull();
		expect([...(decoded?.payload ?? [])]).toEqual([7, 8]);
		expect(Buffer.from(decoded?.remaining ?? []).equals(second)).toBe(true);
	});
});

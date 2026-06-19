import { describe, expect, test } from "vitest";
import {
	decodeJsonFramePayload,
	encodeJsonFramePayload,
} from "../src/frame-payload-codec.js";

describe("frame payload codec helpers", () => {
	test("encodes Uint8Array values as number arrays for JSON frames", () => {
		const encoded = encodeJsonFramePayload({
			payload: {
				type: "process_output",
				chunk: new Uint8Array([1, 2, 3]),
			},
		});

		expect(JSON.parse(encoded.toString("utf8"))).toEqual({
			payload: {
				type: "process_output",
				chunk: [1, 2, 3],
			},
		});
	});

	test("restores process output chunks to Uint8Array", () => {
		const decoded = decodeJsonFramePayload<{
			payload: { type: "process_output"; chunk: Uint8Array };
		}>(
			Buffer.from(
				JSON.stringify({
					payload: {
						type: "process_output",
						chunk: [4, 5, 6],
					},
				}),
				"utf8",
			),
		);

		expect(decoded.payload.chunk).toBeInstanceOf(Uint8Array);
		expect(Array.from(decoded.payload.chunk)).toEqual([4, 5, 6]);
	});
});

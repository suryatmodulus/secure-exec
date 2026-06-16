export type TransportPayloadCodec = "bare" | "json";

export function encodeJsonFramePayload(frame: unknown): Buffer {
	// BARE `data` fields are Uint8Array; JSON.stringify renders those as objects, so encode them
	// as number arrays to match serde_json's Vec<u8> representation on the Rust side.
	return Buffer.from(
		JSON.stringify(frame, (_key, value) =>
			value instanceof Uint8Array ? Array.from(value) : value,
		),
		"utf8",
	);
}

export function decodeJsonFramePayload<
	TFrame extends { payload?: { type?: string; chunk?: unknown } },
>(payload: Uint8Array): TFrame {
	const frame = JSON.parse(Buffer.from(payload).toString("utf8")) as TFrame;
	const decodedPayload = frame.payload;
	if (
		decodedPayload?.type === "process_output" &&
		Array.isArray(decodedPayload.chunk)
	) {
		decodedPayload.chunk = Uint8Array.from(decodedPayload.chunk as number[]);
	}
	return frame;
}

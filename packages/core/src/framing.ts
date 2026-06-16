export const LENGTH_PREFIX_BYTES = 4;

export interface LengthPrefixedPayload {
	payload: Buffer;
	remaining: Buffer;
}

export function encodeLengthPrefixedPayload(payload: Uint8Array): Buffer {
	const encoded = Buffer.allocUnsafe(LENGTH_PREFIX_BYTES + payload.length);
	encoded.writeUInt32BE(payload.length, 0);
	encoded.set(payload, LENGTH_PREFIX_BYTES);
	return encoded;
}

export function tryDecodeLengthPrefixedPayload(
	buffer: Uint8Array,
): LengthPrefixedPayload | null {
	const source = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
	if (source.length < LENGTH_PREFIX_BYTES) {
		return null;
	}

	const declaredLength = source.readUInt32BE(0);
	const frameEnd = LENGTH_PREFIX_BYTES + declaredLength;
	if (source.length < frameEnd) {
		return null;
	}

	return {
		payload: source.subarray(LENGTH_PREFIX_BYTES, frameEnd),
		remaining: source.subarray(frameEnd),
	};
}

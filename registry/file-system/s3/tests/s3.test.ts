import { describe, expect, it } from "vitest";
import { createS3Backend } from "../src/index.js";

describe("@secure-exec/s3", () => {
	it("serializes a native s3 mount descriptor", () => {
		expect(
			createS3Backend({
				bucket: "bucket-123",
				metadataPath: "/tmp/secure-exec-s3.sqlite",
				prefix: "descriptor-test",
				region: "us-east-1",
				endpoint: "https://s3.example.com",
				credentials: {
					accessKeyId: "access-key-id",
					secretAccessKey: "secret-access-key",
				},
				chunkSize: 16,
				inlineThreshold: 8,
			}),
		).toEqual({
			id: "chunked_s3",
			config: {
				bucket: "bucket-123",
				metadataPath: "/tmp/secure-exec-s3.sqlite",
				prefix: "descriptor-test",
				region: "us-east-1",
				endpoint: "https://s3.example.com",
				credentials: {
					accessKeyId: "access-key-id",
					secretAccessKey: "secret-access-key",
				},
				chunkSize: 16,
				inlineThreshold: 8,
			},
		});
	});
});

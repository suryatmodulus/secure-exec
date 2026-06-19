import { describe, expect, it } from "vitest";
import * as protocol from "../src/generated-protocol.js";
import { fromGeneratedResponsePayload } from "../src/response-payloads.js";

describe("response payload conversion", () => {
	it("maps simple generated responses to live payloads", () => {
		expect(
			fromGeneratedResponsePayload({
				tag: "AuthenticatedResponse",
				val: {
					sidecarId: "sidecar",
					connectionId: "conn",
					maxFrameBytes: 1024,
				},
			}),
		).toEqual({
			type: "authenticated",
			sidecar_id: "sidecar",
			connection_id: "conn",
			max_frame_bytes: 1024,
		});

		expect(
			fromGeneratedResponsePayload({
				tag: "RejectedResponse",
				val: { code: "bad_request", message: "nope" },
			}),
		).toEqual({
			type: "rejected",
			code: "bad_request",
			message: "nope",
		});
	});

	it("maps guest filesystem result details", () => {
		expect(
			fromGeneratedResponsePayload({
				tag: "GuestFilesystemResultResponse",
				val: {
					operation: protocol.GuestFilesystemOperation.ReadFile,
					path: "/tmp/file",
					content: "hello",
					encoding: protocol.RootFilesystemEntryEncoding.UtF8,
					entries: null,
					stat: null,
					exists: true,
					target: null,
				},
			}),
		).toEqual({
			type: "guest_filesystem_result",
			operation: "read_file",
			path: "/tmp/file",
			content: "hello",
			encoding: "utf8",
			exists: true,
		});
	});

	it("maps process and socket snapshots", () => {
		expect(
			fromGeneratedResponsePayload({
				tag: "ProcessSnapshotResponse",
				val: {
					processes: [
						{
							processId: "proc",
							pid: 10,
							ppid: 1,
							pgid: 10,
							sid: 10,
							driver: "native",
							command: "node",
							args: ["-e", "0"],
							cwd: "/work",
							status: protocol.ProcessSnapshotStatus.Running,
							exitCode: null,
						},
					],
				},
			}),
		).toEqual({
			type: "process_snapshot",
			processes: [
				{
					process_id: "proc",
					pid: 10,
					ppid: 1,
					pgid: 10,
					sid: 10,
					driver: "native",
					command: "node",
					args: ["-e", "0"],
					cwd: "/work",
					status: "running",
				},
			],
		});

		expect(
			fromGeneratedResponsePayload({
				tag: "ListenerSnapshotResponse",
				val: {
					listener: {
						processId: "proc",
						host: "127.0.0.1",
						port: 8080,
						path: null,
					},
				},
			}),
		).toEqual({
			type: "listener_snapshot",
			listener: {
				process_id: "proc",
				host: "127.0.0.1",
				port: 8080,
			},
		});
	});

	it("maps generated toolkit registration to host callback registration", () => {
		expect(
			fromGeneratedResponsePayload({
				tag: "HostCallbacksRegisteredResponse",
				val: { registration: "tools", commandCount: 2 },
			}),
		).toEqual({
			type: "host_callbacks_registered",
			registration: "tools",
			command_count: 2,
		});
	});

	it("maps signal handlers and bigint counts", () => {
		expect(
			fromGeneratedResponsePayload({
				tag: "SignalStateResponse",
				val: {
					processId: "proc",
					handlers: new Map([
						[
							15,
							{
								action: protocol.SignalDispositionAction.User,
								mask: new Uint32Array([2, 15]),
								flags: 4,
							},
						],
					]),
				},
			}),
		).toEqual({
			type: "signal_state",
			process_id: "proc",
			handlers: {
				"15": { action: "user", mask: [2, 15], flags: 4 },
			},
		});

		expect(
			fromGeneratedResponsePayload({
				tag: "ZombieTimerCountResponse",
				val: { count: 3n },
			}),
		).toEqual({
			type: "zombie_timer_count",
			count: 3,
		});
	});

	it("keeps unsupported legacy response tags fail-closed", () => {
		expect(() =>
			fromGeneratedResponsePayload({
				tag: "PermissionDecisionResponse",
				val: { allowed: true },
			}),
		).toThrow("unsupported bare response payload tag: permission_decision");
	});
});

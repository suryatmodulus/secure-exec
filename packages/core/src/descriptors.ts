import type * as protocol from "./generated-protocol.js";
import { stringifyJsonUtf8 } from "./json.js";

export type LiveSidecarPlacement =
	| { kind: "shared"; pool?: string | null }
	| { kind: "explicit"; sidecar_id: string };

export type MountConfigJsonPrimitive = string | number | boolean | null;
export type MountConfigJsonValue =
	| MountConfigJsonPrimitive
	| MountConfigJsonObject
	| MountConfigJsonValue[];

export interface MountConfigJsonObject {
	[key: string]: MountConfigJsonValue;
}

export interface NativeMountPluginDescriptor<
	TConfig extends MountConfigJsonObject = MountConfigJsonObject,
> {
	id: string;
	config?: TConfig;
}

export interface LiveMountDescriptor {
	guest_path: string;
	read_only: boolean;
	plugin: NativeMountPluginDescriptor;
}

export interface LiveSoftwareDescriptor {
	package_name: string;
	root: string;
}

export interface LiveProjectedModuleDescriptor {
	package_name: string;
	entrypoint: string;
}

export function toGeneratedSidecarPlacement(
	placement: LiveSidecarPlacement,
): protocol.SidecarPlacement {
	switch (placement.kind) {
		case "shared":
			return {
				tag: "SidecarPlacementShared",
				val: { pool: placement.pool ?? null },
			};
		case "explicit":
			return {
				tag: "SidecarPlacementExplicit",
				val: { sidecarId: placement.sidecar_id },
			};
	}
}

export function toGeneratedMountDescriptor(
	descriptor: LiveMountDescriptor,
): protocol.MountDescriptor {
	return {
		guestPath: descriptor.guest_path,
		readOnly: descriptor.read_only,
		plugin: {
			id: descriptor.plugin.id,
			config: stringifyJsonUtf8(
				descriptor.plugin.config ?? {},
				"mount plugin config",
			),
		},
	};
}

export function toGeneratedSoftwareDescriptor(
	descriptor: LiveSoftwareDescriptor,
): protocol.SoftwareDescriptor {
	return {
		packageName: descriptor.package_name,
		root: descriptor.root,
	};
}

export function toGeneratedProjectedModuleDescriptor(
	descriptor: LiveProjectedModuleDescriptor,
): protocol.ProjectedModuleDescriptor {
	return {
		packageName: descriptor.package_name,
		entrypoint: descriptor.entrypoint,
	};
}

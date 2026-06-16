import coreutils from "@agent-os-pkgs/coreutils";
import sed from "@agent-os-pkgs/sed";
import grep from "@agent-os-pkgs/grep";
import gawk from "@agent-os-pkgs/gawk";
import findutils from "@agent-os-pkgs/findutils";
import diffutils from "@agent-os-pkgs/diffutils";
import tar from "@agent-os-pkgs/tar";
import gzip from "@agent-os-pkgs/gzip";
import curl from "@agent-os-pkgs/curl";
import zip from "@agent-os-pkgs/zip";
import unzip from "@agent-os-pkgs/unzip";
import jq from "@agent-os-pkgs/jq";
import ripgrep from "@agent-os-pkgs/ripgrep";
import fd from "@agent-os-pkgs/fd";
import tree from "@agent-os-pkgs/tree";
import file from "@agent-os-pkgs/file";
import yq from "@agent-os-pkgs/yq";
import codex from "@agent-os-pkgs/codex";

const everything = [
	coreutils,
	sed,
	grep,
	gawk,
	findutils,
	diffutils,
	tar,
	gzip,
	curl,
	zip,
	unzip,
	jq,
	ripgrep,
	fd,
	tree,
	file,
	yq,
	codex,
];

export default everything;
export {
	coreutils,
	sed,
	grep,
	gawk,
	findutils,
	diffutils,
	tar,
	gzip,
	curl,
	zip,
	unzip,
	jq,
	ripgrep,
	fd,
	tree,
	file,
	yq,
	codex,
};

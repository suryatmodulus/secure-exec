import coreutils from "@agent-os-pkgs/coreutils";
import sed from "@agent-os-pkgs/sed";
import grep from "@agent-os-pkgs/grep";
import gawk from "@agent-os-pkgs/gawk";
import findutils from "@agent-os-pkgs/findutils";
import diffutils from "@agent-os-pkgs/diffutils";
import tar from "@agent-os-pkgs/tar";
import gzip from "@agent-os-pkgs/gzip";

const common = [coreutils, sed, grep, gawk, findutils, diffutils, tar, gzip];

export default common;
export { coreutils, sed, grep, gawk, findutils, diffutils, tar, gzip };

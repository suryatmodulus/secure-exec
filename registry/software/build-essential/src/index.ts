import common from "@agent-os-pkgs/common";
import make from "@agent-os-pkgs/make";
import git from "@agent-os-pkgs/git";
import curl from "@agent-os-pkgs/curl";

const buildEssential = [...common, make, git, curl];

export default buildEssential;
export { common, make, git, curl };

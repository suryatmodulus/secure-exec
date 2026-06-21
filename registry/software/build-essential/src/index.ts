import common from "@agentos-software/common";
import make from "@agentos-software/make";
import git from "@agentos-software/git";
import curl from "@agentos-software/curl";

const buildEssential = [...common, make, git, curl];

export default buildEssential;
export { common, make, git, curl };

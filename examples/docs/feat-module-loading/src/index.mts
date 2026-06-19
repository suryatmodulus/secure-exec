import { createRequire } from "node:module";
import { NodeRuntime } from "secure-exec";

// Boot a fully virtualized VM. Module resolution runs entirely inside the
// kernel - `import` and `require` resolve against the guest's virtual
// filesystem, never the host's.
const rt = await NodeRuntime.create();

try {
  // Guest code runs as an ES module inside the VM, so it can `import` Node
  // builtins directly. It can also build a CommonJS `require` with
  // `createRequire` to load builtins the classic way. Both resolve through the
  // kernel's module loader.
  const { stdout, stderr, exitCode } = await rt.exec(`
    // ESM import of a Node builtin.
    import { basename, join } from "node:path";

    // CommonJS require, created from the current module URL.
    import { createRequire } from "node:module";
    const require = createRequire(import.meta.url);
    const os = require("node:os");

    const resolved = {
      basename: basename("/workspace/data/report.txt"),
      joined: join("/workspace", "data", "report.txt"),
      platform: os.platform(),
    };

    console.log("resolved node:path via import ->", resolved.joined);
    console.log("resolved node:os via require ->", resolved.platform);
    console.log(JSON.stringify(resolved));
  `);

  console.log("exitCode:", exitCode);
  if (stderr.trim()) console.log("guest stderr:\n" + stderr.trim());
  console.log("guest stdout:");
  console.log(stdout.trim());
} finally {
  await rt.dispose();
}

// --- Loading a real npm package from the host -----------------------------

// Resolve a real, host-installed npm package directory. `is-number` is a tiny
// dependency-free CommonJS package already present in this repo's node_modules.
// `require.resolve` returns the package's entry file; its parent directory is
// the package root we project into the VM.
const require = createRequire(import.meta.url);
const isNumberDir = require.resolve("is-number").replace(/[/\\]index\.js$/, "");

// Boot a second VM and mount the host package directory into a guest
// `node_modules`. Resolution follows the importing module up its ancestor
// `node_modules` chain (not the cwd), and `exec()` runs each program from
// `/tmp`, so the package is mounted at `/tmp/node_modules/is-number` where that
// walk will find it.
const mounted = await NodeRuntime.create({
  mounts: [
    {
      guestPath: "/tmp/node_modules/is-number",
      hostPath: isNumberDir,
      readOnly: true,
    },
  ],
});

try {
  // The guest resolves `is-number` from the mounted host directory the same way
  // Node would over a real filesystem, then uses the real package's code.
  const { stdout, stderr, exitCode } = await mounted.exec(`
    // ESM import of the real, host-mounted npm package.
    import isNumber from "is-number";

    // The same package also resolves through a CommonJS require.
    import { createRequire } from "node:module";
    const require = createRequire(import.meta.url);
    const isNumberCjs = require("is-number");

    const result = {
      from: require.resolve("is-number"),
      "isNumber(42)": isNumber(42),
      'isNumber("3.14")': isNumber("3.14"),
      'isNumber("nope")': isNumber("nope"),
      sameModule: isNumber === isNumberCjs,
    };

    console.log("loaded real npm package ->", result.from);
    console.log(JSON.stringify(result));
  `);

  console.log("exitCode:", exitCode);
  if (stderr.trim()) console.log("guest stderr:\n" + stderr.trim());
  console.log("guest stdout:");
  console.log(stdout.trim());
} finally {
  await mounted.dispose();
}

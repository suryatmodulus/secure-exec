# @secure-exec/typescript

Run the TypeScript compiler **inside the secure-exec sandbox**. The compiler is
projected into the VM and every compile and type-check happens in the guest, so
untrusted TypeScript never executes (or compiles) on the host.

## Install

```sh
npm install @secure-exec/typescript secure-exec
```

## Usage

```ts
import { createTypeScriptTools } from "@secure-exec/typescript";

const tools = createTypeScriptTools();

// Compile TypeScript to JavaScript inside the sandbox.
const compiled = await tools.compileSource({
  sourceText: "const answer: number = 42;\nconsole.log(answer);",
  compilerOptions: { module: "ESNext", target: "ES2022" },
});
console.log(compiled.outputText);

// Type-check inside the sandbox and get structured diagnostics back.
const checked = await tools.typecheckSource({
  sourceText: `const total: number = "not a number";`,
});
console.log(checked.success, checked.diagnostics);
```

## API

`createTypeScriptTools(options?)` returns:

- `compileSource({ sourceText, filePath?, cwd?, configFilePath?, compilerOptions? })`
  -> `{ success, diagnostics, outputText, sourceMapText }`
- `typecheckSource({ sourceText, ... })` -> `{ success, diagnostics }`
- `compileProject({ cwd?, configFilePath? })`
  -> `{ success, diagnostics, emitSkipped, emittedFiles }`
- `typecheckProject({ cwd?, configFilePath? })` -> `{ success, diagnostics }`

Each diagnostic is `{ code, category, message, filePath?, line?, column? }`.

Seed extra files into the VM with the `files` option, or project host
directories with the `mounts` option, to compile whole projects.

See the [documentation](https://secureexec.dev/docs) for details.

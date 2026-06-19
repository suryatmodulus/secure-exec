/**
 * TypeScript example.
 *
 * `@secure-exec/typescript` runs the TypeScript compiler INSIDE the sandbox.
 * The compiler is projected into the VM and every compile/type-check happens
 * in the guest, so untrusted TypeScript never executes (or compiles) on the
 * host. Here we compile a typed snippet to JavaScript, run the emitted code in
 * the sandbox, and type-check a snippet that has a type error.
 */
import { createTypeScriptTools } from "@secure-exec/typescript";
import { NodeRuntime } from "secure-exec";

const tools = createTypeScriptTools();

// A typed snippet we want to compile and run inside the sandbox.
const typeScriptSource = `
interface Greeting {
  name: string;
  count: number;
}

const greeting: Greeting = { name: "secure-exec", count: 3 };
const lines: string[] = Array.from(
  { length: greeting.count },
  (_unused, index) => \`hello \${greeting.name} #\${index + 1}\`,
);

for (const line of lines) {
  console.log(line);
}
`;

// Step 1: compile TypeScript to JavaScript inside the sandbox.
const compiled = await tools.compileSource({
  sourceText: typeScriptSource,
  compilerOptions: { module: "ESNext", target: "ES2022" },
});

if (!compiled.success) {
  const messages = compiled.diagnostics.map((d) => d.message);
  throw new Error(`TypeScript compile failed:\n${messages.join("\n")}`);
}

console.log("Compiled TypeScript to JavaScript inside the sandbox.");

// Step 2: run the emitted JavaScript inside the sandbox.
const rt = await NodeRuntime.create();
try {
  const result = await rt.exec(compiled.outputText ?? "");
  console.log("exitCode:", result.exitCode);
  console.log("guest stdout:\n" + result.stdout.trimEnd());
} finally {
  await rt.dispose();
}

// Step 3: type-check a snippet that has a type error inside the sandbox.
const typeCheck = await tools.typecheckSource({
  sourceText: `const total: number = "not a number";`,
});

console.log("type check success:", typeCheck.success);
for (const diagnostic of typeCheck.diagnostics) {
  console.log(
    `  ${diagnostic.category} TS${diagnostic.code} (line ${diagnostic.line}): ${diagnostic.message}`,
  );
}

if (typeCheck.success) {
  throw new Error("Expected the ill-typed snippet to fail type checking.");
}

console.log("OK: TypeScript compiled and type-checked inside the sandbox.");

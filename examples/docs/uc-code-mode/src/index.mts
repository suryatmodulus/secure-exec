import { NodeRuntime } from "secure-exec";

// Code Mode: instead of giving the LLM many individual tools, you give it one
// "execute code" tool. The LLM writes JavaScript that chains tool calls,
// branches, and transforms data - then runs it in a single sandboxed pass.
//
// The façade runs guest JavaScript and hands a structured value back to the
// host via globalThis.__return(). It does NOT expose host functions into the
// guest, so the "tools" the generated code calls are provided to the guest as
// in-sandbox helpers (here, defined in the program preamble). The generated
// orchestration code chains those helpers and returns one JSON result.

// The tool implementations, provided to the guest as `codemode.*`. In a real
// app you would generate this from your tool registry; everything here runs
// inside the sandbox, never on the host.
const toolsPreamble = `
const codemode = {
  async getWeather({ city }) {
    const table = {
      "San Francisco": { temp_f: 61 },
      "Tokyo": { temp_f: 75 },
    };
    return table[city] ?? { temp_f: null };
  },
  async calculate({ expression }) {
    // A real tool would call out to a service; we keep it simple and safe.
    return { result: Number(eval(expression)) };
  },
};
`;

// Imagine this string was written by the LLM. It chains three tool calls with
// real control flow (Promise.all, arithmetic, branching) in one execution, then
// hands a single structured result back to the host.
const llmGeneratedCode = `
const [sf, tokyo] = await Promise.all([
  codemode.getWeather({ city: "San Francisco" }),
  codemode.getWeather({ city: "Tokyo" }),
]);

const diffF = Math.abs(sf.temp_f - tokyo.temp_f);
const diffC = await codemode.calculate({ expression: \`\${diffF} * 5 / 9\` });

console.log("chained 3 tool calls in one sandbox execution");

globalThis.__return({
  san_francisco: sf,
  tokyo: tokyo,
  difference: { fahrenheit: diffF, celsius: diffC.result },
  warmer: sf.temp_f > tokyo.temp_f ? "San Francisco" : "Tokyo",
});
`;

interface CodeModeResult {
  san_francisco: { temp_f: number };
  tokyo: { temp_f: number };
  difference: { fahrenheit: number; celsius: number };
  warmer: string;
}

const rt = await NodeRuntime.create();
try {
  // rt.run() executes the guest code and decodes whatever it passes to
  // globalThis.__return(), while still capturing stdout/stderr/exitCode.
  const result = await rt.run<CodeModeResult>(
    toolsPreamble + llmGeneratedCode,
    { timeout: 5000 },
  );

  console.log("exitCode:", result.exitCode);
  console.log("stdout:", result.stdout.trim());
  console.log("structured result:", JSON.stringify(result.value, null, 2));
} finally {
  await rt.dispose();
}

# secure-exec

The public SDK for secure-exec, a fully virtualized runtime for executing
untrusted JavaScript inside a kernel isolation boundary.

This package re-exports the curated public surface. For low-level and advanced
APIs, use `@secure-exec/core`.

## Install

```sh
npm install secure-exec
```

## Usage

```ts
import { NodeRuntime } from "secure-exec";

const rt = await NodeRuntime.create();
const { stdout, exitCode } = await rt.exec("console.log('hi', 1 + 1)");
console.log(stdout, exitCode);
await rt.dispose();
```

Guest code runs inside a virtualized VM with no network access by default.
Opt into the network by passing a permission policy:

```ts
const rt = await NodeRuntime.create({ permissions: { network: "allow" } });
```

# Trunk CI SDK

Public TypeScript SDK and contract for defining provider-neutral Trunk CI workflows without YAML.

This repository contains the authoring/contract side of Trunk CI. The Trunk control plane remains authoritative: it must independently validate every submitted plan, recompute its canonical digest, bind that exact plan to the exact immutable candidate under test, and only accept results for that binding.

> The npm package name is provisional while the SDK is pre-release.

## Minimal workflow

```ts
import { checkout, job, run, workflow } from 'trunk-ci-sdk';

const plan = workflow({
  test: job([
    checkout(),
    run('npm test'),
  ]),
});
```

This produces the canonical v1 shape:

```json
{
  "version": 1,
  "jobs": {
    "test": {
      "steps": [
        { "kind": "checkout" },
        { "kind": "run", "command": "npm test" }
      ]
    }
  }
}
```

`checkout()` means materialize the exact immutable Trunk candidate bound to the CI attempt. It is deliberately not a branch/ref selector.

`run()` executes a command in that checked-out workspace. More capabilities such as artifacts, caches, tool setup and BuildKit-oriented helpers are intentionally outside the first contract slice.

## Contract properties

- No YAML workflow language.
- Provider-neutral plan; Buildkite is an execution/scheduling integration, not part of workflow syntax.
- Strict validation: unknown fields and unknown step kinds fail closed.
- Job names use the same normalization envelope as Trunk check names: trim surrounding whitespace, require a non-empty name, maximum 120 characters.
- Job map order is not semantic; step order is semantic.
- `canonicalWorkflowPlan()` deterministically serializes the validated plan with lexicographically sorted object keys.
- `workflowPlanDigest()` returns the lowercase SHA-256 hex digest of that canonical representation.
- Repository TypeScript is an authoring frontend. Trunk's control plane stores and validates the resulting data plan; it does not execute arbitrary repository TypeScript.

## Development

```sh
npm install
npm run check
npm run build
```

Node.js 22.18 or later is required for native TypeScript execution in the test runner.

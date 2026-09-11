# Trunk CI SDK

Public TypeScript SDK and contract for defining provider-neutral Trunk CI workflows without YAML.

This repository is the authoring/composition side of Trunk CI. Repository code produces a plain workflow plan; the Trunk control plane remains authoritative and independently validates the submitted plan, recomputes its canonical representation and digest, binds it to the exact immutable candidate under test, and accepts results only for that binding.

> **Pre-release:** the package is currently version `0.0.0`, and the npm package name `trunk-ci-sdk` is provisional. Do not treat the current package name or distribution path as a stable compatibility promise yet.

## Quick start

A workflow is a set of named jobs. Each job contains ordered steps. Version 1 supports two step kinds: checkout the exact Trunk candidate and run a command in that workspace.

```ts
import { checkout, job, run, workflow } from 'trunk-ci-sdk';

const plan = workflow({
  test: job([
    checkout(),
    run('npm ci'),
    run('npm test'),
  ]),
  typecheck: job([
    checkout(),
    run('npm ci'),
    run('npm run typecheck'),
  ]),
});
```

A repository's candidate-owned workflow entry is the fixed `trunk-ci.ts` path. Treat that TypeScript file as an authoring frontend whose result is the data plan shown above; Trunk does not execute arbitrary repository TypeScript in its control-plane process. The workflow resolver runs against the exact immutable candidate being checked, then Trunk validates the resulting data again at its trust boundary.

The example above resolves to this version-1 plan shape:

```json
{
  "version": 1,
  "jobs": {
    "test": {
      "steps": [
        { "kind": "checkout" },
        { "kind": "run", "command": "npm ci" },
        { "kind": "run", "command": "npm test" }
      ]
    },
    "typecheck": {
      "steps": [
        { "kind": "checkout" },
        { "kind": "run", "command": "npm ci" },
        { "kind": "run", "command": "npm run typecheck" }
      ]
    }
  }
}
```

`checkout()` is deliberately not a branch or ref selector. It means materialize the exact immutable candidate already bound to the CI attempt. Branch names and other mutable refs are not workflow authority.

`run(command)` executes the supplied non-empty command in that checked-out workspace. The v1 contract intentionally does not include artifacts, caches, tool setup, secret declarations, provider queues, hosted-agent images, or BuildKit-specific helpers.

## Where authority lives

The SDK helps repository authors construct and inspect a valid plan, but SDK success is not authorization and is not proof that Trunk will accept a request. Trunk independently validates the resolver output and binds it to the exact candidate revision before CI evidence can count for that candidate.

Important consequences:

- **Candidate-owned definition:** the workflow definition travels with the candidate being tested instead of being selected from a mutable branch after dispatch.
- **Provider-neutral plan:** Buildkite may execute/schedule work, but Buildkite pipeline, queue, webhook, image, credential, and routing concepts are not part of the workflow syntax.
- **Strict/fail-closed validation:** unknown fields, unknown step kinds, missing required fields, malformed job/step objects, empty workflows, empty step lists, and empty run commands are rejected.
- **Exact candidate checkout:** `checkout` refers to the already-authorized immutable candidate, never an author-selected ref.
- **Canonicalization is deterministic:** object keys are serialized lexicographically; job map insertion order therefore does not change the canonical representation or digest. Array order remains semantic, so step order does matter.
- **Digest is correlation/audit identity, not landing authority:** `workflowPlanDigest()` identifies the canonical plan. Trunk's authorization remains bound to the exact candidate and its current revision/check state.
- **Repository TypeScript is untrusted input:** the control plane consumes the resulting bounded data plan and re-validates it rather than trusting repository-side code or SDK validation.

## Validation and failure behavior

All public constructors that accept authored values validate before returning a frozen plan fragment. `parseWorkflowPlan()` is the public trust-boundary parser for unknown data and enforces the complete v1 shape.

Validation throws `WorkflowValidationError`. Callers should treat it as a definitive invalid-plan result for the supplied input rather than retrying the same bytes. The message describes the first rejected condition; it is diagnostic text, not a stable machine-readable error-code contract.

Current v1 rules include:

- a workflow object has exactly `version` and `jobs`;
- `version` must equal `WORKFLOW_PLAN_VERSION` (`1`);
- a workflow must contain at least one job;
- job names are trimmed, must remain non-empty, and may be at most 120 characters;
- two raw job names that normalize to the same trimmed name are rejected;
- a job object has exactly `steps` and must contain at least one step;
- sparse/missing step array entries are rejected;
- checkout steps contain exactly `{ kind: 'checkout' }`;
- run steps contain exactly `{ kind: 'run', command: string }`, and the command must contain non-whitespace text;
- all other step kinds and extra fields are rejected.

Constructors and parsers return frozen objects/arrays. This prevents accidental mutation of an already-built plan in ordinary authoring code; callers should still regard Trunk's independently parsed/canonicalized copy as authoritative.

## Public API reference

Everything exported from `src/index.ts` is part of the current pre-release public surface.

### Constants and errors

#### `WORKFLOW_PLAN_VERSION`

The literal current plan version, `1`. `WorkflowPlanV1.version` is typed to this value, and `parseWorkflowPlan()` rejects any other version.

#### `WorkflowValidationError`

`Error` subclass used for SDK validation failures. Its `name` is `WorkflowValidationError`. Error messages are intended for diagnostics and human feedback; no separate stable error-code field is currently exposed by this SDK.

### Authoring helpers

#### `checkout(): CheckoutStepV1`

Creates a frozen checkout step for the exact immutable candidate bound to the CI attempt. Takes no ref, branch, repository, provider, or credential argument.

#### `run(command: string): RunStepV1`

Creates a frozen run step. `command` must be a string containing non-whitespace text or the function throws `WorkflowValidationError`. The command string is preserved as authored; validation only requires that its trimmed form is non-empty.

#### `job(steps: readonly WorkflowStepV1[]): JobPlanV1`

Builds and validates one frozen job. At least one supported step is required. Each step is parsed strictly, so extra fields or unsupported kinds fail closed.

#### `workflow(jobs: Readonly<Record<string, JobPlanV1>>): WorkflowPlanV1`

Builds a complete version-1 workflow and validates it through the same strict parser used for unknown plans. At least one job is required. Job names are trimmed and must be unique after normalization.

### Parsing, canonicalization, and digest

#### `parseWorkflowPlan(input: unknown): WorkflowPlanV1`

Strictly validates unknown input and returns a normalized, frozen `WorkflowPlanV1`. Use this when the input did not originate entirely from the typed constructors or when you want to validate a decoded/serialized plan.

The parser requires exact object keys rather than silently ignoring additions. That is intentional: a producer and consumer must not disagree about the meaning of fields that one side ignores.

#### `canonicalWorkflowPlan(input: unknown): string`

Validates the input with `parseWorkflowPlan()` and returns deterministic compact JSON. Object keys are sorted lexicographically at every level; array order is preserved.

The function can therefore be used to compare the semantic v1 data plan independent of object insertion order. Invalid input throws `WorkflowValidationError` before canonical output is produced.

#### `workflowPlanDigest(input: unknown): Promise<string>`

Validates and canonicalizes the input, then returns the lowercase SHA-256 digest of the UTF-8 canonical JSON as a 64-character hexadecimal string. It uses the runtime Web Crypto API and is asynchronous.

The digest identifies the canonical plan for audit/correlation. It does not replace Trunk's exact-candidate/revision authority.

### Public types

#### `CheckoutStepV1`

```ts
type CheckoutStepV1 = Readonly<{
  kind: 'checkout';
}>;
```

The exact-candidate checkout step.

#### `RunStepV1`

```ts
type RunStepV1 = Readonly<{
  kind: 'run';
  command: string;
}>;
```

A command step executed in the checked-out candidate workspace.

#### `WorkflowStepV1`

```ts
type WorkflowStepV1 = CheckoutStepV1 | RunStepV1;
```

The complete supported v1 step union.

#### `JobPlanV1`

```ts
type JobPlanV1 = Readonly<{
  steps: readonly WorkflowStepV1[];
}>;
```

One named workflow job's ordered step plan. The name lives in the parent workflow's `jobs` map rather than inside `JobPlanV1`.

#### `WorkflowPlanV1`

```ts
type WorkflowPlanV1 = Readonly<{
  version: typeof WORKFLOW_PLAN_VERSION;
  jobs: Readonly<Record<string, JobPlanV1>>;
}>;
```

The complete provider-neutral v1 workflow data contract.

## Canonicalization example

These two authored objects have different insertion order but the same validated plan identity:

```ts
import { canonicalWorkflowPlan, workflowPlanDigest } from 'trunk-ci-sdk';

const first = {
  version: 1,
  jobs: {
    test: { steps: [{ kind: 'checkout' }, { kind: 'run', command: 'npm test' }] },
    build: { steps: [{ kind: 'checkout' }, { kind: 'run', command: 'npm run build' }] },
  },
};

const second = {
  jobs: {
    build: { steps: [{ command: 'npm run build', kind: 'run' }, { kind: 'checkout' }] },
    test: { steps: [{ command: 'npm test', kind: 'run' }, { kind: 'checkout' }] },
  },
  version: 1,
};
```

However, the example above intentionally **does not** have the same plan identity because `second` also reverses each job's step array. Step order is semantic. If only object-key/job-map insertion order changes while arrays stay in the same order, `canonicalWorkflowPlan()` and `workflowPlanDigest()` are equal.

That distinction is useful when debugging digest mismatches: reordering object properties is irrelevant; reordering workflow steps changes the workflow.

## Development and validation

Node.js 22.18 or later is required by the package and for native TypeScript execution in the test runner.

From a clean checkout:

```sh
npm install
npm run check
npm run build
```

`npm run check` performs TypeScript validation for the package and tests, then runs the test suite. `npm run build` cleans and emits the distributable `dist/` output from `tsconfig.json`.

For focused work:

```sh
npm test
```

The package has no runtime dependencies today. Keep additions provider-neutral: execution-provider configuration belongs behind Trunk's integration boundary rather than in this workflow contract.

## Current v1 limits

The small surface is intentional. Version 1 has only named jobs, exact-candidate checkout, and command execution. It currently has no workflow-level dependencies, conditional execution, matrices, artifacts, caches, service containers, secret declarations, provider selection, retries, timeouts, or deployment semantics.

Do not encode provider-specific behavior into job names or command conventions and then treat those conventions as part of the SDK contract. When the workflow model gains a capability, it should be represented explicitly and validated by both the SDK and Trunk control plane.

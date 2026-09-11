# Trunk CI SDK

Public TypeScript SDK and contract for defining provider-neutral Trunk CI workflows without YAML.

This repository is the authoring/composition side of Trunk CI. Repository code produces a plain workflow plan; the Trunk control plane remains authoritative and independently validates the submitted plan, recomputes its canonical representation and digest, binds it to the exact immutable candidate under test, and accepts results only for that binding.

> **Pre-release:** the package is currently version `0.0.0`, and the npm package name `trunk-ci-sdk` is provisional. Do not treat the current package name or distribution path as a stable compatibility promise yet.

## Quick start

A repository's candidate-owned workflow entry is the fixed `trunk-ci.ts` path. It must default-export the workflow plan:

```ts
import { checkout, job, run, workflow } from 'trunk-ci-sdk';

export default workflow({
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

A workflow is a set of named jobs. Each job contains ordered steps. Version 1 supports two step kinds: checkout the exact Trunk candidate and run a command in that workspace.

Treat `trunk-ci.ts` as an authoring frontend whose default export is the data plan shown below. Repository-authored TypeScript is evaluated only in the bounded candidate workflow sandbox, not inside the Trunk control-plane process. The resolver imports the exact candidate's `trunk-ci.ts`, requires a default export, serializes that value as JSON, and passes the bounded result back across the trust boundary. Trunk then independently validates and canonicalizes that data before it can become CI evidence.

The bare `trunk-ci-sdk` import in `trunk-ci.ts` is part of that runtime boundary. During candidate resolution Trunk intercepts exactly that module specifier and supplies its trusted SDK runtime. Candidate dependencies do not choose or replace the SDK implementation used by the resolver. Do not add a package-install step merely to make the runtime import work. The repository package remains useful as the public TypeScript authoring/contract surface, but its current `0.0.0` package identity and distribution are still pre-release.

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

`checkout()` is deliberately not a branch or ref selector. It materializes the exact immutable candidate already bound to the CI attempt into that job's isolated workspace. Calling `checkout()` again resets that job workspace back to the same exact candidate.

`run(command)` executes the supplied non-empty command in the job workspace. A run step is rejected at execution time if that job has not completed a preceding checkout step. The SDK's data-shape validation does not itself enforce this execution-order rule, so author jobs with `checkout()` before their first `run()`.

The v1 contract intentionally does not include artifacts, caches, tool setup, secret declarations, provider queues, hosted-agent images, or Buildkite-specific helpers.

## Where authority lives

The SDK helps repository authors construct and inspect a valid plan, but SDK success is not authorization and is not proof that Trunk will accept or successfully execute a workflow. Trunk independently validates the resolver output, binds it to the exact candidate revision, and applies execution-time constraints before CI evidence can count for that candidate.

Important consequences:

- **Candidate-owned definition:** the workflow definition travels with the candidate being tested instead of being selected from a mutable branch after dispatch.
- **Provider-neutral plan:** Buildkite may execute/schedule work, but Buildkite pipeline, queue, webhook, image, credential, and routing concepts are not part of the workflow syntax.
- **Trusted SDK runtime:** the candidate resolver supplies the `trunk-ci-sdk` runtime for the exact bare module specifier instead of trusting a candidate-selected implementation.
- **Strict/fail-closed shape validation:** unknown fields, unknown step kinds, missing required fields, malformed job/step objects, empty workflows, empty step lists, and empty run commands are rejected.
- **Execution also fails closed:** a syntactically valid run step cannot execute before checkout in the same job, and a non-zero command exit fails that workflow execution.
- **Exact candidate checkout:** `checkout` refers to the already-authorized immutable candidate, never an author-selected ref.
- **Canonicalization is deterministic:** object keys are serialized lexicographically; job map insertion order therefore does not change the canonical representation or digest. Array order remains semantic, so step order does matter.
- **Digest is correlation/audit identity, not landing authority:** `workflowPlanDigest()` identifies the canonical plan. Trunk's authorization remains bound to the exact candidate and its current revision/check state.
- **Repository TypeScript is untrusted input:** candidate code runs in the candidate sandbox; the control plane consumes only the resulting bounded data plan and re-validates it rather than trusting repository-side code or SDK validation.

## Validation and failure behavior

Public helpers validate authored values before returning frozen plan fragments. `parseWorkflowPlan()` is the public strict parser for unknown workflow-plan data and enforces the complete v1 data shape.

Validation throws `WorkflowValidationError`. The current SDK exposes no separate machine-readable validation error-code field; callers that need to distinguish SDK validation failure can use the error class rather than parsing message text.

Current v1 shape rules include:

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

Those are data-shape rules, not the complete execution contract. In particular, `parseWorkflowPlan()` accepts a plan containing a `run` step before `checkout`; the candidate workflow executor rejects that ordering when it attempts to execute the job. Keeping this distinction explicit avoids treating parser acceptance as proof that a plan can run successfully.

Constructors and parsers return frozen objects/arrays. This prevents accidental mutation of an already-built plan in ordinary authoring code; callers should still regard Trunk's independently parsed/canonicalized copy as authoritative.

## Public API reference

Everything exported from `src/index.ts` is part of the current pre-release public surface.

### Constants and errors

#### `WORKFLOW_PLAN_VERSION`

The literal current plan version, `1`. `WorkflowPlanV1.version` is typed to this value, and `parseWorkflowPlan()` rejects any other version.

#### `WorkflowValidationError`

`Error` subclass used for SDK data-shape validation failures. Its `name` is `WorkflowValidationError`. The current class has no separate stable error-code field. Trunk workflow resolution/execution failures are control-plane/runtime errors and are not represented by this SDK error class.

### Authoring helpers

#### `checkout(): CheckoutStepV1`

Creates a frozen checkout step for the exact immutable candidate bound to the CI attempt. Takes no ref, branch, repository, provider, or credential argument. At execution time the step materializes or resets the isolated job workspace to that candidate.

#### `run(command: string): RunStepV1`

Creates a frozen run step. `command` must be a string containing non-whitespace text or the function throws `WorkflowValidationError`. The command string is preserved as authored; validation only requires that its trimmed form is non-empty.

At execution time Trunk runs the command with ordinary shell exit semantics in the checked-out job workspace. A preceding checkout in the same job is required; that ordering constraint is enforced by the executor, not by this constructor.

#### `job(steps: readonly WorkflowStepV1[]): JobPlanV1`

Builds and validates one frozen job. At least one supported step is required. Each step is parsed strictly, so extra fields or unsupported kinds fail closed. The helper validates plan shape but does not require the first step to be checkout.

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

A command step executed in the job workspace after checkout.

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

The complete provider-neutral v1 workflow data contract. A candidate `trunk-ci.ts` must default-export a JSON-serializable value that resolves to this validated shape.

## Canonicalization example

These two objects differ only in object/job-map insertion order and therefore have the same canonical representation and digest:

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
    build: { steps: [{ kind: 'checkout' }, { command: 'npm run build', kind: 'run' }] },
    test: { steps: [{ kind: 'checkout' }, { command: 'npm test', kind: 'run' }] },
  },
  version: 1,
};

canonicalWorkflowPlan(first) === canonicalWorkflowPlan(second); // true
await workflowPlanDigest(first) === await workflowPlanDigest(second); // true
```

Arrays are semantic. For example, moving `checkout` after `run` produces a different canonical plan and digest even though the same two step objects are present. In Trunk's current executor that reordered plan also fails execution because the run step occurs before checkout.

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

The small surface is intentional. The current v1 data model represents named jobs containing only exact-candidate `checkout` and command `run` steps. Capabilities not represented by that shape are not part of v1, and strict parsing rejects additional fields or step kinds rather than silently accepting them.

Provider-specific execution configuration belongs behind Trunk's integration boundary rather than in this workflow contract.

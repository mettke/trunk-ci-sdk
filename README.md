# Trunk CI SDK

Public TypeScript SDK and contract for defining provider-neutral Trunk CI workflows without YAML.

This repository is the authoring/composition side of Trunk CI. Repository code produces a plain workflow plan; the Trunk control plane remains authoritative and independently validates the submitted plan, recomputes its canonical representation and digest, selects the applicable lifecycle workflow, binds execution and evidence to the exact immutable source revision, and applies CI lifecycle rules.

> **Pre-release:** the package is currently version `0.0.0`, and the npm package name `trunk-ci-sdk` is provisional. Do not treat the current package name or distribution path as a stable compatibility promise yet.

## Quick start: WorkflowPlanV1

A repository's workflow entry is the fixed `trunk-ci.ts` path. WorkflowPlanV1 remains the compatibility form for one candidate workflow and must default-export the workflow plan:

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

A V1 workflow is a set of named jobs. Each job contains ordered steps. V1 supports two step kinds: checkout the exact Trunk-bound source and run a command in that workspace. V1 job names are internal job labels; they are not independent workflow/check identities.

Treat `trunk-ci.ts` as an authoring frontend whose default export is the data plan shown below. Repository-authored TypeScript is evaluated only in the bounded workflow-resolution sandbox, not inside the Trunk control-plane process. The resolver imports the exact revision's `trunk-ci.ts`, requires a default export, serializes that value as JSON, and passes the bounded result back across the trust boundary. Trunk then independently validates and canonicalizes that data before it can become CI or lifecycle evidence.

The bare `trunk-ci-sdk` import in `trunk-ci.ts` is part of that runtime boundary. During workflow resolution Trunk intercepts exactly that module specifier and supplies its trusted SDK runtime. Repository dependencies do not choose or replace the SDK implementation used by the resolver. Do not add a package-install step merely to make the runtime import work. The repository package remains useful as the public TypeScript authoring/contract surface, but its current `0.0.0` package identity and distribution are still pre-release.

The example above resolves to this V1 plan shape:

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

`checkout()` is deliberately not a branch or ref selector. It represents the exact immutable source already bound by Trunk to the workflow attempt. For candidate CI that is the exact candidate SHA. Post-land lifecycle source authority is the exact landed SHA associated with the durable land fact, not whatever a mutable default branch points to later.

`run(command)` executes the supplied non-empty command in the job workspace. A run step is rejected at execution time if that job has not completed a preceding checkout step. The SDK's data-shape validation does not itself enforce this execution-order rule, so author jobs with `checkout()` before their first `run()`.

The V1 contract intentionally does not include artifacts, caches, tool setup, secret declarations, provider queues, hosted-agent images, or provider-specific helpers.

## WorkflowPlanV2: named lifecycle workflows

WorkflowPlanV2 keeps the existing job/step contract and adds globally named workflows. Each workflow has exactly one lifecycle trigger: `candidate`, `landed`, or `cleanup`.

The current trusted Trunk resolver supplies the established runtime helpers `checkout`, `job`, and `run`. V2's new top-level structure is therefore authored as typed data rather than through a new runtime helper:

```ts
import { checkout, job, run, type WorkflowPlanV2 } from 'trunk-ci-sdk';

const plan = {
  version: 2,
  workflows: {
    'Candidate CI': {
      trigger: 'candidate',
      jobs: {
        test: job([
          checkout(),
          run('npm ci'),
          run('npm test'),
        ]),
      },
    },

    'Post-land verification': {
      trigger: 'landed',
      jobs: {
        verify: job([
          checkout(),
          run('npm ci'),
          run('npm run verify'),
        ]),
      },
    },

    Cleanup: {
      trigger: 'cleanup',
      jobs: {
        cleanup: job([
          checkout(),
          run('npm run cleanup'),
        ]),
      },
    },
  },
} satisfies WorkflowPlanV2;

export default plan;
```

The corresponding public data shape is:

```ts
type WorkflowTriggerV2 = 'candidate' | 'landed' | 'cleanup';

type NamedWorkflowPlanV2 = Readonly<{
  trigger: WorkflowTriggerV2;
  jobs: Readonly<Record<string, JobPlanV1>>;
}>;

type WorkflowPlanV2 = Readonly<{
  version: 2;
  workflows: Readonly<Record<string, NamedWorkflowPlanV2>>;
}>;
```

A V2 **workflow**, not an individual job, is the independent scheduling/result/retry/cancellation unit. Jobs remain internal execution units. The initial V2 contract intentionally adds no repository-authored workflow DAG, matrix expansion, conditions, cross-workflow dependencies, fan-in/fan-out, or provider-specific execution configuration.

### Lifecycle triggers and identity

- **`candidate`** — identifies CI for an exact immutable candidate revision. A configured required candidate workflow maps by its **workflow name** to Trunk's `CheckRequirement` / `CheckRun` identity for that exact candidate. Multiple required candidate workflows are independent gates; success in one does not substitute for another.
- **`landed`** — identifies post-land CI for the exact SHA that actually won landing. Its source authority is that exact landed SHA, never a later default-branch head. It is post-land lifecycle evidence, not a candidate landing gate.
- **`cleanup`** — identifies generic post-land cleanup workflow code. Cleanup materializes independently from the durable land fact, does not gate or undo landing, and does not gain destructive authority from arbitrary workflow output or branch names. Trusted integration/capability state remains authoritative for destructive resource operations.

V2 workflow names are globally unique after normalization and share the same exact identity domain as candidate `CheckRequirement` / `CheckRun` names. V2 workflow names and V2 job names are trimmed, non-empty, at most 120 UTF-16 code units, must not contain NUL, and must be well-formed UTF-16. Well-formed supplementary Unicode and embedded CR/LF remain valid. Names that collide after trimming are rejected. V1 retains its existing job-name semantics for compatibility.

The SDK expresses lifecycle declarations only. It does not decide which candidate workflows are required, create durable lifecycle runs/attempts, materialize land facts, choose provider configuration, authorize destructive cleanup, or reconcile provider results.

### Why there is no `workflowV2()` runtime helper

Inside workflow resolution, Trunk intercepts the bare `trunk-ci-sdk` module specifier and supplies a trusted resolver runtime instead of executing a repository-selected SDK implementation. That trusted runtime currently exposes the established V1-era runtime helpers such as `checkout`, `run`, and `job`, while authoritative Trunk parsing already accepts WorkflowPlanV2 data.

A type-only `WorkflowPlanV2` import is erased before runtime and therefore does not require a new trusted resolver export. Publishing a `workflowV2()` helper before Trunk's trusted resolver runtime exposes it would make package typechecking succeed while real `trunk-ci.ts` resolution fails, so this SDK deliberately does not promise such a helper today.

This is a runtime-boundary constraint, not a second workflow contract: the V2 data contract remains the one Trunk validates authoritatively.

## Where authority lives

The SDK helps repository authors construct and inspect a valid plan, but SDK success is not authorization and is not proof that Trunk will accept or successfully execute a workflow. Trunk independently validates resolver output, selects the applicable workflow, binds it to the exact source revision and lifecycle state, and applies execution-time constraints before evidence can count.

Important consequences:

- **Revision-owned definition:** the workflow definition travels with immutable repository source instead of being selected from a mutable branch after dispatch.
- **Provider-neutral plan:** Trunk may use a managed execution provider behind this contract, but provider pipeline, queue, webhook, image, executor, credential, routing, and deployment-provider identifiers are not part of the workflow syntax.
- **Trusted SDK runtime:** the resolver supplies the `trunk-ci-sdk` runtime for the exact bare module specifier instead of trusting a repository-selected implementation.
- **Strict/fail-closed shape validation:** unknown fields, unknown triggers/step kinds, missing required fields, malformed workflow/job/step objects, empty workflow/job/step collections, and empty run commands are rejected.
- **Execution also fails closed:** a syntactically valid run step cannot execute before checkout in the same job, and a non-zero command exit fails that workflow execution.
- **Exact source checkout:** `checkout` refers to the already-authorized immutable source, never an author-selected ref. Candidate authority is the exact candidate SHA; post-land source authority is the exact landed SHA.
- **Canonicalization is deterministic:** object keys are serialized lexicographically; workflow/job map insertion order therefore does not change the canonical representation or digest. Array order remains semantic, so step order does matter.
- **Digest is correlation/audit identity, not lifecycle authority:** `workflowPlanDigest()` identifies the canonical plan. Trunk's authorization remains bound to exact repository revision, lifecycle state, checks, and trusted integration state.
- **Repository TypeScript is untrusted input:** repository code runs in the workflow sandbox; the control plane consumes only the resulting bounded data plan and re-validates it rather than trusting repository-side code or SDK validation.
- **No ambient destructive authority:** repository syntax does not grant privileged secrets or make arbitrary workflow output, branch names, queue/image/executor IDs, or provider metadata authoritative for destructive operations.

## Validation and failure behavior

Public helpers validate authored values before returning frozen plan fragments. `parseWorkflowPlan()` is the public strict parser for unknown V1 or V2 workflow-plan data.

Validation throws `WorkflowValidationError`. The current SDK exposes no separate machine-readable validation error-code field; callers that need to distinguish SDK validation failure can use the error class rather than parsing message text.

Common job/step shape rules include:

- a job object has exactly `steps` and must contain at least one step;
- sparse/missing step array entries are rejected;
- checkout steps contain exactly `{ kind: 'checkout' }`;
- run steps contain exactly `{ kind: 'run', command: string }`, and the command must contain non-whitespace text;
- all other step kinds and extra fields are rejected.

V1 additionally requires:

- a top-level object with exactly `version` and `jobs`;
- `version` equal to `WORKFLOW_PLAN_VERSION` (`1`);
- at least one job;
- job names trimmed to non-empty values of at most 120 UTF-16 code units;
- no duplicate V1 job name after trimming.

V2 additionally requires:

- a top-level object with exactly `version` and `workflows`;
- `version` equal to `2`;
- at least one named workflow;
- each named workflow object to contain exactly `trigger` and `jobs`;
- exactly one supported trigger value: `candidate`, `landed`, or `cleanup`;
- at least one job in every workflow;
- workflow names and V2 job names to satisfy the transport-safe identity rules described above;
- no duplicate workflow or V2 job identity after normalization.

Those are data-shape rules, not the complete execution contract. In particular, `parseWorkflowPlan()` accepts a plan containing a `run` step before `checkout`; the executor rejects that ordering when it attempts to execute the job. Keeping this distinction explicit avoids treating parser acceptance as proof that a plan can run successfully.

Constructors and parsers return frozen objects/arrays. This prevents accidental mutation of an already-built parsed plan in ordinary authoring code; callers should still regard Trunk's independently parsed/canonicalized copy as authoritative. A typed V2 object literal is ordinary author-owned data until it crosses the parser/trust boundary.

## Public API reference

Everything exported from `src/index.ts` is part of the current pre-release public surface.

### Constants and errors

#### `WORKFLOW_PLAN_VERSION`

The V1 plan-version constant, literal `1`, retained for compatibility. `WorkflowPlanV1.version` is typed to this value. V2 uses the literal discriminant `version: 2` in its public type so repository-authored V2 does not require a new runtime export from Trunk's trusted resolver SDK shim.

#### `WorkflowValidationError`

`Error` subclass used for SDK data-shape validation failures. Its `name` is `WorkflowValidationError`. The current class has no separate stable error-code field. Trunk workflow resolution/execution failures are control-plane/runtime errors and are not represented by this SDK error class.

### Authoring helpers

#### `checkout(): CheckoutStepV1`

Creates a frozen checkout step for the exact immutable source bound to the workflow attempt. Takes no ref, branch, repository, provider, queue, image, executor, or credential argument. Execution materializes or resets the isolated job workspace to the authoritative exact source for that attempt.

#### `run(command: string): RunStepV1`

Creates a frozen run step. `command` must be a string containing non-whitespace text or the function throws `WorkflowValidationError`. The command string is preserved as authored; validation only requires that its trimmed form is non-empty.

At execution time Trunk runs the command with ordinary shell exit semantics in the checked-out job workspace. A preceding checkout in the same job is required; that ordering constraint is enforced by the executor, not by this constructor.

#### `job(steps: readonly WorkflowStepV1[]): JobPlanV1`

Builds and validates one frozen job. At least one supported step is required. Each step is parsed strictly, so extra fields or unsupported kinds fail closed. The helper validates plan shape but does not require the first step to be checkout.

#### `workflow(jobs: Readonly<Record<string, JobPlanV1>>): WorkflowPlanV1`

Builds a complete V1 workflow and validates it through the same strict parser used for unknown plans. At least one job is required. Job names are trimmed and must be unique after normalization.

There is intentionally no V2 top-level runtime builder today. Author the V2 top-level object as typed data with `satisfies WorkflowPlanV2`, while reusing the trusted `job`, `checkout`, and `run` runtime helpers for nested jobs and steps.

### Parsing, canonicalization, and digest

#### `parseWorkflowPlan(input: unknown): WorkflowPlan`

Strictly validates unknown V1 or V2 input and returns a normalized, frozen `WorkflowPlanV1 | WorkflowPlanV2`. Use this when the input did not originate entirely from typed authoring code or when you want to validate decoded/serialized plan data.

The parser requires exact object keys rather than silently ignoring additions. That is intentional: a producer and consumer must not disagree about the meaning of fields that one side ignores.

This package-side parser is author tooling, not Trunk's trust boundary. Trunk independently parses workflow resolver output before it can affect scheduling, checks, evidence, lifecycle state, or external integrations.

#### `canonicalWorkflowPlan(input: unknown): string`

Validates the input with `parseWorkflowPlan()` and returns deterministic compact JSON. Object keys are sorted lexicographically at every level; array order is preserved.

The function can therefore compare semantic V1 or V2 plan data independent of object/map insertion order. Invalid input throws `WorkflowValidationError` before canonical output is produced.

#### `workflowPlanDigest(input: unknown): Promise<string>`

Validates and canonicalizes the input, then returns the lowercase SHA-256 digest of the UTF-8 canonical JSON as a 64-character hexadecimal string. It uses the runtime Web Crypto API and is asynchronous.

For identical valid V1 or V2 plans, SDK canonicalization/digest is required to match Trunk canonicalization/digest. Trunk recomputes both itself rather than trusting SDK-provided output. The digest identifies canonical plan data for audit/correlation; it does not replace exact-revision or lifecycle authority.

### Public types

#### `CheckoutStepV1`

```ts
type CheckoutStepV1 = Readonly<{
  kind: 'checkout';
}>;
```

The exact-source checkout step.

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

The complete supported step union currently reused by both plan versions.

#### `JobPlanV1`

```ts
type JobPlanV1 = Readonly<{
  steps: readonly WorkflowStepV1[];
}>;
```

One workflow job's ordered step plan. The job name lives in its parent `jobs` map rather than inside `JobPlanV1`.

#### `WorkflowPlanV1`

```ts
type WorkflowPlanV1 = Readonly<{
  version: typeof WORKFLOW_PLAN_VERSION;
  jobs: Readonly<Record<string, JobPlanV1>>;
}>;
```

The provider-neutral compatibility contract for one candidate workflow containing jobs.

#### `WorkflowTriggerV2`

```ts
type WorkflowTriggerV2 = 'candidate' | 'landed' | 'cleanup';
```

The complete supported V2 lifecycle-trigger vocabulary.

#### `NamedWorkflowPlanV2`

```ts
type NamedWorkflowPlanV2 = Readonly<{
  trigger: WorkflowTriggerV2;
  jobs: Readonly<Record<string, JobPlanV1>>;
}>;
```

One independently scheduled/resulted/retried lifecycle workflow. Its identity is the key in the parent `workflows` map; jobs remain internal.

#### `WorkflowPlanV2`

```ts
type WorkflowPlanV2 = Readonly<{
  version: 2;
  workflows: Readonly<Record<string, NamedWorkflowPlanV2>>;
}>;
```

The provider-neutral V2 lifecycle-workflow data contract.

#### `WorkflowPlan`

```ts
type WorkflowPlan = WorkflowPlanV1 | WorkflowPlanV2;
```

The public versioned workflow-plan union accepted by package-side parsing/canonicalization/digest and independently re-parsed by Trunk.

## Canonicalization examples

These two V1 objects differ only in object/job-map insertion order and therefore have the same canonical representation and digest:

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

The same rule applies to V2 workflow and job maps: changing object/map insertion order does not change canonical data or the digest. Arrays are semantic in both versions. Reordering steps changes the canonical plan and digest, and moving `run` before `checkout` also makes the current executor reject the job.

That distinction is useful when debugging digest mismatches: reordering object properties is irrelevant; reordering workflow steps changes the workflow.

## Intentional current limits

The small surface is intentional. Both plan versions currently reuse named jobs containing only exact-source `checkout` and command `run` steps. V2 adds lifecycle workflow identity and trigger semantics, not a general pipeline language.

The public workflow language currently does **not** include:

- execution-provider pipeline, queue, image, executor, hosted-agent, webhook, credential, or routing identifiers;
- deployment-provider identifiers;
- ambient privileged secret declarations;
- workflow DAG edges, matrices, conditions, fan-in/fan-out, or cross-workflow dependencies;
- repository-authored selection of which candidate workflows are required;
- arbitrary workflow outputs as destructive-resource authority;
- SDK-owned lifecycle-run/attempt state, durable land-fact materialization, retry authority, or provider-result reconciliation.

Strict parsing rejects additional fields or step kinds rather than silently accepting them. Provider-specific execution configuration and lifecycle authority belong behind Trunk's integration/control-plane boundaries rather than in this workflow contract.

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

The repository merge-gate path is:

```sh
./validate.sh
```

The package has no runtime dependencies today. Keep additions provider-neutral and preserve V1 compatibility unless a separately reviewed public contract change says otherwise.

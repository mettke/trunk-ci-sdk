# Trunk CI SDK

Public TypeScript SDK and contract for defining provider-neutral Trunk CI workflows without YAML.

This repository is the authoring/composition side of Trunk CI. Repository code produces a plain workflow plan; the Trunk control plane remains authoritative and independently validates the submitted plan, recomputes its canonical representation and digest, selects the lifecycle workflow, binds execution and evidence to the exact immutable source revision, and applies the CI lifecycle rules.

> **Pre-release:** the package is currently version `0.0.0`, and the npm package name `trunk-ci-sdk` is provisional. Do not treat the current package name or distribution path as a stable compatibility promise yet.

## Quick start

A repository's workflow entry is the fixed candidate-owned `trunk-ci.ts` path. It must default-export one workflow plan.

### WorkflowPlanV1: one candidate workflow

V1 remains fully supported. It represents one candidate workflow as a map of jobs:

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

This resolves to:

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

In V1, job names are labels inside the single candidate workflow. They are not independent workflow/check identities.

### WorkflowPlanV2: independently named lifecycle workflows

V2 adds globally named workflows. Each workflow has exactly one lifecycle trigger and its own internal jobs:

```ts
import { checkout, job, run, workflowV2 } from 'trunk-ci-sdk';

export default workflowV2({
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
});
```

The corresponding data plan is:

```json
{
  "version": 2,
  "workflows": {
    "Candidate CI": {
      "trigger": "candidate",
      "jobs": {
        "test": {
          "steps": [
            { "kind": "checkout" },
            { "kind": "run", "command": "npm ci" },
            { "kind": "run", "command": "npm test" }
          ]
        }
      }
    },
    "Post-land verification": {
      "trigger": "landed",
      "jobs": {
        "verify": {
          "steps": [
            { "kind": "checkout" },
            { "kind": "run", "command": "npm ci" },
            { "kind": "run", "command": "npm run verify" }
          ]
        }
      }
    },
    "Cleanup": {
      "trigger": "cleanup",
      "jobs": {
        "cleanup": {
          "steps": [
            { "kind": "checkout" },
            { "kind": "run", "command": "npm run cleanup" }
          ]
        }
      }
    }
  }
}
```

The workflow name is the independent scheduling/result/retry identity. Jobs remain internal execution units of that workflow. V2 intentionally does not introduce a workflow DAG, matrix expansion, conditions, cross-workflow dependencies, fan-in/fan-out, or provider-specific execution configuration.

## Lifecycle triggers and source authority

Every V2 workflow declares exactly one trigger:

- `candidate`: runs for an exact immutable candidate revision. A configured required candidate workflow maps by its **workflow name** to Trunk's `CheckRequirement` / `CheckRun` identity for that exact candidate. Multiple required candidate workflows are independent gates; one workflow's success does not substitute for another.
- `landed`: describes post-land CI for the exact SHA that actually won landing. Its source authority is that exact landed SHA, not whichever commit a mutable default branch points to later. It is post-land lifecycle evidence, not a candidate landing gate.
- `cleanup`: describes generic post-land cleanup workflow code. It is materialized independently from the durable land fact and does not gate or undo landing. Destructive resource authority does not come from arbitrary workflow output or branch names; Trunk's trusted integration/capability boundaries remain authoritative.

The SDK only expresses those trigger declarations. It does not create lifecycle runs, select which workflow to execute, decide which candidate workflows are required, materialize landed facts, authorize cleanup, or reconcile provider results.

`checkout()` is not a branch/ref selector. It means “materialize the exact immutable repository source already bound by Trunk to this workflow attempt.” For `candidate` that source is the exact candidate SHA. For post-land lifecycle work the authority is the exact landed SHA associated with the durable land fact, never a later mutable branch head.

## Where authority lives

Treat `trunk-ci.ts` and this SDK as an authoring frontend. Repository-authored TypeScript is evaluated only in the bounded workflow-resolution sandbox, not inside the Trunk control-plane process. The resolver imports the exact revision's `trunk-ci.ts`, requires a default export, serializes that value as JSON, and passes the bounded result across the trust boundary. Trunk then independently parses, validates, normalizes and canonicalizes it.

The bare `trunk-ci-sdk` import is part of that runtime boundary. During workflow resolution Trunk supplies its trusted SDK runtime for the exact bare module specifier. Candidate dependencies do not choose or replace the SDK implementation used by the resolver. The repository package remains the public TypeScript authoring/reference surface; it is not runtime authority.

Important consequences:

- **Repository-owned definition:** the workflow definition travels with immutable repository source instead of being selected from a mutable branch after dispatch.
- **Provider-neutral plan:** provider pipeline, queue, image, executor, webhook, credential, routing and deployment-provider identifiers are not part of the workflow syntax.
- **No ambient secret declaration:** repository workflow syntax does not grant privileged credentials or destructive authority.
- **Strict/fail-closed data shape:** unknown fields, unknown triggers/step kinds, missing required fields, malformed objects, empty workflow/job/step collections and empty run commands are rejected.
- **Trunk re-validates:** successful SDK construction or parsing is convenient authoring feedback, not authorization and not proof that Trunk will accept or execute the plan.
- **Canonicalization is deterministic:** object keys are serialized lexicographically; workflow/job map insertion order does not change the canonical representation or digest. Array order remains semantic, so step order does matter.
- **Digest is correlation/audit identity:** `workflowPlanDigest()` identifies canonical plan data. It is not candidate, landing, lifecycle, secret, provider, or destructive authority.

## Workflow and job identity

V1 and V2 deliberately differ here:

- **V1:** the plan itself is one candidate workflow; `jobs` are its internal jobs. A V1 job name is not a V2 workflow/check identity.
- **V2:** each key in `workflows` is a globally unique workflow name after normalization. That workflow is the independent scheduling/result/retry/cancellation unit. Its nested job names are internal to that workflow.
- **Candidate checks:** only a V2 `candidate` workflow name maps 1:1 to the configured Trunk `CheckRequirement` / `CheckRun` name. `landed` and `cleanup` are distinct non-landing lifecycle evidence paths and do not weaken candidate CheckRun semantics.

V2 workflow names and V2 job names are trimmed, non-empty, at most 120 UTF-16 code units, must not contain NUL and must be well-formed UTF-16. Well-formed supplementary Unicode and embedded CR/LF are valid. Names that collide after trimming are rejected. V1 retains its existing job-name semantics for compatibility.

## Steps

Both versions currently reuse the same job/step contract.

### `checkout(): CheckoutStepV1`

Creates a frozen checkout step for the exact source already bound to the workflow attempt. It takes no ref, branch, repository, provider, queue, image or credential argument.

### `run(command: string): RunStepV1`

Creates a frozen run step. `command` must contain non-whitespace text. The command is preserved as authored.

A run step must execute after checkout in the same job. This is an execution rule rather than a data-shape rule: `parseWorkflowPlan()` can accept a plan whose first step is `run`, but the executor fails that job when it attempts to run without a preceding checkout.

### `job(steps: readonly WorkflowStepV1[]): JobPlanV1`

Builds and validates one frozen job with at least one supported step.

## Plan helpers

### `workflow(jobs): WorkflowPlanV1`

Builds the legacy V1 single-candidate-workflow plan. This API and its canonical/digest behavior remain compatible.

### `workflowV2(workflows): WorkflowPlanV2`

Builds a V2 plan. `workflows` is a record whose keys are workflow names and whose values contain exactly:

```ts
{
  trigger: 'candidate' | 'landed' | 'cleanup';
  jobs: Record<string, JobPlanV1>;
}
```

At least one named workflow is required, and every named workflow must contain at least one job.

## Parsing, canonicalization and digest

### `parseWorkflowPlan(input: unknown): WorkflowPlan`

Strictly validates unknown V1 or V2 input and returns a normalized frozen plan. The parser requires exact object keys rather than silently ignoring additions. That prevents a producer and consumer from disagreeing about fields one side ignored.

Validation throws `WorkflowValidationError`. The current class has no stable machine-readable error code; callers should distinguish SDK validation failures by class rather than parsing message text.

The public parser mirrors the current authoring contract so authors get early feedback. It is still not Trunk's trust boundary: Trunk independently parses and validates resolver output before that output can affect scheduling, evidence, checks or lifecycle state.

### `canonicalWorkflowPlan(input: unknown): string`

Validates the input and returns deterministic compact JSON. Object keys are sorted lexicographically at every level. Arrays preserve order.

### `workflowPlanDigest(input: unknown): Promise<string>`

Validates and canonicalizes the input, then returns the lowercase SHA-256 digest of UTF-8 canonical JSON as a 64-character hexadecimal string using Web Crypto.

For identical valid V1 or V2 plans, SDK canonicalization/digest is required to match Trunk canonicalization/digest. Trunk still recomputes both itself rather than trusting SDK-provided output.

## Public API reference

Everything exported from `src/index.ts` is part of the current pre-release public surface.

### Constants

- `WORKFLOW_PLAN_VERSION`: literal `1`, retained for V1.
- `WORKFLOW_PLAN_V2_VERSION`: literal `2`.

### Types

```ts
type CheckoutStepV1 = Readonly<{ kind: 'checkout' }>;

type RunStepV1 = Readonly<{
  kind: 'run';
  command: string;
}>;

type WorkflowStepV1 = CheckoutStepV1 | RunStepV1;

type JobPlanV1 = Readonly<{
  steps: readonly WorkflowStepV1[];
}>;

type WorkflowPlanV1 = Readonly<{
  version: typeof WORKFLOW_PLAN_VERSION;
  jobs: Readonly<Record<string, JobPlanV1>>;
}>;

type WorkflowTriggerV2 = 'candidate' | 'landed' | 'cleanup';

type NamedWorkflowPlanV2 = Readonly<{
  trigger: WorkflowTriggerV2;
  jobs: Readonly<Record<string, JobPlanV1>>;
}>;

type WorkflowPlanV2 = Readonly<{
  version: typeof WORKFLOW_PLAN_V2_VERSION;
  workflows: Readonly<Record<string, NamedWorkflowPlanV2>>;
}>;

type WorkflowPlan = WorkflowPlanV1 | WorkflowPlanV2;
```

`WorkflowValidationError` is the `Error` subclass used for SDK data-shape validation failures.

## Canonicalization example

Object/map insertion order is not semantic:

```ts
import { canonicalWorkflowPlan, workflowPlanDigest, workflowV2 } from 'trunk-ci-sdk';

const first = workflowV2({
  Beta: { trigger: 'candidate', jobs: { test: { steps: [{ kind: 'checkout' }] } } },
  Alpha: { trigger: 'candidate', jobs: { build: { steps: [{ kind: 'checkout' }] } } },
});

const second = workflowV2({
  Alpha: { trigger: 'candidate', jobs: { build: { steps: [{ kind: 'checkout' }] } } },
  Beta: { trigger: 'candidate', jobs: { test: { steps: [{ kind: 'checkout' }] } } },
});

canonicalWorkflowPlan(first) === canonicalWorkflowPlan(second); // true
await workflowPlanDigest(first) === await workflowPlanDigest(second); // true
```

Arrays are semantic. Reordering steps changes canonical data and the digest, and may also change execution validity.

## Intentional exclusions

The current public workflow language does **not** include:

- execution-provider queue/image/executor or hosted-agent identifiers;
- deployment-provider identifiers;
- ambient secret declarations or secret authority;
- workflow DAG edges, matrices, conditions, fan-in/fan-out or cross-workflow dependencies;
- repository-authored selection of which workflows are required;
- arbitrary workflow outputs as destructive-resource authority;
- SDK-side lifecycle-run state, landed-fact materialization, retry authority or result reconciliation.

Those omissions are deliberate. The SDK describes provider-neutral workflow intent; Trunk owns the trusted lifecycle and integration boundaries.

## Development and validation

Node.js 22.18 or later is required by the package and for native TypeScript execution in the test runner.

From a clean checkout:

```sh
npm install
npm run check
npm run build
```

The repository's merge-gate path is:

```sh
./validate.sh
```

The package has no runtime dependencies today. Keep additions provider-neutral and preserve V1 compatibility unless a separately reviewed public contract change says otherwise.

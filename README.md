# Trunk CI SDK

Public TypeScript SDK and contract for defining provider-neutral Trunk CI workflows without YAML.

This repository is the authoring/composition side of Trunk CI. Repository code produces a plain workflow plan; the Trunk control plane remains authoritative and independently validates the submitted plan, recomputes its canonical representation and digest, selects the lifecycle workflow, binds execution/evidence to the exact immutable source revision, and applies CI lifecycle rules.

> **Pre-release:** the package is currently version `0.0.0`, and the npm package name `trunk-ci-sdk` is provisional. Do not treat the current package name or distribution path as a stable compatibility promise yet.

## V1: one candidate workflow

A repository's fixed workflow entry is `trunk-ci.ts`. WorkflowPlanV1 remains fully supported and represents one candidate workflow containing jobs:

```ts
import { checkout, job, run, workflow } from 'trunk-ci-sdk';

export default workflow({
  test: job([
    checkout(),
    run('npm ci'),
    run('npm test'),
  ]),
});
```

V1 job names are labels inside that single candidate workflow. They are not independent workflow/check identities.

## V2: independently named lifecycle workflows

WorkflowPlanV2 adds globally named workflows. Each workflow has exactly one trigger and its own internal jobs.

The current trusted Trunk resolver supplies the existing runtime helpers `checkout`, `job`, and `run`. V2's new top-level structure is therefore authored as typed data rather than through a new runtime helper:

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

`WorkflowPlanV2` is:

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

The workflow name is the independent scheduling/result/retry/cancellation identity. Jobs remain internal execution units of that workflow. V2 intentionally does not introduce a workflow DAG, matrix expansion, conditions, cross-workflow dependencies, fan-in/fan-out, or provider-specific execution configuration.

### Why there is no `workflowV2()` runtime helper

Inside candidate workflow resolution, Trunk intercepts the bare `trunk-ci-sdk` module specifier and supplies a trusted resolver runtime instead of executing a candidate-selected SDK implementation. That trusted runtime currently exposes the established V1-era runtime helpers such as `checkout`, `run`, and `job`, while authoritative Trunk parsing already accepts WorkflowPlanV2 data.

A type-only `WorkflowPlanV2` import is erased before runtime and therefore does not require a new trusted resolver export. Publishing a `workflowV2()` helper before Trunk's trusted resolver runtime exposes it would make package typechecking succeed while real `trunk-ci.ts` resolution fails, so this SDK deliberately does not promise such a helper today.

This is a runtime-boundary constraint, not a second workflow contract: the V2 data contract remains the one Trunk validates authoritatively.

## Lifecycle semantics

Every V2 workflow declares exactly one trigger:

- `candidate`: runs for an exact immutable candidate revision. A configured required candidate workflow maps by its **workflow name** to Trunk's `CheckRequirement` / `CheckRun` identity for that exact candidate. Multiple required candidate workflows are independent gates; one workflow's success does not substitute for another.
- `landed`: describes post-land CI for the exact SHA that actually won landing. Its source authority is that exact landed SHA, not whichever commit a mutable default branch points to later. It is post-land lifecycle evidence, not a candidate landing gate.
- `cleanup`: describes generic post-land cleanup workflow code. It materializes independently from the durable land fact and does not gate or undo landing. Destructive resource authority does not come from arbitrary workflow output or branch names; Trunk's trusted integration/capability boundary remains authoritative.

The SDK expresses those declarations only. It does not decide which candidate workflows are required, create lifecycle runs, materialize land facts, select execution-provider configuration, authorize destructive cleanup, or reconcile provider results.

`checkout()` is not a branch/ref selector. It means “materialize the exact immutable repository source already bound by Trunk to this workflow attempt.” Candidate work binds the exact candidate SHA; post-land lifecycle authority is the exact landed SHA associated with the durable land fact.

## Workflow and job identity

- **V1:** the plan itself is one candidate workflow; `jobs` are internal job labels.
- **V2:** each key in `workflows` is a globally unique workflow name after normalization. That workflow is the independent scheduling/result/retry/cancellation unit; nested jobs remain internal.
- **Candidate checks:** a V2 `candidate` workflow name maps 1:1 to the configured Trunk `CheckRequirement` / `CheckRun` name. `landed` and `cleanup` use distinct non-landing lifecycle evidence and do not weaken candidate CheckRun semantics.

V2 workflow names and V2 job names are trimmed, non-empty, at most 120 UTF-16 code units, must not contain NUL, and must be well-formed UTF-16. Well-formed supplementary Unicode and embedded CR/LF remain valid. Names that collide after trimming are rejected. V1 retains its existing job-name semantics for compatibility.

## Public helpers

### `checkout(): CheckoutStepV1`

Creates a checkout step for the exact source already bound to the attempt. It takes no ref, branch, repository, provider, queue, image, executor or credential argument.

### `run(command: string): RunStepV1`

Creates a run step. `command` must contain non-whitespace text and is preserved as authored.

A `run()` step requires a preceding `checkout()` in the same job. The SDK data parser accepts step order as authored, but the real executor fails a job if it reaches `run()` before checkout. Put `checkout()` before the first `run()` in every executable job.

### `job(steps): JobPlanV1`

Builds one job with at least one supported step. Both V1 and V2 reuse this job/step contract. `job()` validates the data shape but does not replace the executor's checkout-before-run requirement above.

### `workflow(jobs): WorkflowPlanV1`

Builds the legacy V1 single-candidate-workflow plan. Its existing behavior and canonical digest remain unchanged.

There is intentionally no V2 top-level runtime builder at present; use the typed V2 data form shown above.

## Parsing, canonicalization and digest

### `parseWorkflowPlan(input: unknown): WorkflowPlan`

Strictly validates unknown V1 or V2 data and returns a normalized frozen plan. It requires exact object keys rather than silently ignoring additions. Validation throws `WorkflowValidationError`.

This package-side parser is author tooling, not runtime authority. Trunk independently parses resolver output at its trust boundary before that output can affect scheduling, evidence, checks or lifecycle state.

### `canonicalWorkflowPlan(input: unknown): string`

Validates the input and returns deterministic compact JSON. Object keys are sorted lexicographically at every level; arrays preserve order.

### `workflowPlanDigest(input: unknown): Promise<string>`

Validates and canonicalizes the input, then returns the lowercase SHA-256 digest of UTF-8 canonical JSON as 64 hexadecimal characters.

For identical valid V1 or V2 plans, SDK canonicalization/digest must match Trunk canonicalization/digest. Trunk recomputes both itself rather than trusting SDK-provided output. The digest is correlation/audit identity only; it is not candidate, landing, lifecycle, provider, secret or destructive authority.

## Trust boundary and provider neutrality

Treat `trunk-ci.ts` and this SDK as an authoring frontend. Repository-authored TypeScript runs only in the bounded workflow-resolution sandbox. Trunk receives serialized data and independently validates and canonicalizes it.

Important consequences:

- repository workflow definition is revision-owned through the fixed `trunk-ci.ts` path;
- Buildkite or other provider pipeline/queue/image/executor/webhook/credential/routing details are not part of WorkflowPlanV2;
- deployment-provider IDs are not part of WorkflowPlanV2;
- repository syntax does not grant ambient privileged secrets or destructive authority;
- unknown fields/triggers/step kinds and malformed or empty structures fail closed;
- successful SDK parsing/typechecking is author feedback, not Trunk authorization;
- no workflow DAG, matrix, conditions, fan-in/fan-out, cross-workflow dependency language or arbitrary destructive outputs are introduced by V2;
- SDK helpers do not replace Trunk's strict validation, workflow selection, lifecycle state, source authority or check semantics.

## Public types

The public type surface includes:

- `CheckoutStepV1`
- `RunStepV1`
- `WorkflowStepV1`
- `JobPlanV1`
- `WorkflowPlanV1`
- `WorkflowTriggerV2`
- `NamedWorkflowPlanV2`
- `WorkflowPlanV2`
- `WorkflowPlan` (`WorkflowPlanV1 | WorkflowPlanV2`)

`WORKFLOW_PLAN_VERSION` remains the V1 runtime constant for compatibility. V2 uses the literal discriminant `version: 2` in its type so repository-authored V2 does not need a new runtime export from the trusted resolver SDK shim.

## Development and validation

Node.js 22.18 or later is required by the package and for native TypeScript execution in the test runner.

From a clean checkout:

```sh
npm install
npm run check
npm run build
```

The repository merge-gate path is:

```sh
./validate.sh
```

The package has no runtime dependencies today. Keep additions provider-neutral and preserve V1 compatibility unless a separately reviewed public contract change says otherwise.

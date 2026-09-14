export const WORKFLOW_PLAN_VERSION = 1 as const;
const WORKFLOW_PLAN_V2_VERSION = 2 as const;

export type CheckoutStepV1 = Readonly<{
  kind: 'checkout';
}>;

export type RunStepV1 = Readonly<{
  kind: 'run';
  command: string;
}>;

export type WorkflowStepV1 = CheckoutStepV1 | RunStepV1;

export type JobPlanV1 = Readonly<{
  steps: readonly WorkflowStepV1[];
}>;

export type WorkflowPlanV1 = Readonly<{
  version: typeof WORKFLOW_PLAN_VERSION;
  jobs: Readonly<Record<string, JobPlanV1>>;
}>;

export type WorkflowTriggerV2 = 'candidate' | 'landed' | 'cleanup';

export type NamedWorkflowPlanV2 = Readonly<{
  trigger: WorkflowTriggerV2;
  jobs: Readonly<Record<string, JobPlanV1>>;
}>;

export type WorkflowPlanV2 = Readonly<{
  version: 2;
  workflows: Readonly<Record<string, NamedWorkflowPlanV2>>;
}>;

export type WorkflowPlan = WorkflowPlanV1 | WorkflowPlanV2;

export class WorkflowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowValidationError';
  }
}

export function checkout(): CheckoutStepV1 {
  return Object.freeze({ kind: 'checkout' });
}

export function run(command: string): RunStepV1 {
  if (typeof command !== 'string' || !command.trim()) {
    throw new WorkflowValidationError('run command must not be empty');
  }
  return Object.freeze({ kind: 'run', command });
}

export function job(steps: readonly WorkflowStepV1[]): JobPlanV1 {
  return parseJob({ steps }, 'job');
}

/** Build the legacy single-candidate-workflow V1 plan. */
export function workflow(jobs: Readonly<Record<string, JobPlanV1>>): WorkflowPlanV1 {
  return parseWorkflowPlanV1({ version: WORKFLOW_PLAN_VERSION, jobs });
}

/**
 * Authoring-side strict parser for the public data contract.
 * Trunk independently re-parses and canonicalizes resolver output at its trust boundary.
 */
export function parseWorkflowPlan(input: unknown): WorkflowPlan {
  const value = asRecord(input, 'workflow');
  if (value.version === WORKFLOW_PLAN_VERSION) return parseWorkflowPlanV1(value);
  if (value.version === WORKFLOW_PLAN_V2_VERSION) return parseWorkflowPlanV2(value);
  throw new WorkflowValidationError(
    `workflow version must be ${WORKFLOW_PLAN_VERSION} or ${WORKFLOW_PLAN_V2_VERSION}`,
  );
}

export function canonicalWorkflowPlan(input: unknown): string {
  return canonicalJson(parseWorkflowPlan(input));
}

export async function workflowPlanDigest(input: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalWorkflowPlan(input));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parseWorkflowPlanV1(value: Record<string, unknown>): WorkflowPlanV1 {
  assertExactKeys(value, ['version', 'jobs'], 'workflow');
  if (value.version !== WORKFLOW_PLAN_VERSION) {
    throw new WorkflowValidationError(`workflow version must be ${WORKFLOW_PLAN_VERSION}`);
  }
  const jobs = parseJobs(value.jobs, 'workflow.jobs', 'workflow must contain at least one job');
  return Object.freeze({
    version: WORKFLOW_PLAN_VERSION,
    jobs,
  });
}

function parseWorkflowPlanV2(value: Record<string, unknown>): WorkflowPlanV2 {
  assertExactKeys(value, ['version', 'workflows'], 'workflow');
  if (value.version !== WORKFLOW_PLAN_V2_VERSION) {
    throw new WorkflowValidationError(`workflow version must be ${WORKFLOW_PLAN_V2_VERSION}`);
  }

  const workflowsInput = asRecord(value.workflows, 'workflow.workflows');
  const names = Object.keys(workflowsInput);
  if (!names.length) throw new WorkflowValidationError('workflow must contain at least one named workflow');

  const workflows: Record<string, NamedWorkflowPlanV2> = {};
  for (const rawName of names) {
    const name = normalizeWorkflowName(rawName);
    if (Object.hasOwn(workflows, name)) {
      throw new WorkflowValidationError(`duplicate workflow ${JSON.stringify(name)} after normalization`);
    }
    const label = `workflow.workflows[${JSON.stringify(rawName)}]`;
    const workflow = asRecord(workflowsInput[rawName], label);
    assertExactKeys(workflow, ['trigger', 'jobs'], label);
    Object.defineProperty(workflows, name, {
      value: Object.freeze({
        trigger: parseTrigger(workflow.trigger, `${label}.trigger`),
        jobs: parseJobs(workflow.jobs, `${label}.jobs`, undefined, true),
      }),
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }

  return Object.freeze({
    version: WORKFLOW_PLAN_V2_VERSION,
    workflows: Object.freeze(workflows),
  });
}

function parseJobs(
  input: unknown,
  label: string,
  emptyMessage = `${label} must contain at least one job`,
  requireTransportSafeName = false,
): Readonly<Record<string, JobPlanV1>> {
  const jobsInput = asRecord(input, label);
  const names = Object.keys(jobsInput);
  if (!names.length) throw new WorkflowValidationError(emptyMessage);

  const jobs: Record<string, JobPlanV1> = {};
  for (const rawName of names) {
    const name = requireTransportSafeName
      ? normalizeV2JobName(rawName)
      : normalizeName(rawName, 'workflow job name');
    if (Object.hasOwn(jobs, name)) {
      throw new WorkflowValidationError(`duplicate workflow job ${JSON.stringify(name)} after normalization`);
    }
    Object.defineProperty(jobs, name, {
      value: parseJob(jobsInput[rawName], `${label}[${JSON.stringify(rawName)}]`),
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(jobs);
}

function parseTrigger(input: unknown, label: string): WorkflowTriggerV2 {
  if (input === 'candidate' || input === 'landed' || input === 'cleanup') return input;
  throw new WorkflowValidationError(`${label} must be one of "candidate", "landed", or "cleanup"`);
}

function parseJob(input: unknown, label: string): JobPlanV1 {
  const value = asRecord(input, label);
  assertExactKeys(value, ['steps'], label);
  if (!Array.isArray(value.steps) || !value.steps.length) {
    throw new WorkflowValidationError(`${label}.steps must contain at least one step`);
  }

  const steps: WorkflowStepV1[] = [];
  for (let index = 0; index < value.steps.length; index += 1) {
    if (!Object.hasOwn(value.steps, index)) {
      throw new WorkflowValidationError(`${label}.steps[${index}] is missing`);
    }
    steps.push(parseStep(value.steps[index], `${label}.steps[${index}]`));
  }

  return Object.freeze({
    steps: Object.freeze(steps),
  });
}

function parseStep(input: unknown, label: string): WorkflowStepV1 {
  const value = asRecord(input, label);
  if (value.kind === 'checkout') {
    assertExactKeys(value, ['kind'], label);
    return checkout();
  }
  if (value.kind === 'run') {
    assertExactKeys(value, ['kind', 'command'], label);
    if (typeof value.command !== 'string' || !value.command.trim()) {
      throw new WorkflowValidationError(`${label}.command must not be empty`);
    }
    return Object.freeze({ kind: 'run', command: value.command });
  }
  throw new WorkflowValidationError(`${label}.kind is not supported`);
}

function normalizeWorkflowName(value: string): string {
  const name = normalizeName(value, 'workflow name');
  if (name.includes('\0')) throw new WorkflowValidationError('workflow name must not contain NUL');
  if (!isWellFormedUtf16(name)) throw new WorkflowValidationError('workflow name must be well-formed Unicode');
  return name;
}

function normalizeV2JobName(value: string): string {
  const name = normalizeName(value, 'workflow job name');
  if (name.includes('\0')) throw new WorkflowValidationError('WorkflowPlanV2 job name must not contain NUL');
  if (!isWellFormedUtf16(name)) {
    throw new WorkflowValidationError('WorkflowPlanV2 job name must be well-formed Unicode');
  }
  return name;
}

function normalizeName(value: string, label: string): string {
  const name = value.trim();
  if (!name) throw new WorkflowValidationError(`${label} must not be empty`);
  if (name.length > 120) throw new WorkflowValidationError(`${label} is too long`);
  return name;
}

function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return false;
  }
  return true;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkflowValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const extra = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (extra.length) {
    throw new WorkflowValidationError(`${label} contains unsupported field ${JSON.stringify(extra[0])}`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) {
      throw new WorkflowValidationError(`${label} is missing required field ${JSON.stringify(key)}`);
    }
  }
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new WorkflowValidationError('canonical workflow values must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new WorkflowValidationError('canonical workflow contains a non-JSON value');
}

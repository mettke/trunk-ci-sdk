export const WORKFLOW_PLAN_VERSION = 1 as const;

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

export function workflow(jobs: Readonly<Record<string, JobPlanV1>>): WorkflowPlanV1 {
  return parseWorkflowPlan({ version: WORKFLOW_PLAN_VERSION, jobs });
}

export function parseWorkflowPlan(input: unknown): WorkflowPlanV1 {
  const value = asRecord(input, 'workflow');
  assertExactKeys(value, ['version', 'jobs'], 'workflow');
  if (value.version !== WORKFLOW_PLAN_VERSION) {
    throw new WorkflowValidationError(`workflow version must be ${WORKFLOW_PLAN_VERSION}`);
  }

  const jobsInput = asRecord(value.jobs, 'workflow.jobs');
  const names = Object.keys(jobsInput);
  if (!names.length) throw new WorkflowValidationError('workflow must contain at least one job');

  const jobs: Record<string, JobPlanV1> = {};
  for (const rawName of names) {
    const name = normalizeCheckName(rawName);
    if (Object.hasOwn(jobs, name)) {
      throw new WorkflowValidationError(`duplicate workflow job ${JSON.stringify(name)} after normalization`);
    }
    Object.defineProperty(jobs, name, {
      value: parseJob(jobsInput[rawName], `workflow.jobs[${JSON.stringify(rawName)}]`),
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }

  return Object.freeze({
    version: WORKFLOW_PLAN_VERSION,
    jobs: Object.freeze(jobs),
  });
}

export function canonicalWorkflowPlan(input: unknown): string {
  return canonicalJson(parseWorkflowPlan(input));
}

export async function workflowPlanDigest(input: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalWorkflowPlan(input));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parseJob(input: unknown, label: string): JobPlanV1 {
  const value = asRecord(input, label);
  assertExactKeys(value, ['steps'], label);
  if (!Array.isArray(value.steps) || !value.steps.length) {
    throw new WorkflowValidationError(`${label}.steps must contain at least one step`);
  }

  return Object.freeze({
    steps: Object.freeze(value.steps.map((step, index) => parseStep(step, `${label}.steps[${index}]`))),
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

function normalizeCheckName(value: string): string {
  const name = value.trim();
  if (!name) throw new WorkflowValidationError('workflow job name must not be empty');
  if (name.length > 120) throw new WorkflowValidationError('workflow job name is too long');
  return name;
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

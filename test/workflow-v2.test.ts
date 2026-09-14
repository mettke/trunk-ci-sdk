import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalWorkflowPlan,
  checkout,
  job,
  parseWorkflowPlan,
  run,
  workflowPlanDigest,
  type WorkflowPlanV2,
} from '../src/index.ts';

function authoredV2Plan(): WorkflowPlanV2 {
  return {
    version: 2,
    workflows: {
      'Candidate CI': {
        trigger: 'candidate',
        jobs: {
          test: job([checkout(), run('npm test')]),
          lint: job([checkout(), run('npm run lint')]),
        },
      },
      'Post-land verification': {
        trigger: 'landed',
        jobs: { verify: job([checkout(), run('npm run verify')]) },
      },
      Cleanup: {
        trigger: 'cleanup',
        jobs: { cleanup: job([checkout(), run('npm run cleanup')]) },
      },
    },
  } satisfies WorkflowPlanV2;
}

test('authors candidate, landed and cleanup workflows as the V2 data contract', () => {
  assert.deepEqual(authoredV2Plan(), {
    version: 2,
    workflows: {
      'Candidate CI': {
        trigger: 'candidate',
        jobs: {
          test: { steps: [{ kind: 'checkout' }, { kind: 'run', command: 'npm test' }] },
          lint: { steps: [{ kind: 'checkout' }, { kind: 'run', command: 'npm run lint' }] },
        },
      },
      'Post-land verification': {
        trigger: 'landed',
        jobs: { verify: { steps: [{ kind: 'checkout' }, { kind: 'run', command: 'npm run verify' }] } },
      },
      Cleanup: {
        trigger: 'cleanup',
        jobs: { cleanup: { steps: [{ kind: 'checkout' }, { kind: 'run', command: 'npm run cleanup' }] } },
      },
    },
  });
});

test('pins the canonical v2 representation and digest to Trunk parity', async () => {
  const plan = authoredV2Plan();

  assert.equal(
    canonicalWorkflowPlan(plan),
    '{"version":2,"workflows":{"Candidate CI":{"jobs":{"lint":{"steps":[{"kind":"checkout"},{"command":"npm run lint","kind":"run"}]},"test":{"steps":[{"kind":"checkout"},{"command":"npm test","kind":"run"}]}},"trigger":"candidate"},"Cleanup":{"jobs":{"cleanup":{"steps":[{"kind":"checkout"},{"command":"npm run cleanup","kind":"run"}]}},"trigger":"cleanup"},"Post-land verification":{"jobs":{"verify":{"steps":[{"kind":"checkout"},{"command":"npm run verify","kind":"run"}]}},"trigger":"landed"}}}',
  );
  assert.equal(await workflowPlanDigest(plan), '0aca9e5c5ebf3c2892de3a66fc713964a8511d437ede26503fd52fdaf46f92e8');
});

test('v2 canonical form is independent of workflow and job insertion order', async () => {
  const first: WorkflowPlanV2 = {
    version: 2,
    workflows: {
      Beta: { trigger: 'candidate', jobs: { test: job([checkout()]), lint: job([checkout()]) } },
      Alpha: { trigger: 'candidate', jobs: { build: job([checkout()]) } },
    },
  };
  const second: WorkflowPlanV2 = {
    version: 2,
    workflows: {
      Alpha: { trigger: 'candidate', jobs: { build: job([checkout()]) } },
      Beta: { trigger: 'candidate', jobs: { lint: job([checkout()]), test: job([checkout()]) } },
    },
  };

  assert.equal(canonicalWorkflowPlan(first), canonicalWorkflowPlan(second));
  assert.equal(await workflowPlanDigest(first), await workflowPlanDigest(second));
});

test('parser normalizes v2 workflow and job names and rejects normalized duplicates', () => {
  const plan = parseWorkflowPlan({
    version: 2,
    workflows: {
      '  Candidate CI  ': {
        trigger: 'candidate',
        jobs: { '  test  ': job([checkout()]) },
      },
    },
  });
  assert.equal(plan.version, 2);
  if (plan.version !== 2) assert.fail('expected WorkflowPlanV2');
  assert.deepEqual(Object.keys(plan.workflows), ['Candidate CI']);
  assert.deepEqual(Object.keys(plan.workflows['Candidate CI']?.jobs ?? {}), ['test']);

  assert.throws(
    () =>
      parseWorkflowPlan({
        version: 2,
        workflows: {
          Test: { trigger: 'candidate', jobs: { test: job([checkout()]) } },
          ' Test ': { trigger: 'candidate', jobs: { test: job([checkout()]) } },
        },
      }),
    /duplicate workflow "Test" after normalization/,
  );
});

test('v2 workflow and job identities reject transport-unsafe Unicode while allowing CRLF and supplementary Unicode', () => {
  assert.throws(
    () =>
      parseWorkflowPlan({
        version: 2,
        workflows: { ['bad\0name']: { trigger: 'candidate', jobs: { test: job([checkout()]) } } },
      }),
    /workflow name must not contain NUL/,
  );
  assert.throws(
    () =>
      parseWorkflowPlan({
        version: 2,
        workflows: { ['bad\ud800']: { trigger: 'candidate', jobs: { test: job([checkout()]) } } },
      }),
    /workflow name must be well-formed Unicode/,
  );
  assert.throws(
    () =>
      parseWorkflowPlan({
        version: 2,
        workflows: { Test: { trigger: 'candidate', jobs: { ['bad\udc00']: job([checkout()]) } } },
      }),
    /WorkflowPlanV2 job name must be well-formed Unicode/,
  );

  const plan = parseWorkflowPlan({
    version: 2,
    workflows: {
      'Candidate\r\n🚀': { trigger: 'candidate', jobs: { 'test\r\n🧪': job([checkout()]) } },
    },
  });
  if (plan.version !== 2) assert.fail('expected WorkflowPlanV2');
  assert.equal(Object.hasOwn(plan.workflows, 'Candidate\r\n🚀'), true);
  assert.equal(Object.hasOwn(plan.workflows['Candidate\r\n🚀']?.jobs ?? {}, 'test\r\n🧪'), true);
});

test('parser rejects unsupported v2 triggers and provider-specific fields', () => {
  assert.throws(
    () =>
      parseWorkflowPlan({
        version: 2,
        workflows: { Test: { trigger: 'manual', jobs: { test: { steps: [{ kind: 'checkout' }] } } } },
      }),
    /must be one of "candidate", "landed", or "cleanup"/,
  );
  assert.throws(
    () =>
      parseWorkflowPlan({
        version: 2,
        workflows: {
          Test: {
            trigger: 'candidate',
            jobs: { test: { steps: [{ kind: 'checkout' }] } },
            queue: 'fast',
          },
        },
      }),
    /unsupported field "queue"/,
  );
});

test('parser keeps special v2 names safe while returning plain maps', () => {
  const plan = parseWorkflowPlan({
    version: 2,
    workflows: {
      ['__proto__']: { trigger: 'candidate', jobs: { ['__proto__']: job([checkout()]) } },
    },
  });
  if (plan.version !== 2) assert.fail('expected WorkflowPlanV2');
  assert.equal(Object.getPrototypeOf(plan.workflows), Object.prototype);
  assert.equal(Object.hasOwn(plan.workflows, '__proto__'), true);
  assert.equal(Object.hasOwn(plan.workflows.__proto__?.jobs ?? {}, '__proto__'), true);
});

test('empty v2 workflows and jobs fail closed', () => {
  assert.throws(() => parseWorkflowPlan({ version: 2, workflows: {} }), /at least one named workflow/);
  assert.throws(
    () => parseWorkflowPlan({ version: 2, workflows: { Test: { trigger: 'candidate', jobs: {} } } }),
    /at least one job/,
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WorkflowValidationError,
  canonicalWorkflowPlan,
  checkout,
  job,
  parseWorkflowPlan,
  run,
  workflow,
  workflowV2,
  workflowPlanDigest,
} from '../src/index.ts';

test('builds the minimal v1 workflow plan', () => {
  assert.deepEqual(
    workflow({
      test: job([checkout(), run('npm test')]),
    }),
    {
      version: 1,
      jobs: {
        test: {
          steps: [{ kind: 'checkout' }, { kind: 'run', command: 'npm test' }],
        },
      },
    },
  );
});

test('pins the canonical v1 representation and digest', async () => {
  const plan = workflow({ test: job([checkout(), run('npm test')]) });
  assert.equal(
    canonicalWorkflowPlan(plan),
    '{"jobs":{"test":{"steps":[{"kind":"checkout"},{"command":"npm test","kind":"run"}]}},"version":1}',
  );
  assert.equal(await workflowPlanDigest(plan), '295d807fb27dd4da8021c763e4f2aa34bc7712bc9cf9087aa7c0b4861975afc7');
});

test('builds candidate, landed and cleanup workflows in v2', () => {
  assert.deepEqual(
    workflowV2({
      'Candidate CI': {
        trigger: 'candidate',
        jobs: { test: job([checkout(), run('npm test')]) },
      },
      'Post-land verification': {
        trigger: 'landed',
        jobs: { verify: job([checkout(), run('npm run verify')]) },
      },
      Cleanup: {
        trigger: 'cleanup',
        jobs: { cleanup: job([checkout(), run('npm run cleanup')]) },
      },
    }),
    {
      version: 2,
      workflows: {
        'Candidate CI': {
          trigger: 'candidate',
          jobs: { test: { steps: [{ kind: 'checkout' }, { kind: 'run', command: 'npm test' }] } },
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
    },
  );
});

test('pins the canonical v2 representation and digest to Trunk parity', async () => {
  const plan = workflowV2({
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
  });

  assert.equal(
    canonicalWorkflowPlan(plan),
    '{"version":2,"workflows":{"Candidate CI":{"jobs":{"lint":{"steps":[{"kind":"checkout"},{"command":"npm run lint","kind":"run"}]}},"test":{"steps":[{"kind":"checkout"},{"command":"npm test","kind":"run"}]}},"trigger":"candidate"},"Cleanup":{"jobs":{"cleanup":{"steps":[{"kind":"checkout"},{"command":"npm run cleanup","kind":"run"}]}},"trigger":"cleanup"},"Post-land verification":{"jobs":{"verify":{"steps":[{"kind":"checkout"},{"command":"npm run verify","kind":"run"}]}},"trigger":"landed"}}}',
  );
  assert.equal(await workflowPlanDigest(plan), '0aca9e5c5ebf3c2892de3a66fc713964a8511d437ede26503fd52fdaf46f92e8');
});

test('v2 canonical form is independent of workflow and job insertion order', async () => {
  const first = workflowV2({
    Beta: { trigger: 'candidate', jobs: { test: job([checkout()]), lint: job([checkout()]) } },
    Alpha: { trigger: 'candidate', jobs: { build: job([checkout()]) } },
  });
  const second = workflowV2({
    Alpha: { trigger: 'candidate', jobs: { build: job([checkout()]) } },
    Beta: { trigger: 'candidate', jobs: { lint: job([checkout()]), test: job([checkout()]) } },
  });

  assert.equal(canonicalWorkflowPlan(first), canonicalWorkflowPlan(second));
  assert.equal(await workflowPlanDigest(first), await workflowPlanDigest(second));
});

test('normalizes v1 job names using legacy semantics', () => {
  assert.deepEqual(Object.keys(workflow({ '  test  ': job([checkout()]) }).jobs), ['test']);
  assert.throws(
    () => workflow({ test: job([checkout()]), ' test ': job([checkout()]) }),
    /duplicate workflow job "test" after normalization/,
  );
});

test('normalizes v2 workflow and job names and rejects normalized duplicates', () => {
  const plan = workflowV2({
    '  Candidate CI  ': {
      trigger: 'candidate',
      jobs: { '  test  ': job([checkout()]) },
    },
  });
  assert.deepEqual(Object.keys(plan.workflows), ['Candidate CI']);
  assert.deepEqual(Object.keys(plan.workflows['Candidate CI']?.jobs ?? {}), ['test']);

  assert.throws(
    () =>
      workflowV2({
        Test: { trigger: 'candidate', jobs: { test: job([checkout()]) } },
        ' Test ': { trigger: 'candidate', jobs: { test: job([checkout()]) } },
      }),
    /duplicate workflow "Test" after normalization/,
  );
});

test('v2 workflow and job identities reject transport-unsafe Unicode while allowing CRLF and supplementary Unicode', () => {
  assert.throws(
    () => workflowV2({ ['bad\0name']: { trigger: 'candidate', jobs: { test: job([checkout()]) } } }),
    /workflow name must not contain NUL/,
  );
  assert.throws(
    () => workflowV2({ ['bad\ud800']: { trigger: 'candidate', jobs: { test: job([checkout()]) } } }),
    /workflow name must be well-formed Unicode/,
  );
  assert.throws(
    () => workflowV2({ Test: { trigger: 'candidate', jobs: { ['bad\udc00']: job([checkout()]) } } }),
    /WorkflowPlanV2 job name must be well-formed Unicode/,
  );

  const plan = workflowV2({
    'Candidate\r\n🚀': { trigger: 'candidate', jobs: { 'test\r\n🧪': job([checkout()]) } },
  });
  assert.equal(Object.hasOwn(plan.workflows, 'Candidate\r\n🚀'), true);
  assert.equal(Object.hasOwn(plan.workflows['Candidate\r\n🚀']?.jobs ?? {}, 'test\r\n🧪'), true);
});

test('rejects unsupported v2 triggers and fields', () => {
  assert.throws(
    () => parseWorkflowPlan({ version: 2, workflows: { Test: { trigger: 'manual', jobs: { test: { steps: [{ kind: 'checkout' }] } } } } }),
    /must be one of "candidate", "landed", or "cleanup"/,
  );
  assert.throws(
    () => parseWorkflowPlan({ version: 2, workflows: { Test: { trigger: 'candidate', jobs: { test: { steps: [{ kind: 'checkout' }] } }, queue: 'fast' } } }),
    /unsupported field "queue"/,
  );
});

test('keeps special names safe while returning plain maps', () => {
  const v1 = workflow({ ['__proto__']: job([checkout()]) });
  assert.equal(Object.getPrototypeOf(v1.jobs), Object.prototype);
  assert.equal(Object.hasOwn(v1.jobs, '__proto__'), true);
  assert.deepEqual(v1.jobs.__proto__, { steps: [{ kind: 'checkout' }] });

  const v2 = workflowV2({
    ['__proto__']: { trigger: 'candidate', jobs: { ['__proto__']: job([checkout()]) } },
  });
  assert.equal(Object.getPrototypeOf(v2.workflows), Object.prototype);
  assert.equal(Object.hasOwn(v2.workflows, '__proto__'), true);
  assert.equal(Object.hasOwn(v2.workflows.__proto__?.jobs ?? {}, '__proto__'), true);
});

test('canonical v1 form is independent of job insertion order', async () => {
  const first = workflow({
    lint: job([checkout(), run('npm run lint')]),
    test: job([checkout(), run('npm test')]),
  });
  const second = workflow({
    test: job([checkout(), run('npm test')]),
    lint: job([checkout(), run('npm run lint')]),
  });

  assert.equal(canonicalWorkflowPlan(first), canonicalWorkflowPlan(second));
  assert.equal(await workflowPlanDigest(first), await workflowPlanDigest(second));
});

test('step order is semantic and changes the digest', async () => {
  const checkoutThenTest = workflow({ test: job([checkout(), run('npm test')]) });
  const testThenCheckout = workflow({ test: job([run('npm test'), checkout()]) });

  assert.notEqual(await workflowPlanDigest(checkoutThenTest), await workflowPlanDigest(testThenCheckout));
});

test('parser rejects unknown workflow fields', () => {
  assert.throws(
    () => parseWorkflowPlan({ version: 1, jobs: { test: { steps: [{ kind: 'checkout' }] } }, surprise: true }),
    WorkflowValidationError,
  );
});

test('parser rejects unknown step kinds and fields', () => {
  assert.throws(
    () => parseWorkflowPlan({ version: 1, jobs: { test: { steps: [{ kind: 'upload-artifact' }] } } }),
    /kind is not supported/,
  );
  assert.throws(
    () => parseWorkflowPlan({ version: 1, jobs: { test: { steps: [{ kind: 'checkout', ref: 'main' }] } } }),
    /unsupported field "ref"/,
  );
});

test('parser rejects sparse step arrays', () => {
  const onlyHole = new Array(1);
  assert.throws(
    () => parseWorkflowPlan({ version: 1, jobs: { test: { steps: onlyHole } } }),
    /workflow\.jobs\["test"\]\.steps\[0\] is missing/,
  );

  const interiorHole = [checkout(), , run('npm test')];
  assert.throws(
    () => parseWorkflowPlan({ version: 1, jobs: { test: { steps: interiorHole } } }),
    /workflow\.jobs\["test"\]\.steps\[1\] is missing/,
  );
});

test('empty workflows, jobs and run commands fail closed', () => {
  assert.throws(() => workflow({}), /at least one job/);
  assert.throws(() => workflowV2({}), /at least one named workflow/);
  assert.throws(() => workflowV2({ Test: { trigger: 'candidate', jobs: {} } }), /at least one job/);
  assert.throws(() => job([]), /at least one step/);
  assert.throws(() => run('   '), /must not be empty/);
});

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

test('normalizes job names using Trunk check-name semantics', () => {
  assert.deepEqual(Object.keys(workflow({ '  test  ': job([checkout()]) }).jobs), ['test']);
  assert.throws(
    () => workflow({ test: job([checkout()]), ' test ': job([checkout()]) }),
    /duplicate workflow job "test" after normalization/,
  );
});

test('keeps special check names safe while returning a plain job map', () => {
  const plan = workflow({ ['__proto__']: job([checkout()]) });
  assert.equal(Object.getPrototypeOf(plan.jobs), Object.prototype);
  assert.equal(Object.hasOwn(plan.jobs, '__proto__'), true);
  assert.deepEqual(plan.jobs.__proto__, { steps: [{ kind: 'checkout' }] });
});

test('canonical form is independent of job insertion order', async () => {
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
  assert.throws(() => job([]), /at least one step/);
  assert.throws(() => run('   '), /must not be empty/);
});

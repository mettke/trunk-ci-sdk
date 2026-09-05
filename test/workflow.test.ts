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

test('normalizes job names using Trunk check-name semantics', () => {
  assert.deepEqual(Object.keys(workflow({ '  test  ': job([checkout()]) }).jobs), ['test']);
  assert.throws(
    () => workflow({ test: job([checkout()]), ' test ': job([checkout()]) }),
    /duplicate workflow job "test" after normalization/,
  );
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

test('empty workflows, jobs and run commands fail closed', () => {
  assert.throws(() => workflow({}), /at least one job/);
  assert.throws(() => job([]), /at least one step/);
  assert.throws(() => run('   '), /must not be empty/);
});

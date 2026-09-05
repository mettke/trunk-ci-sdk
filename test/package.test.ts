import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

test('prepack builds the exported dist files into the npm tarball', () => {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const output = execFileSync(npm, ['pack', '--dry-run', '--json'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });

  const jsonStart = output.indexOf('[{');
  assert.notEqual(jsonStart, -1, `npm pack did not return JSON: ${output}`);
  const packed = JSON.parse(output.slice(jsonStart)) as Array<{
    files: Array<{ path: string }>;
  }>;
  assert.equal(packed.length, 1);

  const [archive] = packed;
  assert.ok(archive);
  const paths = new Set(archive.files.map(({ path }) => path));
  assert.equal(paths.has('dist/index.js'), true, 'package is missing dist/index.js');
  assert.equal(paths.has('dist/index.d.ts'), true, 'package is missing dist/index.d.ts');
});

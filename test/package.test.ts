import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

test('prepack builds a self-contained npm tarball', () => {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const output = execFileSync(npm, ['pack', '--dry-run', '--json'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });

  const jsonStart = output.search(/\[\s*\{/);
  assert.notEqual(jsonStart, -1, `npm pack did not return JSON: ${output}`);
  const packed = JSON.parse(output.slice(jsonStart)) as Array<{
    files: Array<{ path: string }>;
  }>;
  assert.equal(packed.length, 1);

  const [archive] = packed;
  assert.ok(archive);
  const paths = new Set(archive.files.map(({ path: filePath }) => filePath));
  assert.equal(paths.has('dist/index.js'), true, 'package is missing dist/index.js');
  assert.equal(paths.has('dist/index.d.ts'), true, 'package is missing dist/index.d.ts');
  assert.equal(paths.has('src/index.ts'), true, 'package is missing src/index.ts');
  assert.equal(paths.has('src/workflow.ts'), true, 'package is missing src/workflow.ts');

  for (const mapPath of [...paths].filter((filePath) => filePath.startsWith('dist/') && filePath.endsWith('.map'))) {
    const sourceMap = JSON.parse(readFileSync(path.join(repositoryRoot, mapPath), 'utf8')) as {
      sources?: unknown;
    };
    assert.ok(Array.isArray(sourceMap.sources), `${mapPath} does not contain a sources array`);

    for (const source of sourceMap.sources) {
      assert.equal(typeof source, 'string', `${mapPath} contains a non-string source entry`);
      const packagedSourcePath = path.posix.normalize(path.posix.join(path.posix.dirname(mapPath), source));
      assert.equal(
        paths.has(packagedSourcePath),
        true,
        `${mapPath} references unpackaged source ${packagedSourcePath}`,
      );
    }
  }
});

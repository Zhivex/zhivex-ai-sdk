import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
// Changesets removes this pending feature file during real release preparation.
it.skipIf(!existsSync(join(root, '.changeset/portable-decisions.md')))('pending Decisions changeset raises provider Core dependency floors', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'decision-release-contract-'));
  const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
  const before = read(join(root, 'packages/core/package.json')).version;
  try {
    writeFileSync(join(fixture, 'package.json'), readFileSync(join(root, 'package.json')));
    writeFileSync(join(fixture, 'bun.lock'), readFileSync(join(root, 'bun.lock')));
    mkdirSync(join(fixture, '.changeset'));
    // Only changelog rendering is disabled; the repository dependency-update
    // policy and its actual feature changeset drive this isolated simulation.
    writeFileSync(join(fixture, '.changeset/config.json'), JSON.stringify({ ...read(join(root, '.changeset/config.json')), changelog: false }));
    writeFileSync(join(fixture, '.changeset/portable-decisions.md'), readFileSync(join(root, '.changeset/portable-decisions.md')));
    for (const name of readdirSync(join(root, 'packages'))) {
      mkdirSync(join(fixture, 'packages', name), { recursive: true });
      writeFileSync(join(fixture, 'packages', name, 'package.json'), readFileSync(join(root, 'packages', name, 'package.json')));
    }
    execFileSync(process.execPath, [join(root, 'node_modules/@changesets/cli/bin.js'), 'version'], { cwd: fixture, stdio: 'pipe', timeout: 30000 });
    const after = read(join(fixture, 'packages/core/package.json')).version;
    const [major, minor] = before.split(".").map(Number);
    expect(after).toBe(`${major}.${minor + 1}.0`);
    for (const name of ['openai', 'qwen', 'gateway']) {
      const dependency = read(join(fixture, 'packages', name, 'package.json')).dependencies['@zhivex-ai/core'];
      expect(dependency).toBe(`^${after}`);
    }
    expect(read(join(root, 'packages/core/package.json')).version).toBe(before);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
}, 40000);

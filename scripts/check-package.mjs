#!/usr/bin/env node
/**
 * Runs publint and @arethetypeswrong/cli against every non-private package
 * under packages/. Expects the packages to be built already (`pnpm build`).
 * attw uses the `esm-only` profile for packages with `"type": "module"`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = join(repoRoot, 'packages');

let failed = 0;

for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const pkgDir = join(packagesDir, entry.name);
  const pkgJsonPath = join(pkgDir, 'package.json');
  if (!existsSync(pkgJsonPath)) continue;

  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  if (pkg.private === true) continue;

  const attwArgs = ['attw', '--pack', '.'];
  if (pkg.type === 'module') attwArgs.push('--profile', 'esm-only');

  for (const [label, args] of [
    ['publint', ['publint', '--strict']],
    ['attw', attwArgs],
  ]) {
    console.log(`\n> ${pkg.name}: ${label}`);
    try {
      execFileSync('pnpm', ['exec', ...args], { cwd: pkgDir, stdio: 'inherit' });
    } catch {
      failed++;
      console.error(`${label} failed for ${pkg.name}`);
    }
  }

  // The Adonis package's main entry re-exports `configure`, which imports the compiled stubs
  // root: import the built entry under plain Node (no TypeScript loader that would quietly
  // resolve a missing `.js` to its `.ts` source), as a compiled production app does.
  const main = pkg.exports?.['.']?.import ?? pkg.exports?.['.']?.default;
  if (pkg.exports?.['./configure'] && typeof main === 'string') {
    console.log(`\n> ${pkg.name}: import ${main} with plain node`);
    try {
      const url = pathToFileURL(join(pkgDir, main)).href;
      execFileSync(
        process.execPath,
        ['--input-type=module', '-e', `await import(${JSON.stringify(url)})`],
        {
          cwd: pkgDir,
          stdio: 'inherit',
        },
      );
    } catch {
      failed++;
      console.error(`importing the built main entry failed for ${pkg.name}`);
    }
  }
}

if (failed > 0) process.exit(1);

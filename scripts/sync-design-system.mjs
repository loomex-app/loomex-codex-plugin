#!/usr/bin/env node
// The frontend owns these styles; the plugin vendors a reproducible offline snapshot.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const check = args.includes('--check');
const frontendArg = args.indexOf('--frontend');
if (args.some((arg, i) => !['--check', '--frontend'].includes(arg) && !(frontendArg >= 0 && i === frontendArg + 1))) throw new Error('Usage: sync-design-system.mjs [--check] [--frontend PATH]');
if (frontendArg >= 0 && (!args[frontendArg + 1] || args[frontendArg + 1].startsWith('--'))) throw new Error('--frontend requires a path');
const frontend = resolve(frontendArg >= 0 ? args[frontendArg + 1] : resolve(root, '../frontend'));
const sourcePaths = [
  'packages/ui/src/styles.css', 'packages/ui/src/components/Button.tsx',
  'packages/ui/src/components/StatusBadge.tsx', 'packages/ui/src/components/forms.tsx',
  'packages/ui/src/components/Pagination.tsx', 'packages/ui/src/components/Select.tsx',
  'packages/theme/src/brandTokens.ts', 'packages/theme/src/neutralThemeOptions.ts',
  'pnpm-lock.yaml',
];
const digest = value => createHash('sha256').update(value).digest('hex');
const sources = Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, await readFile(resolve(frontend, path), 'utf8')])));
const appRequire = createRequire(resolve(frontend, 'apps/design-system/package.json'));
const compilerRequire = createRequire(appRequire.resolve('@tailwindcss/vite'));
const compilerEntry = compilerRequire.resolve('@tailwindcss/node');
const compilerPackage = JSON.parse(await readFile(resolve(dirname(compilerEntry), '../package.json'), 'utf8'));
const { compile } = await import(pathToFileURL(compilerEntry).href);
const template = await readFile(resolve(root, 'assets/loomex-app.html'), 'utf8');
// Include complete literal utility tokens from the template and canonical React variants.
// No runtime scan or frontend checkout is required by the installed plugin.
const candidates = [...new Set([template, sources['packages/ui/src/components/Button.tsx'], sources['packages/ui/src/components/StatusBadge.tsx'], sources['packages/ui/src/components/forms.tsx'], sources['packages/ui/src/components/Pagination.tsx'], sources['packages/ui/src/components/Select.tsx']]
  .flatMap(source => source.match(/[^\s"'`<>={}(),;]+/g) ?? []))].sort();
const compiler = await compile(sources['packages/ui/src/styles.css'], {
  base: resolve(frontend, 'apps/design-system'), onDependency() {},
});
const css = compiler.build(candidates);
if (/<\/style|@import\s|url\(/i.test(css)) throw new Error('The design export must be entirely inline and offline');
// Read the canonical status presentation contract rather than copying its table.
const statusSource = ts.createSourceFile('StatusBadge.tsx', sources['packages/ui/src/components/StatusBadge.tsx'], ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let statusClasses;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(statusSource) === 'classes' && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
    statusClasses = Object.fromEntries(node.initializer.properties.map(property => {
      if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.initializer) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) throw new Error('Unsupported frontend status class contract');
      return [property.name.text, property.initializer.text];
    }));
  }
  ts.forEachChild(node, visit);
}
visit(statusSource);
if (!statusClasses?.unknown || !statusClasses?.low || !statusClasses?.failed) throw new Error('Missing canonical status variants');
const snapshot = {
  schema: 'loomex/frontend-design-system/v1',
  frontendRevision: execFileSync('git', ['-C', frontend, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  compiler: { name: compilerPackage.name, version: compilerPackage.version },
  sources: Object.fromEntries(Object.entries(sources).map(([path, content]) => [path, digest(content)])),
  statusClasses,
  templateSha256: digest(template),
  candidatesSha256: digest(JSON.stringify(candidates)),
  cssSha256: digest(css),
};
const outputs = { 'assets/frontend-design-system.css': css, 'assets/frontend-design-system.json': JSON.stringify(snapshot, null, 2) + '\n' };
for (const [path, content] of Object.entries(outputs)) {
  if (check) {
    if (await readFile(resolve(root, path), 'utf8') !== content) throw new Error(`Stale design-system export: ${path}. Run npm run design:sync.`);
  } else await writeFile(resolve(root, path), content);
}
console.log(`${check ? 'Verified' : 'Exported'} frontend design system (${css.length} bytes; ${compilerPackage.name}@${compilerPackage.version})`);

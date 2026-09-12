import ts from 'typescript';
import { resolve, relative, sep } from 'node:path';

/** All authored executable bundle inputs must have checked implementations. */
export function browserCoverage(root, inputs, configPath = resolve(root, 'tsconfig.json')) {
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  if (parsed.errors.length) throw new Error(parsed.errors.map(e => ts.flattenDiagnosticMessageText(e.messageText, '\n')).join('\n'));
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checked = new Set(program.getSourceFiles().filter(f => !f.isDeclarationFile).map(f => resolve(f.fileName)));
  const failures = [];
  const strictFlags = ['noImplicitAny', 'noImplicitThis', 'strictNullChecks', 'strictFunctionTypes',
    'strictBindCallApply', 'strictPropertyInitialization', 'useUnknownInCatchVariables',
    'strictBuiltinIteratorReturn', 'alwaysStrict'];
  if (parsed.options.strict !== true || parsed.options.noCheck === true ||
      strictFlags.some(flag => parsed.options[flag] === false)) {
    failures.push('browser implementation must use strict checking without disabled strict flags or noCheck');
  }
  const bundled = new Set(inputs.map(input => resolve(root, input)));
  for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
    if (!diagnostic.file || bundled.has(resolve(diagnostic.file.fileName))) {
      failures.push(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    }
  }
  for (const input of inputs) {
    const path = resolve(root, input);
    const local = relative(root, path);
    if (local.split(sep).includes('node_modules')) continue;
    if (local.startsWith('..') || !/\.[cm]?[jt]sx?$/.test(path)) {
      failures.push(`${input}: unclassified executable input`); continue;
    }
    if (!/\.[cm]?tsx?$/.test(path) || !checked.has(path)) {
      failures.push(`${input}: implementation is not in the checked TypeScript program`); continue;
    }
    const source = program.getSourceFile(path);
    if (!source) { failures.push(`${input}: missing implementation`); continue; }
    const comments = source.text.match(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g) ?? [];
    if (comments.some(c => /@ts-(?:nocheck|ignore|expect-error)\b/.test(c))) failures.push(`${input}: type-check suppression`);
    const visit = node => {
      if (node.kind === ts.SyntaxKind.AnyKeyword) failures.push(`${input}: explicit any bypasses browser boundary checking`);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...new Set(failures)];
}

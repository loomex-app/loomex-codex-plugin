import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { browserCoverage } from './browser-coverage.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// This gate reports unchecked JS before compilation; no JS-as-TS loader exception.
let result;
try { result = await build({absWorkingDir: root, entryPoints:['src/ui-app/app.ts'],bundle:true,platform:'browser',write:false,metafile:true,logLevel:'silent'}); } catch (error) { console.error('Browser source cannot be compiled without unchecked loader overrides:', error.message); process.exit(1); }
const failures = browserCoverage(root, Object.keys(result.metafile.inputs));
if (failures.length) { console.error(failures.join('\n')); process.exitCode=1; }
else {
  const inputs = Object.keys(result.metafile.inputs);
  const thirdParty = inputs.filter(path => path.split(/[\\/]/).includes('node_modules')).length;
  console.log(`Verified strict implementations for ${inputs.length - thirdParty} first-party browser inputs; ${thirdParty} third-party inputs excluded from authored-source coverage`);
}

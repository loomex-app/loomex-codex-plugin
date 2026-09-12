import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';

async function implementationFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...await implementationFiles(path));
    } else if (/\.[jt]sx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      result.push(path);
    }
  }
  return result.sort();
}

export async function designConsumers(root) {
  const paths = [
    resolve(root, 'assets/loomex-app.html'),
    ...await implementationFiles(resolve(root, 'src/ui-app')),
  ];
  const entries = await Promise.all(paths.map(async (path) => [
    relative(root, path).replaceAll('\\', '/'),
    await readFile(path, 'utf8'),
  ]));
  return {
    texts: entries.map(([, text]) => text),
    sha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
  };
}

export async function verifyDesignConsumers(root, snapshot) {
  const consumer = await designConsumers(root);
  if (snapshot.schema !== 'loomex/frontend-design-system/v3' ||
      snapshot.consumerSourcesSha256 !== consumer.sha256) {
    throw new Error('Stale consumer styles: regenerate the frontend design export before building this browser source.');
  }
  return consumer;
}

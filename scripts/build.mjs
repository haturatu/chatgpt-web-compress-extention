import { build, context } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'dist');

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const common = {
  bundle: true,
  format: 'iife',
  target: 'chrome116',
  sourcemap: true,
  logLevel: 'info'
};

const entries = [
  ['src/content/index.ts', 'content.js'],
  ['src/popup/index.ts', 'popup.js'],
  ['src/options/index.ts', 'options.js']
];

const buildAll = async () => {
  await Promise.all(entries.map(([entry, outfile]) => build({
    ...common,
    entryPoints: [resolve(root, entry)],
    outfile: resolve(outDir, outfile)
  })));

  await cp(resolve(root, 'src/content/optimizer.css'), resolve(outDir, 'optimizer.css'));
  await cp(resolve(root, 'src/popup/popup.html'), resolve(outDir, 'popup.html'));
  await cp(resolve(root, 'src/popup/popup.css'), resolve(outDir, 'popup.css'));
  await cp(resolve(root, 'src/options/options.html'), resolve(outDir, 'options.html'));
  await cp(resolve(root, 'src/options/options.css'), resolve(outDir, 'options.css'));

  const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  await writeFile(resolve(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
};

if (process.argv.includes('--watch')) {
  const contexts = await Promise.all(entries.map(([entry, outfile]) => context({
    ...common,
    entryPoints: [resolve(root, entry)],
    outfile: resolve(outDir, outfile)
  })));
  await Promise.all(contexts.map((item) => item.watch()));
  await cp(resolve(root, 'src/content/optimizer.css'), resolve(outDir, 'optimizer.css'));
  await cp(resolve(root, 'src/popup/popup.html'), resolve(outDir, 'popup.html'));
  await cp(resolve(root, 'src/popup/popup.css'), resolve(outDir, 'popup.css'));
  await cp(resolve(root, 'src/options/options.html'), resolve(outDir, 'options.html'));
  await cp(resolve(root, 'src/options/options.css'), resolve(outDir, 'options.css'));
} else {
  await buildAll();
}

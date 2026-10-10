import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'], outdir: 'dist', bundle: true,
  platform: 'node', format: 'esm', packages: 'external', target: 'node22',
});

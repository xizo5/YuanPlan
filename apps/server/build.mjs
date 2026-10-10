import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
await build({entryPoints:{index:'src/index.ts',cli:'src/cli.ts','db/migrate':'src/db/migrate.ts'},outdir:'dist',bundle:true,platform:'node',format:'esm',packages:'external',alias:{'@yuanplan/contracts':fileURLToPath(new URL('../../packages/contracts/src/index.ts',import.meta.url)),'@yuanplan/editor-schema':fileURLToPath(new URL('../../packages/editor-schema/src/index.ts',import.meta.url))}});

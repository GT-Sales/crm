import { defineConfig } from 'tsup';

/**
 * Railway runs `node dist/src/server.js` (see Dockerfile). Workspace packages
 * export TypeScript source, so they are bundled into the output (`noExternal`)
 * while real npm dependencies stay external. The Vercel function entry that
 * used to be built alongside was removed after the Railway cutover (SEC-11).
 */
export default defineConfig({
  entry: { 'src/server': 'src/server.ts' },
  format: 'esm',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  splitting: false,
  noExternal: [/^@gt-sales\//],
});

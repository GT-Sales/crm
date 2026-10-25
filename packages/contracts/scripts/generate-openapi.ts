import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';

import { buildOpenApiDocument } from '../src/openapi';

/**
 * Writes the generated OpenAPI 3.1 document to `docs/api/openapi.json`. Run at
 * build (`pnpm --filter @gt-sales/contracts build`). The document is
 * derived entirely from the Zod schemas in this package — never edited by hand
 * — so the published API surface and the typed client cannot drift (REQ 50).
 */
const outputUrl = new URL('../../../docs/api/openapi.json', import.meta.url);
const outputPath = fileURLToPath(outputUrl);

const document = buildOpenApiDocument();
const paths = document['paths'];
const pathCount = paths && typeof paths === 'object' ? Object.keys(paths).length : 0;

mkdirSync(fileURLToPath(new URL('.', outputUrl)), { recursive: true });
writeFileSync(
  outputPath,
  await format(JSON.stringify(document), {
    ...(await resolveConfig(outputPath)),
    parser: 'json',
  }),
  'utf8',
);

console.info(`Generated OpenAPI 3.1 document with ${pathCount} paths at ${outputPath}`);

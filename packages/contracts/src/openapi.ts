import { z } from 'zod';
import { websiteBotTokenSchema } from './website-bot';

import { apiErrorResponseSchema } from './staff-auth';
import { endpoints, type EndpointAuth, type EndpointDef } from './endpoints';

/**
 * Builds an OpenAPI 3.1 document from the endpoint registry and its Zod
 * schemas. There is no hand-written OpenAPI: the schemas are the single source
 * (REQ 50). `scripts/generate-openapi.ts` writes the result to
 * `docs/api/openapi.json` at build time.
 */

type JsonObject = Record<string, unknown>;

/**
 * Converts a Zod schema to a plain JSON-Schema object (draft 2020-12, the
 * dialect OpenAPI 3.1 uses). Round-tripping through JSON yields a plain
 * `Record` without any class instances or the top-level `$schema` marker, which
 * OpenAPI does not want on component schemas.
 */
function jsonSchemaOf(schema: z.ZodType): JsonObject {
  const converted: JsonObject = JSON.parse(
    JSON.stringify(z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'output' })),
  );
  delete converted['$schema'];
  return converted;
}

/** Same as `jsonSchemaOf`, but for a request body validated on input. */
function jsonInputSchemaOf(schema: z.ZodType): JsonObject {
  const converted: JsonObject = JSON.parse(
    JSON.stringify(z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' })),
  );
  delete converted['$schema'];
  return converted;
}

function pathParamNames(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] ?? '');
}

function tagFor(path: string): string {
  return path.split('/')[3] ?? 'root';
}

const securitySchemes: JsonObject = {
  staffSession: {
    type: 'http',
    scheme: 'bearer',
    description: 'Supabase Auth access token; verified and re-authorised on every request.',
  },
  websiteCredential: {
    type: 'http',
    scheme: 'bearer',
    description:
      'Per-site service credential (`gtsk_…`); resolves to one workspace and its scopes.',
  },
  machineSignature: {
    type: 'apiKey',
    in: 'header',
    name: 'X-Signature',
    description: 'Provider HMAC signature verified through the server-only machine registry.',
  },
};

function securityFor(auth: EndpointAuth): JsonObject[] {
  switch (auth) {
    case 'public':
      return [];
    case 'staff':
      return [{ staffSession: [] }];
    case 'website':
    case 'customer':
      return [{ websiteCredential: [] }];
    case 'machine':
      return [{ machineSignature: [] }];
  }
}

function queryParameters(schema: z.ZodType): JsonObject[] {
  const js = jsonInputSchemaOf(schema);
  const properties = js['properties'];
  if (!properties || typeof properties !== 'object') {
    return [];
  }
  const required = Array.isArray(js['required']) ? js['required'] : [];
  return Object.entries(properties).map(([name, sub]) => ({
    name,
    in: 'query',
    required: required.includes(name),
    schema: sub,
  }));
}

function parametersFor(endpoint: EndpointDef): JsonObject[] {
  const params: JsonObject[] = pathParamNames(endpoint.path).map((name) => ({
    name,
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));
  for (const header of endpoint.headers ?? []) {
    params.push({
      name: header.name,
      in: 'header',
      required: header.required,
      description: header.description,
      schema: { type: 'string' },
    });
  }
  if (endpoint.auth === 'website' || endpoint.auth === 'customer') {
    params.push({
      name: 'X-Website-Visitor-Id',
      in: 'header',
      required: false,
      description:
        'Server-owned keyed visitor digest from the authenticated website; never raw browser forwarding headers.',
      schema: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    });
    if (endpoint.method !== 'GET')
      params.push({
        name: 'X-Turnstile-Token',
        in: 'header',
        required: true,
        description:
          'Fresh single-use challenge token bound to this route action. Obtain a new token before each request or retry.',
        schema: jsonInputSchemaOf(websiteBotTokenSchema),
      });
  }
  if (endpoint.query) {
    params.push(...queryParameters(endpoint.query));
  }
  return params;
}

function operationFor(endpoint: EndpointDef): JsonObject {
  const responses: JsonObject = {
    [String(endpoint.successStatus)]: {
      description: 'Success.',
      content: { 'application/json': { schema: jsonSchemaOf(endpoint.response) } },
    },
    default: {
      description: 'Error envelope `{ error: { code, message, requestId, details? } }`.',
      content: { 'application/json': { schema: jsonSchemaOf(apiErrorResponseSchema) } },
    },
  };

  const operation: JsonObject = {
    operationId: endpoint.operationId,
    summary: endpoint.summary,
    tags: [tagFor(endpoint.path)],
    security: securityFor(endpoint.auth),
    parameters: parametersFor(endpoint),
    responses,
  };

  if (endpoint.request) {
    operation['requestBody'] = {
      required: true,
      content: { 'application/json': { schema: jsonInputSchemaOf(endpoint.request) } },
    };
  }

  return operation;
}

export interface BuildOpenApiOptions {
  readonly version?: string;
}

export function buildOpenApiDocument(options: BuildOpenApiOptions = {}): JsonObject {
  const paths: JsonObject = {};
  for (const endpoint of endpoints) {
    const existing = paths[endpoint.path];
    const item: JsonObject = existing && typeof existing === 'object' ? { ...existing } : {};
    item[endpoint.method.toLowerCase()] = operationFor(endpoint);
    paths[endpoint.path] = item;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'GT Sales CRM API',
      version: options.version ?? '1.0.0',
      description:
        'Generated from @gt-sales/contracts Zod schemas. Do not edit by hand — ' +
        'run `pnpm --filter @gt-sales/contracts build`.',
    },
    servers: [{ url: '/', description: 'Backend origin; all routes are under /api/v1.' }],
    components: { securitySchemes },
    paths,
  };
}

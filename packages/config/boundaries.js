import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
// Add individual offline entry points only when their task documents the exception.
export const offlineDbFiles = new Set();
const dbClients = [
  'pg',
  'pg-native',
  'postgres',
  'drizzle-orm',
  'drizzle-kit',
  '@prisma/client',
  'prisma',
  'mysql',
  'mysql2',
  'mongodb',
  'mongoose',
  'knex',
  'kysely',
  'sequelize',
  'typeorm',
  'better-sqlite3',
  'sqlite3',
  'node:sqlite',
  '@neondatabase/serverless',
  '@libsql/client',
  '@vercel/postgres',
  '@supabase/postgrest-js',
  '@supabase/storage-js',
  '@supabase/realtime-js',
];
const fullSupabase = ['@supabase/supabase-js', '@supabase/ssr'];
const matches = (source, names) =>
  names.some((name) => source === name || source.startsWith(`${name}/`));
const relative = (filename) => path.relative(root, filename).replaceAll('\\', '/');

export const dataBoundaryRule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      db: 'Only apps/backend, packages/db and explicitly listed offline files may import database code (docs/PLAN.md §3, rule 1).',
      server: 'Frontend/shared browser code cannot import server-only adapters or backend code.',
      auth: 'Supabase session clients are auth-only: use @supabase/auth-js, or immediately extract only .auth from a named Supabase factory call. DB/Storage clients cannot escape.',
      dynamic: 'Module paths must be static so the data boundary can be checked.',
    },
  },
  create(context) {
    const filename = relative(context.filename);
    const dbAllowed =
      filename.startsWith('apps/backend/') ||
      filename.startsWith('packages/db/') ||
      offlineDbFiles.has(filename);
    const serverAllowed =
      dbAllowed || filename.startsWith('packages/adapters/') || filename.startsWith('jobs/');
    const factories = new Set();

    function check(node, sourceNode) {
      const source = sourceNode?.value;
      if (typeof source !== 'string') {
        context.report({ node, messageId: 'dynamic' });
        return;
      }
      const target =
        source.startsWith('.') || path.isAbsolute(source)
          ? relative(path.resolve(path.dirname(context.filename), source))
          : source;
      if (
        !dbAllowed &&
        (matches(source, ['@gt-sales/db', ...dbClients]) || /^packages\/db(?:\/|$)/.test(target))
      ) {
        context.report({ node, messageId: 'db' });
      }
      if (
        !serverAllowed &&
        (matches(source, ['@gt-sales/adapters']) ||
          /^(packages\/adapters|apps\/backend)(?:\/|$)/.test(target))
      ) {
        context.report({ node, messageId: 'server' });
      }
      if (!dbAllowed && matches(source, fullSupabase)) {
        if (node.type !== 'ImportDeclaration') {
          context.report({ node, messageId: 'auth' });
          return;
        }
        for (const specifier of node.specifiers) {
          if (
            specifier.type !== 'ImportSpecifier' ||
            !['createClient', 'createBrowserClient', 'createServerClient'].includes(
              specifier.imported.name,
            )
          ) {
            context.report({ node: specifier, messageId: 'auth' });
          } else {
            factories.add(specifier);
          }
        }
      }
    }
    return {
      ImportDeclaration(node) {
        check(node, node.source);
      },
      ExportNamedDeclaration(node) {
        if (node.source) check(node, node.source);
      },
      ExportAllDeclaration(node) {
        check(node, node.source);
      },
      ImportExpression(node) {
        check(node, node.source);
      },
      TSImportType(node) {
        check(node, node.argument?.literal ?? node.argument);
      },
      TSExternalModuleReference(node) {
        check(node, node.expression);
      },
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require')
          check(node, node.arguments[0]);
      },
      'Program:exit'() {
        for (const specifier of factories) {
          const variables = context.sourceCode.getDeclaredVariables(specifier);
          for (const variable of variables) {
            for (const reference of variable.references) {
              const identifier = reference.identifier;
              const call = identifier.parent;
              const usage = call.parent;
              const authMember =
                usage.type === 'MemberExpression' &&
                usage.object === call &&
                ((!usage.computed && usage.property.name === 'auth') ||
                  (usage.computed && usage.property.value === 'auth'));
              const authDestructure =
                usage.type === 'VariableDeclarator' &&
                usage.init === call &&
                usage.id.type === 'ObjectPattern' &&
                usage.id.properties.length === 1 &&
                usage.id.properties[0].type === 'Property' &&
                !usage.id.properties[0].computed &&
                (usage.id.properties[0].key.name === 'auth' ||
                  usage.id.properties[0].key.value === 'auth');
              if (
                call.type !== 'CallExpression' ||
                call.callee !== identifier ||
                (!authMember && !authDestructure)
              ) {
                context.report({ node: identifier, messageId: 'auth' });
              }
            }
          }
        }
      },
    };
  },
};

export const boundaryConfig = {
  files: ['**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}'],
  plugins: { 'canadian-plans': { rules: { 'data-boundary': dataBoundaryRule } } },
  rules: { 'canadian-plans/data-boundary': 'error' },
};

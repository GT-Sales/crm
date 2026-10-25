# syntax=docker/dockerfile:1
#
# Build context is the repository root: the backend depends on workspace
# packages (`@gt-sales/*`) whose package.json `exports` point directly at
# TypeScript source, so a root-relative install and build are required.
FROM node:22.19.0-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /repo

FROM base AS build
# Copy every workspace manifest first so the install layer caches well.
# `.npmrc` carries engine-strict, so it belongs in this layer too.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/backend/package.json       apps/backend/
COPY apps/admin/package.json         apps/admin/
COPY jobs/package.json               jobs/
COPY packages/adapters/package.json  packages/adapters/
COPY packages/config/package.json    packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json        packages/db/
COPY packages/types/package.json     packages/types/
COPY packages/ui/package.json        packages/ui/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter backend build

FROM base AS runtime
ENV NODE_ENV=production
# The whole install is shipped rather than pruned: tsup inlines the
# `@gt-sales/*` workspace packages but leaves real npm dependencies
# external (`express`, `drizzle-orm`, `zod`, `postgres`, `@supabase/supabase-js`),
# and `postgres` is a dependency of `packages/db` reached through pnpm's
# symlinked store, so naive pruning breaks resolution.
# Owned by and run as the image's unprivileged `node` user (uid 1000): the app
# never writes to disk at runtime, and PORT 4000 needs no privileges.
COPY --from=build --chown=node:node /repo /repo
WORKDIR /repo/apps/backend
USER node
CMD ["node", "dist/src/server.js"]

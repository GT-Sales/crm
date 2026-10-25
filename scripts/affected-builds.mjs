import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

export function affectedApps(projects, changes) {
  const apps = projects.filter((project) => project.directory.startsWith('apps/'));
  // Root tooling, lockfiles, scripts and jobs may affect every deployable app.
  if (
    changes === null ||
    changes.some(
      (file) =>
        !file.startsWith('apps/') &&
        !file.startsWith('packages/') &&
        !file.startsWith('docs/') &&
        !file.endsWith('.md'),
    )
  ) {
    return apps;
  }
  const affected = new Set(
    projects
      .filter((project) => changes.some((file) => file.startsWith(`${project.directory}/`)))
      .map((project) => project.name),
  );
  let previousSize;
  do {
    previousSize = affected.size;
    for (const project of projects) {
      if (project.dependencies.some((dependency) => affected.has(dependency)))
        affected.add(project.name);
    }
  } while (affected.size !== previousSize);
  // Deleted/renamed or newly added workspace directories absent from this graph fail safe.
  if (
    changes.some(
      (file) =>
        /^(apps|packages)\//.test(file) &&
        !projects.some((project) => file.startsWith(`${project.directory}/`)),
    )
  )
    return apps;
  return apps.filter((app) => affected.has(app.name));
}

export function readProjects() {
  return ['apps', 'packages'].flatMap((group) =>
    readdirSync(path.join(root, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const directory = `${group}/${entry.name}`;
        const manifest = JSON.parse(
          readFileSync(path.join(root, directory, 'package.json'), 'utf8'),
        );
        return {
          name: manifest.name,
          directory,
          dependencies: Object.keys({
            ...manifest.dependencies,
            ...manifest.devDependencies,
            ...manifest.peerDependencies,
          }),
        };
      }),
  );
}

export function changedFiles(base) {
  if (!base || !/^[a-zA-Z0-9_./~^:-]+$/.test(base) || base.startsWith('-')) return null;
  try {
    return execFileSync('git', ['diff', '--name-only', base, 'HEAD', '--'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch {
    return null;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const projects = readProjects();
  const base = process.env['BASE_SHA'] || process.env['VERCEL_GIT_PREVIOUS_SHA'];
  const apps = affectedApps(projects, changedFiles(base));
  console.info(`Affected apps: ${apps.map((app) => app.name).join(', ') || 'none'}`);
  if (args[0] === '--vercel') {
    // A Vercel "Redeploy" of the current commit has an empty diff, which would
    // otherwise cancel the build and leave changed NEXT_PUBLIC_* values unapplied.
    if (process.env['VERCEL_FORCE_BUILD'] === '1') {
      console.info('VERCEL_FORCE_BUILD=1: building regardless of changed files');
      process.exit(1);
    }
    const selected = projects.find((project) => project.directory === `apps/${args[1]}`);
    process.exit(selected && !apps.includes(selected) ? 0 : 1);
  }
  if (args.includes('--build')) {
    for (const app of apps) {
      // Invoke pnpm's JS entry to preserve argument boundaries on Windows.
      const pnpm = process.env['npm_execpath'];
      if (!pnpm) throw new Error('Run through pnpm run build:affected.');
      const result = spawnSync(process.execPath, [pnpm, '--filter', app.name, 'run', 'build'], {
        cwd: root,
        stdio: 'inherit',
      });
      if (result.error) throw result.error;
      if (result.status !== 0) process.exit(result.status ?? 1);
    }
  }
}

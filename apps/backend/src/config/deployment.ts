export type DeploymentEnvironment = 'production' | 'preview' | 'development';

/**
 * Platform-neutral deployment environment. Railway has no equivalent of
 * VERCEL_ENV, so it is set explicitly per service. VERCEL_ENV remains a
 * fallback so a Vercel deployment of this same commit still behaves correctly
 * during the cutover window (D6).
 *
 * An unknown or unset value resolves to `undefined` rather than a guessed
 * environment: callers must not treat an unrecognized name as production.
 */
export function loadDeploymentEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): DeploymentEnvironment | undefined {
  const raw = env['DEPLOYMENT_ENV'] ?? env['VERCEL_ENV'];
  switch (raw) {
    case 'production':
    case 'preview':
    case 'development':
      return raw;
    default:
      return undefined;
  }
}

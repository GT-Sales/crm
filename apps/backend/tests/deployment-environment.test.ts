import { describe, expect, it } from 'vitest';

import { loadDeploymentEnvironment } from '../src/config/deployment.js';

describe('loadDeploymentEnvironment', () => {
  it('accepts each known deployment environment', () => {
    for (const value of ['production', 'preview', 'development'] as const) {
      expect(loadDeploymentEnvironment({ DEPLOYMENT_ENV: value })).toBe(value);
    }
  });

  it('prefers DEPLOYMENT_ENV over the VERCEL_ENV fallback', () => {
    expect(loadDeploymentEnvironment({ DEPLOYMENT_ENV: 'production', VERCEL_ENV: 'preview' })).toBe(
      'production',
    );
  });

  it('falls back to VERCEL_ENV when DEPLOYMENT_ENV is unset', () => {
    expect(loadDeploymentEnvironment({ VERCEL_ENV: 'preview' })).toBe('preview');
  });

  it('fails closed to undefined for an unknown or unset value', () => {
    expect(loadDeploymentEnvironment({ DEPLOYMENT_ENV: 'staging' })).toBeUndefined();
    expect(loadDeploymentEnvironment({ DEPLOYMENT_ENV: '' })).toBeUndefined();
    expect(loadDeploymentEnvironment({})).toBeUndefined();
  });
});

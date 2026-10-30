import {
  FakeAnalyticsSink,
  FakeEmailAdapter,
  ResendEmailAdapter,
  UmamiAnalyticsSink,
  type AnalyticsSink,
  type EmailAdapter,
} from '@gt-sales/adapters';
import {
  createJobHandlerRegistry,
  JobHandlerError,
  type EmailEligibilityChecker,
  type EmailDeliveryRecorder,
  type JobHandlerRegistry,
} from '@gt-sales/jobs';
import { TRACKING_CODE_JOB_TYPE } from '@gt-sales/contracts';
import { z } from 'zod';

import { createDocumentServiceFromEnv } from '../documents/factory.js';
import { createLegacyDocumentImportHandler } from '../documents/import-job.js';
import type { DocumentService } from '../documents/service.js';
import { customerEmailEnvironmentFromEnv } from '../email/senders.js';
import { DatabaseEmailStore } from '../email/store.js';
import { loadMachineRegistry, type MachineRegistry } from '../machines/registry.js';
import { createTrackingCodeHandler } from '../tracking/delivery.js';
import { loadTrackingSecret } from '../tracking/secrets.js';

/**
 * The explicit opt-in for the in-memory analytics fake. There is deliberately
 * no implicit fallback: an unset value means no provider is configured, so the
 * outbox fails closed instead of silently delivering through a test double.
 */
export const FAKE_OUTBOX_ADAPTERS_VALUE = 'fake';

/**
 * Deployment configuration for the Umami server-event sink. The workspace →
 * website-id mapping is what keeps each website's events on its own Umami
 * site; a workspace with no mapping fails closed in the adapter rather than
 * sending to the wrong site. Parsed strictly so a malformed value yields "no
 * provider" instead of a guess.
 */
const umamiConfigSchema = z
  .object({
    endpoint: z.url(),
    hostname: z.string().min(1).max(253).optional(),
    sites: z
      .array(z.object({ workspaceId: z.uuid(), websiteId: z.string().min(1).max(64) }))
      .min(1),
  })
  .strict();

/** Builds the Umami sink from the environment, or `undefined` when unconfigured/invalid. */
export function loadUmamiAnalyticsSink(
  env: NodeJS.ProcessEnv = process.env,
): AnalyticsSink | undefined {
  const endpoint = env.UMAMI_EVENTS_URL?.trim();
  const rawSites = env.UMAMI_WORKSPACE_WEBSITES?.trim();
  if (!endpoint || !rawSites) return undefined;
  let sites: unknown;
  try {
    sites = JSON.parse(rawSites);
  } catch {
    return undefined;
  }
  const parsed = umamiConfigSchema.safeParse({
    endpoint,
    hostname: env.UMAMI_HOSTNAME?.trim() || undefined,
    sites,
  });
  if (!parsed.success) return undefined;
  const byWorkspace = new Map(parsed.data.sites.map((site) => [site.workspaceId, site.websiteId]));
  return new UmamiAnalyticsSink({
    endpoint: parsed.data.endpoint,
    hostname: parsed.data.hostname,
    userAgent: env.UMAMI_USER_AGENT?.trim() || undefined,
    websiteIdForWorkspace: (workspaceId) => byWorkspace.get(workspaceId),
  });
}

/**
 * The Resend account a site's mail is recorded against: the one its Resend
 * webhook reports from, when it has one, else the one configured account (its
 * deliveries are then recorded without inbound events until a webhook is
 * registered). Either way it must be `RESEND_ACCOUNT_ID`, or nothing sends.
 */
export function resendAccountForWorkspace(
  env: NodeJS.ProcessEnv,
  registry: Pick<MachineRegistry, 'resendForWorkspace'> | undefined,
  workspaceId: string,
): string | undefined {
  const account =
    registry?.resendForWorkspace(workspaceId)?.providerAccount ?? env.RESEND_ACCOUNT_ID;
  return account && account === env.RESEND_ACCOUNT_ID ? account : undefined;
}

/** Fails an email job permanently until a real selected adapter is wired. */
function unconfiguredEmailAdapter(): EmailAdapter {
  return {
    send: async () => {
      throw new JobHandlerError('provider_not_configured', false);
    },
  };
}

/**
 * Selects the email provider explicitly. `fake` is the only value CI/preview
 * deployments use; `resend` is the production provider. There is no automatic
 * failover between providers.
 */
export type EmailProviderName = 'fake' | 'resend';

function readEmailProvider(env: NodeJS.ProcessEnv): EmailProviderName | undefined {
  return env.EMAIL_PROVIDER === 'fake' || env.EMAIL_PROVIDER === 'resend'
    ? env.EMAIL_PROVIDER
    : undefined;
}

function requireEnv(env: NodeJS.ProcessEnv, name: string, provider: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required when EMAIL_PROVIDER=${provider}.`);
  return value;
}

/**
 * Builds the outbox handler registry for the current deployment.
 *
 * Analytics uses the configured Umami sink, or the in-memory fake only under an
 * explicit `OUTBOX_ADAPTERS=fake` non-production opt-in. Email is chosen by an
 * explicit `EMAIL_PROVIDER` (`fake` or `resend`); a fake provider never sends
 * in production. Email eligibility (suppression + marketing consent) is always
 * re-checked against the real database regardless of which email provider is
 * selected — a fake email provider in a preview still respects real
 * suppression data. Document imports use the configured object store, and wait
 * for one without spending attempts.
 */
export function createOutboxJobHandlers(
  env: NodeJS.ProcessEnv = process.env,
  eligibility: EmailEligibilityChecker = new DatabaseEmailStore(),
  deliveryOverride?: EmailDeliveryRecorder,
  documents:
    Pick<DocumentService, 'importWebsiteDocument'> | undefined = createDocumentServiceFromEnv(env),
): JobHandlerRegistry {
  const explicitFake = env.OUTBOX_ADAPTERS === FAKE_OUTBOX_ADAPTERS_VALUE;
  const allowFakes = explicitFake && env.NODE_ENV !== 'production';
  const emailProvider = readEmailProvider(env);

  const analytics = allowFakes ? new FakeAnalyticsSink() : loadUmamiAnalyticsSink(env);

  let email: EmailAdapter;
  if (emailProvider === 'fake') {
    // The fake never sends in production, even if explicitly requested there.
    email = env.NODE_ENV === 'production' ? unconfiguredEmailAdapter() : new FakeEmailAdapter();
  } else if (emailProvider === 'resend') {
    email = new ResendEmailAdapter({
      apiKey: requireEnv(env, 'RESEND_API_KEY', 'resend'),
      sender: {
        fromAddress: requireEnv(env, 'RESEND_FROM_EMAIL', 'resend'),
        fromName: requireEnv(env, 'RESEND_FROM_NAME', 'resend'),
        replyToAddress: env.RESEND_REPLY_TO_EMAIL,
      },
    });
  } else {
    // No email provider selected: email jobs fail per-job, but analytics still works.
    email = unconfiguredEmailAdapter();
  }

  const registry =
    emailProvider === 'resend' ? loadMachineRegistry(env.MACHINE_REGISTRY_JSON) : undefined;
  const delivery: EmailDeliveryRecorder | undefined =
    deliveryOverride ??
    (eligibility instanceof DatabaseEmailStore
      ? {
          prepare: async (input) => {
            const provider = emailProvider;
            if (!provider) throw new JobHandlerError('provider_not_configured', false);
            const providerAccount =
              provider === 'resend'
                ? resendAccountForWorkspace(env, registry, input.workspaceId)
                : provider;
            if (!providerAccount) {
              throw new JobHandlerError('email_account_not_configured', false);
            }
            await eligibility.prepareDelivery({ ...input, provider, providerAccount });
          },
          recordResult: (input) => eligibility.recordDeliveryResult(input),
        }
      : undefined);
  const handlers = new Map(
    createJobHandlerRegistry({
      email,
      analytics: analytics ?? {
        capture: async () => {
          throw new JobHandlerError('provider_not_configured', false);
        },
      },
      eligibility,
      delivery,
    }),
  );
  handlers.set('legacy_document_import', createLegacyDocumentImportHandler(documents));
  handlers.set(
    TRACKING_CODE_JOB_TYPE,
    createTrackingCodeHandler({
      email,
      eligibility,
      delivery,
      environment: customerEmailEnvironmentFromEnv(env),
      secret: loadTrackingSecret(env),
    }),
  );
  return handlers;
}

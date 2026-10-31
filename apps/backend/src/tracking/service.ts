import { TRACKING_CODE_TTL_MS, type TrackingOrder } from '@gt-sales/contracts';

import { sealTrackingCode } from '../crypto/cipher.js';
import {
  codeBindingHash,
  emailBindingHash,
  generateTrackingCode,
  normalizeTrackingEmail,
  signTrackingGrant,
  verifyTrackingGrant,
  type TrackingGrantIdentity,
} from './secrets.js';
import type { ConsumeOutcome, TrackedLeadRef, TrackingStore, WebsiteScope } from './store.js';

export interface TrackingServiceDependencies {
  readonly store: TrackingStore;
  /** `TRACKING_HASH_SECRET`; absent means tracking is unconfigured (ruling T11). */
  readonly secret: string | undefined;
  /** The keyed hash an address is known by outside a job payload (`hashContact`). */
  readonly contactHash: (email: string) => string;
  readonly now?: () => Date;
}

export type TrackingVerifyOutcome =
  | { status: 'verified'; grant: { token: string; expiresAt: string } }
  | { status: Exclude<ConsumeOutcome, 'verified'> };

/**
 * Email-only customer tracking (ported from Canadian Plans'
 * `tracking/service.ts`). A code covers every order of one email on one site;
 * the grant it yields is bound to that site and email, and every read
 * re-resolves orders by reference **and** email. Neither the email nor the
 * code is logged or stored in the clear. The neutral answer's timing floor is
 * the route's (`minLatencyMs`), not this service's.
 */
export class TrackingService {
  constructor(private readonly dependencies: TrackingServiceDependencies) {}

  get configured(): boolean {
    return this.dependencies.secret !== undefined;
  }

  private now(): Date {
    return this.dependencies.now?.() ?? new Date();
  }

  /**
   * Queues a code only when the email has an order on the site to track.
   * Resolves the same way either way, never revealing a match; does nothing
   * when tracking is unconfigured.
   */
  async requestCode(input: WebsiteScope & { email: string }): Promise<void> {
    const secret = this.dependencies.secret;
    if (secret === undefined) return;

    const scope = { workspaceId: input.workspaceId, actorId: input.actorId };
    const normalizedEmail = normalizeTrackingEmail(input.email);
    if (!(await this.dependencies.store.hasTrackableLeads({ ...scope, normalizedEmail }))) return;

    const code = generateTrackingCode();
    const now = this.now();
    const challengeId = crypto.randomUUID();
    await this.dependencies.store.createChallengeAndQueue({
      ...scope,
      challengeId,
      normalizedEmail,
      emailHash: emailBindingHash(secret, input.workspaceId, normalizedEmail),
      codeHash: codeBindingHash(secret, input.workspaceId, normalizedEmail, code),
      sealedCode: sealTrackingCode(secret, { workspaceId: input.workspaceId, challengeId }, code),
      contactHash: this.dependencies.contactHash(normalizedEmail),
      expiresAt: new Date(now.getTime() + TRACKING_CODE_TTL_MS),
      now,
    });
  }

  /** Consumes the email's newest code; a right one yields a 30-minute grant. */
  async verifyCode(
    input: WebsiteScope & { email: string; code: string },
  ): Promise<TrackingVerifyOutcome> {
    const secret = this.dependencies.secret;
    if (secret === undefined) return { status: 'not_found' };

    const normalizedEmail = normalizeTrackingEmail(input.email);
    const outcome = await this.dependencies.store.consume({
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      normalizedEmail,
      emailHash: emailBindingHash(secret, input.workspaceId, normalizedEmail),
      candidateCodeHash: codeBindingHash(secret, input.workspaceId, normalizedEmail, input.code),
      now: this.now(),
    });
    if (outcome !== 'verified') return { status: outcome };
    const grant = signTrackingGrant(
      secret,
      { workspaceId: input.workspaceId, normalizedEmail },
      this.now().getTime(),
    );
    return { status: 'verified', grant };
  }

  /**
   * The identity a grant proves, or undefined when it is missing, invalid,
   * expired, issued for another site, or tracking is unconfigured.
   */
  identify(token: string | undefined, workspaceId: string): TrackingGrantIdentity | undefined {
    const secret = this.dependencies.secret;
    if (secret === undefined || token === undefined || token.length === 0) return undefined;
    const identity = verifyTrackingGrant(secret, token, this.now().getTime());
    return identity?.workspaceId === workspaceId ? identity : undefined;
  }

  /** The verified email's orders on the site, newest first. */
  async listOrders(scope: WebsiteScope, identity: TrackingGrantIdentity): Promise<TrackingOrder[]> {
    if (identity.workspaceId !== scope.workspaceId) return [];
    return this.dependencies.store.listOrders({
      ...scope,
      normalizedEmail: identity.normalizedEmail,
    });
  }

  /** One of the verified email's orders by its reference, or undefined. */
  async resolveLead(
    scope: WebsiteScope,
    identity: TrackingGrantIdentity,
    reference: string,
  ): Promise<TrackedLeadRef | undefined> {
    if (identity.workspaceId !== scope.workspaceId) return undefined;
    return this.dependencies.store.resolveLead({
      ...scope,
      normalizedEmail: identity.normalizedEmail,
      reference,
    });
  }
}

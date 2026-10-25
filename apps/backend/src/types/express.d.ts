import type { VerifiedStaffSession } from '../auth/session.js';
import type { WebsiteContext } from '../website/session.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by requestId middleware before any route handler runs. */
      id: string;
      /** Present only after the protected staff-session middleware succeeds. */
      staffSession?: VerifiedStaffSession;
      /** Present only after the website credential middleware succeeds. */
      websiteContext?: WebsiteContext;
    }
  }
}

export {};

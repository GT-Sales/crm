/**
 * Why an Ask AI turn failed, in plain words for the owner's monitoring page.
 *
 * The codes are `ai_turns.failure_code`: the stream's error codes
 * (`aiStreamErrorCodeSchema`) when the turn wrote one, `unknown` when it
 * wrote none. The member-facing sentences in `components/ai/assistant-message.tsx`
 * (`aiErrorText`) tell the person asking what to do next ("wait a minute",
 * "ask about a shorter period") and are keyed by the chat's own error kinds,
 * so they do not fit here: this page names the cause for the owner, who acts
 * on the deployment. A code this admin does not know reads as a generic
 * phrase; the page may show the code beside it, never as the label.
 */
const REASONS: ReadonlyMap<string, string> = new Map([
  ['provider_unavailable', 'The AI provider did not answer'],
  ['rate_limited', 'The AI provider was rate limiting'],
  ['timeout', 'The answer took too long'],
  ['budget_exceeded', 'The answer hit its size limit'],
  ['tool_unavailable', 'A CRM lookup the answer needed was not available'],
  ['internal_error', 'The CRM had a problem while answering'],
  ['cancelled', 'The answer was stopped'],
  ['access_lost', 'The person lost access while it answered'],
  ['unknown', 'No reason was recorded'],
]);

/** The phrase for any code a failed turn recorded. */
export function failureReason(code: string): string {
  return REASONS.get(code) ?? OTHER_REASON;
}

/** The phrase for a code this admin does not know yet. */
export const OTHER_REASON = 'Another reason';

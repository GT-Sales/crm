import { LEAD_MAIL_TEXT_MAX } from '@gt-sales/contracts';

/**
 * A sent mail as its timeline entry keeps it: the subject on the first line,
 * the plain text after it, cut to what an entry's `body` holds. Read back by
 * `sentMailOf`.
 */
export function keptMailText(rendered: { subject: string; text: string }): {
  body: string;
  cut: boolean;
} {
  const subject = rendered.subject.replace(/\s*[\r\n]+\s*/g, ' ').trim() || '(no subject)';
  const whole = `${subject}\n${rendered.text.trim()}`;
  if (whole.length <= LEAD_MAIL_TEXT_MAX) return { body: whole, cut: false };
  // Never end on half of a two-unit character.
  const cut = whole.slice(0, LEAD_MAIL_TEXT_MAX).replace(/[\uD800-\uDBFF]$/, '');
  return { body: cut, cut: true };
}

/** The subject and text `keptMailText` stored, or nothing when the entry kept none. */
export function sentMailOf(body: string | null): { subject: string; text: string } | undefined {
  if (!body) return undefined;
  const at = body.indexOf('\n');
  return at === -1
    ? { subject: body, text: '' }
    : { subject: body.slice(0, at), text: body.slice(at + 1) };
}

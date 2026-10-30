/**
 * The documents a plan can require of an order, in the order staff pick them:
 * the backend's default document checklist (`DEFAULT_LEAD_DOCUMENT_TYPES`).
 */
export const PLAN_DOCUMENT_TYPES = [
  'passport',
  'visa',
  'study_permit',
  'work_permit',
  'drivers_licence',
  'provincial_id',
] as const;

const DOCUMENT_TYPE_LABELS: Readonly<Record<string, string>> = {
  passport: 'Passport',
  visa: 'Visa',
  study_permit: 'Study permit',
  work_permit: 'Work permit',
  drivers_licence: "Driver's licence",
  provincial_id: 'Provincial ID',
};

/** The type as staff read it; a key the list does not know reads as its words ("Sin card"). */
export function documentTypeLabel(key: string): string {
  const known = DOCUMENT_TYPE_LABELS[key];
  if (known !== undefined) return known;
  const words = key.replaceAll('_', ' ').trim();
  return words === '' ? key : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

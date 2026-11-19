export const LEAD_WORK_SAVED = 'crm:lead-work-saved';
/** Lead work was saved; `leadId` null for a plain task (it belongs to no lead). */
export function notifyLeadWorkSaved(workspaceId: string, leadId: string | null): void {
  window.dispatchEvent(new CustomEvent(LEAD_WORK_SAVED, { detail: { workspaceId, leadId } }));
}

/** A document was approved or rejected: counts that depend on reviews refresh. */
export const DOCUMENTS_REVIEWED = 'crm:documents-reviewed';
export function notifyDocumentsReviewed(workspaceId: string): void {
  window.dispatchEvent(new CustomEvent(DOCUMENTS_REVIEWED, { detail: { workspaceId } }));
}

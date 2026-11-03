export const LEAD_WORK_SAVED = 'crm:lead-work-saved';
export function notifyLeadWorkSaved(workspaceId: string, leadId: string): void {
  window.dispatchEvent(new CustomEvent(LEAD_WORK_SAVED, { detail: { workspaceId, leadId } }));
}

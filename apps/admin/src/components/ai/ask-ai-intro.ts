/**
 * The one line under Ask AI's greeting: what to ask about, and what it can
 * draft for a person to confirm, by what the site allows.
 */
export function askAiIntro(whose: string, can: { actions: boolean; automations: boolean }): string {
  const drafts = [
    ...(can.actions ? ['a task', 'a note'] : []),
    ...(can.automations ? ['an automation'] : []),
  ];
  const ask = `Ask about ${whose} leads, orders and follow-ups`;
  if (drafts.length === 0) return `${ask}.`;
  const list =
    drafts.length === 1
      ? drafts[0]
      : `${drafts.slice(0, -1).join(', ')} or ${drafts[drafts.length - 1]}`;
  return `${ask}, or draft ${list}.`;
}

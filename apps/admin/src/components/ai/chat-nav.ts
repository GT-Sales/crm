'use client';

import { SparklesIcon, type LucideIcon } from 'lucide-react';

import { useOptionalAssistant } from './assistant-provider';

/**
 * Ask AI's full page as a menu entry. It is not one of the fixed
 * `NAV_ITEMS`: it is listed only once the capability call says Ask AI is
 * available here and the backend stores conversations, the condition the
 * page itself needs (an older backend has no page to go to).
 */
export const ASK_AI_NAV_ITEM = { section: 'chat', label: 'Ask AI', icon: SparklesIcon } as const;

/** A page entry, as the sidebar and Ctrl/Cmd K list them. */
export interface NavEntry {
  readonly section: string;
  readonly label: string;
  readonly icon: LucideIcon;
}

/** True when the sidebar and Ctrl/Cmd K may offer the full Ask AI page. */
export function useAskAiPageAvailable(): boolean {
  return useOptionalAssistant()?.conversations.enabled ?? false;
}

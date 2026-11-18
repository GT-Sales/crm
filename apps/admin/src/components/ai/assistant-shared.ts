'use client';

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import type { LeadType } from '@gt-sales/contracts';

import { aiErrorText } from './assistant-message';
import type { AiMessage } from './assistant-provider';

/**
 * What the side panel and the full page share, so the two surfaces type,
 * scroll and announce in exactly the same way: the suggested questions, the
 * one live-region sentence, the composer's Enter handling and the "stay at
 * the newest message unless the reader scrolled up" rule.
 */

/** A suggested question, offered only when the site has a lead type it needs. */
const SUGGESTED_QUESTIONS: readonly { text: string; leadTypes?: readonly LeadType[] }[] = [
  { text: 'Summarize leads from the last 30 days' },
  { text: 'Which follow-ups are due today or earlier?' },
  { text: 'How are SIM orders distributed by stage?', leadTypes: ['sim_order'] },
  {
    text: 'Which sources brought submitted SIM orders in the last 30 days?',
    leadTypes: ['sim_order'],
  },
];

export function suggestionsFor(leadTypes: readonly LeadType[]): readonly string[] {
  return SUGGESTED_QUESTIONS.filter(
    (question) =>
      question.leadTypes === undefined ||
      question.leadTypes.some((leadType) => leadTypes.includes(leadType)),
  ).map((question) => question.text);
}

/**
 * The live region's one sentence. Progress labels live inside the conversation
 * (announced only by reading), so an answer's tokens are never read out one at
 * a time: only the move to thinking, answering, ready or an error is.
 */
export function announcementFor(messages: readonly AiMessage[], streaming: boolean): string {
  const last = messages[messages.length - 1];
  if (last === undefined) return '';
  if (last.role === 'user') return streaming ? 'Thinking.' : '';
  if (last.status === 'streaming') return last.text.length > 0 ? 'Answering.' : 'Thinking.';
  if (last.status === 'complete') return 'Answer ready.';
  if (last.status === 'stopped') return 'Answer stopped.';
  return aiErrorText(last.error ?? 'failed');
}

/**
 * Enter sends, Shift+Enter is a new line, and nothing is sent while an input
 * method is still composing a character (Japanese, Chinese, Korean input).
 */
export function useComposerKeys(onSubmit: () => void) {
  const composingRef = useRef(false);
  // The newest submit (it reads the newest draft) without new handlers each render.
  const submitRef = useRef(onSubmit);
  submitRef.current = onSubmit;
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    if (event.nativeEvent.isComposing || composingRef.current) return;
    event.preventDefault();
    submitRef.current();
  }, []);
  const onCompositionStart = useCallback(() => {
    composingRef.current = true;
  }, []);
  const onCompositionEnd = useCallback(() => {
    composingRef.current = false;
  }, []);
  return { onKeyDown, onCompositionStart, onCompositionEnd };
}

function isNearBottom(node: HTMLElement): boolean {
  return node.scrollHeight - node.scrollTop - node.clientHeight < 48;
}

/**
 * Keeps a conversation at its newest message while the reader is near the
 * bottom, and lets them read back without being pulled down: once they
 * scroll up, `atBottom` is false and "Jump to latest" brings them back.
 * `follow` is what changes as the answer grows (the messages); `active` is
 * false while the surface is hidden.
 */
export function useConversationScroll(
  follow: unknown,
  active: boolean,
): {
  scrollRef: RefObject<HTMLDivElement | null>;
  atBottom: boolean;
  onScroll(): void;
  jumpToLatest(): void;
  resetToBottom(): void;
} {
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  const onScroll = useCallback(() => {
    const node = scrollRef.current;
    if (node === null) return;
    const near = isNearBottom(node);
    atBottomRef.current = near;
    setAtBottom(near);
  }, []);

  useLayoutEffect(() => {
    if (!active) return;
    const node = scrollRef.current;
    if (node === null || !atBottomRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [active, follow]);

  const resetToBottom = useCallback(() => {
    atBottomRef.current = true;
    setAtBottom(true);
  }, []);

  const jumpToLatest = useCallback(() => {
    const node = scrollRef.current;
    if (node === null) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    if (typeof node.scrollTo === 'function') {
      node.scrollTo({ top: node.scrollHeight, behavior: reduced ? 'auto' : 'smooth' });
    } else {
      node.scrollTop = node.scrollHeight;
    }
    atBottomRef.current = true;
    setAtBottom(true);
  }, []);

  return { scrollRef, atBottom, onScroll, jumpToLatest, resetToBottom };
}

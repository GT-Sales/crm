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

import { describeError } from '../../lib/error-text';
import { aiErrorText } from './assistant-message';
import type { AiMessage, AssistantCapabilities } from './assistant-provider';

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
  return aiErrorText(last.error ?? 'failed', last.retryAfterSeconds);
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

/**
 * What the page and the panel say when Ask AI cannot be used here, by why:
 * the sign-in expired (the sentence the rest of the CRM uses), the member's
 * access changed (the access-removed wording), or the CRM could not say.
 * Each offers Try again, which asks for the capabilities once more. Never a
 * raw code.
 */
export function capabilityFailureText(
  capabilities: Extract<AssistantCapabilities, { status: 'failed' }>,
): { title: string; text: string } {
  switch (capabilities.reason) {
    case 'session':
      return {
        title: 'Your sign-in has expired',
        text: describeError(capabilities.failure ?? 'invalid_session', 'use Ask AI'),
      };
    case 'access':
      return {
        title: 'Your access to this site changed',
        text:
          capabilities.failure === undefined
            ? 'Your access to this site changed. Ask the owner if you need it back.'
            : describeError(capabilities.failure, 'use Ask AI'),
      };
    case 'unavailable':
      return {
        title: 'Ask AI is not available right now',
        text: 'The CRM could not say whether Ask AI is on for this site. Try again in a moment.',
      };
  }
}

/** A click on Stop this soon after the click that sent is the second half of a double-click. */
export const STOP_GUARD_MS = 600;

/**
 * Keeps a double-click on Send from stopping the answer it started: Send
 * turns into Stop in the same place, so the second click of a double-click
 * lands on Stop. That click (a pointer click whose `detail`, the click count,
 * is 2 or more) within `STOP_GUARD_MS` of the send is ignored. A single click
 * on Stop, however soon, and a keyboard press (`detail` 0) are never held
 * back, and nothing is disabled, so the button does not flicker.
 */
export function useStopGuard(now: () => number = Date.now) {
  const sentAt = useRef(Number.NEGATIVE_INFINITY);
  const markSent = useCallback(() => {
    sentAt.current = now();
  }, [now]);
  const ignoreStop = useCallback(
    (event: { detail: number }) => event.detail > 1 && now() - sentAt.current < STOP_GUARD_MS,
    [now],
  );
  return { markSent, ignoreStop };
}

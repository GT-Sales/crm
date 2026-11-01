'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  AI_ASSISTANT_LIMITS,
  type AiCapabilitiesResponse,
  type AiSource,
  type AiStreamPart,
} from '@gt-sales/contracts';

import { buildAiChatRequest, streamAnswer, uiErrorForStreamCode } from '../../lib/ai-transport';
import type { AiRequestLimits, AiUiError, AiHistoryEntry } from '../../lib/ai-transport';
import { getAiCapabilities } from '../../lib/api';

/**
 * Ask AI's client state. The conversation lives in memory only: no storage,
 * no provider key, nothing that survives a sign-out. One composite key
 * (site + credential) owns it, and a generation counter makes every late
 * stream part harmless after a stop, a reset or a credential change.
 */

export interface AiUserMessage {
  id: string;
  role: 'user';
  text: string;
}

export interface AiAssistantMessage {
  id: string;
  role: 'assistant';
  text: string;
  status: 'streaming' | 'complete' | 'stopped' | 'error';
  sources: readonly AiSource[];
  /** The current tool's plain-language label, never announced as a live region. */
  progress?: string;
  error?: AiUiError;
}

export type AiMessage = AiUserMessage | AiAssistantMessage;

export type AssistantCapabilities =
  { status: 'loading' } | { status: 'failed' } | { status: 'ready'; data: AiCapabilitiesResponse };

export interface AssistantWorkspace {
  id: string;
  slug: string;
  name: string;
}

interface SessionState {
  key: string;
  messages: readonly AiMessage[];
  streaming: boolean;
}

interface CapabilitiesState {
  key: string;
  value: AssistantCapabilities;
}

export interface AssistantContextValue {
  capabilities: AssistantCapabilities;
  messages: readonly AiMessage[];
  streaming: boolean;
  isOpen: boolean;
  activeLeadId?: string;
  /** The selected Site's name, always available even before capabilities load. */
  siteName: string;
  maxMessageChars: number;
  open(returnFocusTo?: HTMLElement): void;
  close(): void;
  newChat(): void;
  send(text: string): void;
  stop(): void;
  retry(): void;
}

const AssistantContext = createContext<AssistantContextValue | undefined>(undefined);

let messageSequence = 0;

function nextMessageId(): string {
  messageSequence += 1;
  return `message-${messageSequence}`;
}

function emptySession(key: string): SessionState {
  return { key, messages: [], streaming: false };
}

function toHistory(messages: readonly AiMessage[]): AiHistoryEntry[] {
  const history: AiHistoryEntry[] = [];
  for (const message of messages) {
    if (message.text.length > 0) history.push({ role: message.role, text: message.text });
  }
  return history;
}

/** A uuid v4; `crypto.randomUUID` when the runtime has it, a small fallback otherwise. */
function randomUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function AssistantProvider({
  workspace,
  accessToken,
  activeLeadId,
  children,
}: {
  workspace: AssistantWorkspace;
  accessToken: string;
  activeLeadId?: string;
  children: ReactNode;
}) {
  // The credential and the site together own the conversation. Comparing this
  // key during render clears it before a stale turn can paint; the abort and
  // the generation bump make every part already in flight a no-op.
  const sessionKey = `${workspace.id}:${workspace.slug}:${accessToken}`;

  const [isOpen, setIsOpen] = useState(false);
  const [session, setSession] = useState<SessionState>(() => emptySession(sessionKey));
  const sessionRef = useRef(session);
  const [capabilitiesState, setCapabilitiesState] = useState<CapabilitiesState>(() => ({
    key: sessionKey,
    value: { status: 'loading' },
  }));
  const abortRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const capabilitiesGenerationRef = useRef(0);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  if (session.key !== sessionKey) {
    abortRef.current?.abort();
    abortRef.current = null;
    generationRef.current += 1;
    const reset = emptySession(sessionKey);
    sessionRef.current = reset;
    setSession(reset);
  }

  const activeSession = useMemo<SessionState>(
    () => (session.key === sessionKey ? session : emptySession(sessionKey)),
    [session, sessionKey],
  );
  const capabilities = useMemo<AssistantCapabilities>(
    () => (capabilitiesState.key === sessionKey ? capabilitiesState.value : { status: 'loading' }),
    [capabilitiesState, sessionKey],
  );

  useEffect(() => {
    const requestGeneration = ++capabilitiesGenerationRef.current;
    if (accessToken.length === 0) {
      setCapabilitiesState({ key: sessionKey, value: { status: 'failed' } });
      return;
    }
    let current = true;
    void getAiCapabilities(accessToken, workspace.id).then(
      (data) => {
        if (!current || capabilitiesGenerationRef.current !== requestGeneration) return;
        setCapabilitiesState({ key: sessionKey, value: { status: 'ready', data } });
      },
      () => {
        if (!current || capabilitiesGenerationRef.current !== requestGeneration) return;
        setCapabilitiesState({ key: sessionKey, value: { status: 'failed' } });
      },
    );
    return () => {
      current = false;
    };
  }, [accessToken, sessionKey, workspace.id]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      generationRef.current += 1;
    },
    [],
  );

  const commitSession = useCallback((next: SessionState) => {
    sessionRef.current = next;
    setSession(next);
  }, []);

  const applyPart = useCallback(
    (assistantId: string, part: AiStreamPart) => {
      const current = sessionRef.current;
      const messages = current.messages.map((message): AiMessage => {
        if (message.id !== assistantId || message.role !== 'assistant') return message;
        if (part.type === 'text') {
          return { ...message, text: message.text + part.text, progress: undefined };
        }
        if (part.type === 'progress') return { ...message, progress: part.label };
        if (part.type === 'sources') {
          // A turn may send its cards in more than one part; a repeated id wins.
          const byId = new Map<string, AiSource>();
          for (const source of message.sources) byId.set(source.id, source);
          for (const source of part.sources) byId.set(source.id, source);
          return { ...message, sources: [...byId.values()] };
        }
        if (part.type === 'error') {
          return {
            ...message,
            status: 'error',
            error: uiErrorForStreamCode(part.code),
            progress: undefined,
          };
        }
        return message;
      });
      commitSession({ ...current, messages });
    },
    [commitSession],
  );

  const finalize = useCallback(
    (assistantId: string, result: AiUiError | undefined) => {
      const current = sessionRef.current;
      const messages = current.messages.map((message): AiMessage => {
        if (message.id !== assistantId || message.role !== 'assistant') return message;
        if (result === undefined) return { ...message, status: 'complete', progress: undefined };
        if (result === 'cancelled') return { ...message, status: 'stopped', progress: undefined };
        return { ...message, status: 'error', error: result, progress: undefined };
      });
      commitSession({ ...current, messages, streaming: false });
    },
    [commitSession],
  );

  const startTurn = useCallback(
    (
      text: string,
      base: readonly AiMessage[],
      userMessage: AiUserMessage,
      limits: AiRequestLimits,
    ) => {
      const run = generationRef.current + 1;
      generationRef.current = run;
      const controller = new AbortController();
      abortRef.current = controller;
      const assistant: AiAssistantMessage = {
        id: nextMessageId(),
        role: 'assistant',
        text: '',
        status: 'streaming',
        sources: [],
      };
      commitSession({
        key: sessionKey,
        messages: [...base, userMessage, assistant],
        streaming: true,
      });
      const built = buildAiChatRequest({
        message: text,
        history: toHistory(base),
        limits,
        requestId: randomUuid(),
        ...(activeLeadId === undefined ? {} : { leadId: activeLeadId }),
      });
      void (async () => {
        const result = await streamAnswer({
          accessToken,
          workspaceId: workspace.id,
          request: built.request,
          signal: controller.signal,
          onPart(part) {
            if (generationRef.current !== run) return;
            applyPart(assistant.id, part);
          },
        });
        if (generationRef.current !== run) return;
        if (abortRef.current === controller) abortRef.current = null;
        finalize(assistant.id, result);
      })();
    },
    [accessToken, activeLeadId, applyPart, commitSession, finalize, sessionKey, workspace.id],
  );

  const open = useCallback((returnFocusTo?: HTMLElement) => {
    // The trigger itself is the safest return target: a browser does not always
    // focus a button that was clicked.
    const active = document.activeElement;
    returnFocusRef.current = returnFocusTo ?? (active instanceof HTMLElement ? active : null);
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    // Closing a panel cancels its work: the answer must not keep streaming (or
    // keep a provider spend running) behind a closed panel. Completed messages
    // stay in memory for the next open.
    const current = sessionRef.current;
    if (current.streaming) {
      generationRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      const messages = current.messages.map((message): AiMessage =>
        message.role === 'assistant' && message.status === 'streaming'
          ? { ...message, status: 'stopped', progress: undefined }
          : message,
      );
      commitSession({ ...current, messages, streaming: false });
    }
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    setIsOpen(false);
    if (target?.isConnected === true) target.focus();
  }, [commitSession]);

  const newChat = useCallback(() => {
    generationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    commitSession(emptySession(sessionKey));
  }, [commitSession, sessionKey]);

  const stop = useCallback(() => {
    const current = sessionRef.current;
    if (!current.streaming) return;
    generationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    const messages = current.messages.map((message): AiMessage =>
      message.role === 'assistant' && message.status === 'streaming'
        ? { ...message, status: 'stopped', progress: undefined }
        : message,
    );
    commitSession({ ...current, messages, streaming: false });
  }, [commitSession]);

  const send = useCallback(
    (raw: string) => {
      const current = sessionRef.current;
      if (current.streaming || capabilities.status !== 'ready') return;
      if (!capabilities.data.available) return;
      const text = raw.trim().slice(0, capabilities.data.limits.maxMessageChars);
      if (text.length === 0) return;
      startTurn(
        text,
        current.messages,
        { id: nextMessageId(), role: 'user', text },
        capabilities.data.limits,
      );
    },
    [capabilities, startTurn],
  );

  const retry = useCallback(() => {
    const current = sessionRef.current;
    if (current.streaming || capabilities.status !== 'ready') return;
    if (!capabilities.data.available) return;
    const assistantIndex = current.messages.length - 1;
    const failed = current.messages[assistantIndex];
    if (failed === undefined || failed.role !== 'assistant' || failed.status !== 'error') return;
    const userIndex = assistantIndex - 1;
    const user = current.messages[userIndex];
    if (user === undefined || user.role !== 'user') return;
    startTurn(user.text, current.messages.slice(0, userIndex), user, capabilities.data.limits);
  }, [capabilities, startTurn]);

  const value = useMemo<AssistantContextValue>(
    () => ({
      capabilities,
      messages: activeSession.messages,
      streaming: activeSession.streaming,
      isOpen,
      ...(activeLeadId === undefined ? {} : { activeLeadId }),
      siteName: capabilities.status === 'ready' ? capabilities.data.site.name : workspace.name,
      maxMessageChars:
        capabilities.status === 'ready'
          ? Math.min(capabilities.data.limits.maxMessageChars, AI_ASSISTANT_LIMITS.maxMessageChars)
          : AI_ASSISTANT_LIMITS.maxMessageChars,
      open,
      close,
      newChat,
      send,
      stop,
      retry,
    }),
    [
      activeLeadId,
      activeSession,
      capabilities,
      close,
      isOpen,
      newChat,
      open,
      retry,
      send,
      stop,
      workspace.name,
    ],
  );

  return <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>;
}

export function useAssistant(): AssistantContextValue {
  const value = useContext(AssistantContext);
  if (!value) throw new Error('useAssistant must be used inside AssistantProvider');
  return value;
}

import { AI_ASSISTANT_LIMITS, type AiStreamErrorCode } from '@gt-sales/contracts';
import {
  APICallError,
  createGateway,
  stepCountIs,
  streamText,
  type FilePart,
  type ModelMessage,
  type TextPart,
  type ToolSet,
  type LanguageModel,
} from 'ai';

import { attachedFileBlock, omittedFileNote } from './prompt.js';
import { assertAssistantToolPolicy } from './tool-policy.js';

/**
 * The model adapter: one interface, two implementations.
 *
 * The gateway engine is the only place a provider is constructed, so changing
 * providers or models is localised here. The fake engine is injected by tests
 * (never by a request parameter) and can emit chunks, call tools, hang, fail or
 * exceed budgets deterministically — which is how the streaming, cancellation
 * and error paths are verified without an API key.
 */

export type EngineEvent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool-start'; readonly toolName: string }
  | { readonly type: 'tool-end'; readonly toolName: string; readonly ok: boolean }
  | {
      readonly type: 'finish';
      /** Prompt tokens over every step of the turn (the SDK's `totalUsage`); a count only. */
      readonly inputTokens?: number;
      readonly outputTokens?: number;
      readonly steps?: number;
    };

/**
 * A file a member attached to one of their messages, as the model receives
 * it. Image and PDF bytes were read from the object store for this turn only
 * (bounded by the row's own size) and are never logged; a text file arrives
 * as its stored decoded text. `omitted` is a file this turn could not carry
 * (the per-turn file limits): the model is told it is not available rather
 * than left to guess at it.
 */
export type EngineAttachment =
  | {
      readonly kind: 'image';
      readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
      readonly fileName: string;
      readonly data: Uint8Array;
    }
  | {
      readonly kind: 'pdf';
      readonly mediaType: 'application/pdf';
      readonly fileName: string;
      readonly data: Uint8Array;
    }
  | { readonly kind: 'text'; readonly fileName: string; readonly text: string }
  | { readonly kind: 'omitted'; readonly fileName: string };

/** One turn of the conversation the model is shown; only a member's message carries files. */
export interface EngineMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly attachments?: readonly EngineAttachment[];
}

export interface EngineInput {
  readonly system: string;
  readonly automationAuthoring?: boolean;
  /** Whether the turn already holds a signed card (an action or an automation draft). */
  readonly hasPreparedDraft?: () => boolean;
  readonly messages: readonly EngineMessage[];
  readonly tools: ToolSet;
  readonly signal: AbortSignal;
  /** Injected for the fake engine; the gateway engine lets the SDK execute tools. */
  readonly executeTool?: (name: string, input: unknown) => Promise<string>;
}

export interface AssistantEngine {
  readonly kind: 'gateway' | 'fake';
  stream(input: EngineInput): AsyncIterable<EngineEvent>;
}

/** Raised by the gateway engine when the provider could not answer at all. */
export class AssistantProviderError extends Error {
  readonly code: AiStreamErrorCode;
  constructor(code: AiStreamErrorCode = 'provider_unavailable') {
    super('assistant provider failed');
    this.name = 'AssistantProviderError';
    this.code = code;
  }
}

/**
 * The SDK's messages. A message without files is plain text, exactly as
 * before. A member's message with files becomes multi-part content: each
 * image and PDF a file part with its bytes and verified media type (the v7
 * `FilePart`; its `ImagePart` is deprecated in favour of a file part with an
 * image media type), then the text, to which each text file is added as a
 * delimited block naming the file. Never a URL: the provider gets bytes, not
 * a link to our storage.
 */
export function toModelMessages(messages: readonly EngineMessage[]): ModelMessage[] {
  return messages.map((message): ModelMessage => {
    if (message.role === 'assistant') return { role: 'assistant', content: message.text };
    const attachments = message.attachments ?? [];
    if (attachments.length === 0) return { role: 'user', content: message.text };
    const files: FilePart[] = [];
    const blocks: string[] = [];
    for (const attachment of attachments) {
      switch (attachment.kind) {
        case 'image':
        case 'pdf':
          files.push({
            type: 'file',
            mediaType: attachment.mediaType,
            data: { type: 'data', data: attachment.data },
          });
          break;
        case 'text':
          blocks.push(attachedFileBlock(attachment.fileName, attachment.text));
          break;
        case 'omitted':
          blocks.push(omittedFileNote(attachment.fileName));
          break;
      }
    }
    const text = [message.text, ...blocks].join('\n\n');
    if (files.length === 0) return { role: 'user', content: text };
    return { role: 'user', content: [...files, { type: 'text', text } satisfies TextPart] };
  });
}

/**
 * The real engine: Vercel AI SDK over the AI Gateway, one model, bounded steps.
 * No fallback model, no fabrication: a provider failure raises and the route
 * turns it into a typed, sanitized stream error.
 */
export function createGatewayEngine(
  options: { apiKey: string; modelId: string; providers?: readonly string[] },
  modelForTest?: LanguageModel,
): AssistantEngine {
  return {
    kind: 'gateway',
    async *stream(input) {
      assertAssistantToolPolicy(input.tools);
      const gateway = createGateway({ apiKey: options.apiKey });
      const result = streamText({
        model: modelForTest ?? gateway(options.modelId),
        system: input.system,
        messages: toModelMessages(input.messages),
        tools: input.tools,
        // Five generations at most, the answer step included.
        stopWhen: stepCountIs(AI_ASSISTANT_LIMITS.maxModelSteps),
        maxOutputTokens: input.automationAuthoring
          ? AI_ASSISTANT_LIMITS.maxAuthoringOutputTokens
          : AI_ASSISTANT_LIMITS.maxOutputTokens,
        // One automatic retry is allowed before any text has been shown; the
        // route never retries a partially streamed answer.
        maxRetries: 1,
        abortSignal: input.signal,
        // Pin the hosts that may serve the model (AI_GATEWAY_PROVIDERS).
        ...(options.providers
          ? {
              providerOptions: {
                gateway: { only: [...options.providers], order: [...options.providers] },
              },
            }
          : {}),
        // SDK defaults log raw provider errors (potentially prompts and bodies).
        // The route records only its fixed error code.
        onError: () => {},
      });

      try {
        for await (const part of result.fullStream) {
          switch (part.type) {
            case 'text-delta':
              if (part.text.length > 0) yield { type: 'text', text: part.text };
              break;
            case 'tool-call':
              yield { type: 'tool-start', toolName: part.toolName };
              break;
            case 'tool-result':
              yield { type: 'tool-end', toolName: part.toolName, ok: true };
              break;
            case 'tool-error':
              yield { type: 'tool-end', toolName: part.toolName, ok: false };
              break;
            case 'error':
              throw new AssistantProviderError(
                APICallError.isInstance(part.error) && part.error.statusCode === 429
                  ? 'rate_limited'
                  : 'provider_unavailable',
              );
            case 'abort':
              throw new AssistantProviderError('cancelled');
            case 'finish': {
              // A validated, signed draft remains reviewable when the last allowed
              // generation ends with a successful tool call rather than prose.
              const preparedAtStepLimit =
                part.finishReason === 'tool-calls' && input.hasPreparedDraft?.() === true;
              if (
                part.finishReason === 'error' ||
                part.finishReason === 'length' ||
                (part.finishReason === 'tool-calls' && !preparedAtStepLimit)
              )
                throw new AssistantProviderError('budget_exceeded');
              // The SDK synthesizes `other` when a provider stream closes
              // without a finish frame. That is not a completed answer.
              if (part.finishReason !== 'stop' && !preparedAtStepLimit)
                throw new AssistantProviderError();
              yield {
                type: 'finish',
                ...(part.totalUsage.inputTokens === undefined
                  ? {}
                  : { inputTokens: part.totalUsage.inputTokens }),
                ...(part.totalUsage.outputTokens === undefined
                  ? {}
                  : { outputTokens: part.totalUsage.outputTokens }),
              };
              break;
            }
            default:
              // Reasoning, sources and raw provider parts are never forwarded.
              break;
          }
        }
      } finally {
        // The SDK owns the upstream connection; aborting the signal closes it.
      }
    },
  };
}

/** What a scripted fake turn does, in order. */
export interface FakeTurn {
  readonly toolCalls?: readonly { readonly name: string; readonly input: unknown }[];
  readonly chunks?: readonly string[];
  /** A provider-style failure the route must map to a typed error. */
  readonly failWith?: AiStreamErrorCode;
  /** How long to wait before the first chunk, to exercise cancellation. */
  readonly hangMs?: number;
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
}

/** The fake engine, with every input it was given, in order, for tests to assert on. */
export interface FakeAssistantEngine extends AssistantEngine {
  readonly kind: 'fake';
  readonly inputs: EngineInput[];
}

/**
 * A deterministic stand-in for the model. It yields the same event kinds as the
 * gateway engine, so the HTTP layer, the budget accounting and the stream
 * writer are exercised by tests exactly as they are in production.
 */
export function createFakeEngine(turns: readonly FakeTurn[]): FakeAssistantEngine {
  let index = 0;
  const inputs: EngineInput[] = [];
  return {
    kind: 'fake',
    inputs,
    async *stream(input: EngineInput) {
      inputs.push(input);
      const turn = turns[Math.min(index, turns.length - 1)] ?? {};
      index += 1;

      if (turn.hangMs !== undefined) {
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            clearTimeout(timer);
            reject(new AssistantProviderError('cancelled'));
          };
          const timer = setTimeout(() => {
            input.signal.removeEventListener('abort', onAbort);
            resolve();
          }, turn.hangMs);
          input.signal.addEventListener('abort', onAbort, { once: true });
          if (input.signal.aborted) onAbort();
        });
      }

      if (turn.failWith !== undefined) throw new AssistantProviderError(turn.failWith);

      for (const call of turn.toolCalls ?? []) {
        yield { type: 'tool-start', toolName: call.name };
        let ok = true;
        try {
          if (!input.executeTool) throw new Error('fake engine needs an executor');
          await input.executeTool(call.name, call.input);
        } catch {
          ok = false;
        }
        yield { type: 'tool-end', toolName: call.name, ok };
      }

      for (const chunk of turn.chunks ?? ['No answer.']) {
        if (input.signal.aborted) throw new AssistantProviderError('cancelled');
        yield { type: 'text', text: chunk };
      }

      yield { type: 'finish', ...(turn.usage ?? {}) };
    },
  };
}

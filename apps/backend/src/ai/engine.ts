import { AI_ASSISTANT_LIMITS, type AiStreamErrorCode } from '@gt-sales/contracts';
import {
  APICallError,
  createGateway,
  stepCountIs,
  streamText,
  type ModelMessage,
  type ToolSet,
  type LanguageModel,
} from 'ai';

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
      readonly outputTokens?: number;
      readonly steps?: number;
    };

export interface EngineInput {
  readonly system: string;
  readonly automationAuthoring?: boolean;
  readonly messages: readonly { role: 'user' | 'assistant'; text: string }[];
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

function toModelMessages(
  messages: readonly { role: 'user' | 'assistant'; text: string }[],
): ModelMessage[] {
  return messages.map((message) =>
    message.role === 'user'
      ? { role: 'user' as const, content: message.text }
      : { role: 'assistant' as const, content: message.text },
  );
}

/**
 * The real engine: Vercel AI SDK over the AI Gateway, one model, bounded steps.
 * No fallback model, no fabrication: a provider failure raises and the route
 * turns it into a typed, sanitized stream error.
 */
export function createGatewayEngine(
  options: { apiKey: string; modelId: string },
  modelForTest?: LanguageModel,
): AssistantEngine {
  return {
    kind: 'gateway',
    async *stream(input) {
      const gateway = createGateway({ apiKey: options.apiKey });
      const result = streamText({
        model: modelForTest ?? gateway(options.modelId),
        system: input.system,
        messages: toModelMessages(input.messages),
        tools: input.tools,
        // Five generations at most, the answer step included.
        stopWhen: stepCountIs(AI_ASSISTANT_LIMITS.maxModelSteps),
        maxOutputTokens: input.automationAuthoring ? 4800 : AI_ASSISTANT_LIMITS.maxOutputTokens,
        // One automatic retry is allowed before any text has been shown; the
        // route never retries a partially streamed answer.
        maxRetries: 1,
        abortSignal: input.signal,
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
            case 'finish':
              if (
                part.finishReason === 'error' ||
                part.finishReason === 'length' ||
                part.finishReason === 'tool-calls'
              )
                throw new AssistantProviderError('budget_exceeded');
              // The SDK synthesizes `other` when a provider stream closes
              // without a finish frame. That is not a completed answer.
              if (part.finishReason !== 'stop') throw new AssistantProviderError();
              yield {
                type: 'finish',
                ...(part.totalUsage.outputTokens === undefined
                  ? {}
                  : { outputTokens: part.totalUsage.outputTokens }),
              };
              break;
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
  readonly usage?: { readonly outputTokens?: number };
}

/**
 * A deterministic stand-in for the model. It yields the same event kinds as the
 * gateway engine, so the HTTP layer, the budget accounting and the stream
 * writer are exercised by tests exactly as they are in production.
 */
export function createFakeEngine(turns: readonly FakeTurn[]): AssistantEngine {
  let index = 0;
  return {
    kind: 'fake',
    async *stream(input: EngineInput) {
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

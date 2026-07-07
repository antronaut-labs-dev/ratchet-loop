/**
 * Anthropic (Claude) maker adapter — the official SDK, kept deliberately thin.
 *
 * Structured outputs pin the response to the Patch schema, so parsing never
 * guesses. Note what this file does NOT do: decide when the loop is done.
 * That stays with your check.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { GenerateFn, LoopContext } from 'ratchet-loop';
import { buildUserPrompt, MAKER_SYSTEM_PROMPT, parsePatch, PATCH_SCHEMA } from './shared.js';

export interface AnthropicAdapterOptions {
  /** Default: ANTHROPIC_API_KEY env var (or an `ant auth login` profile). */
  apiKey?: string;
  /** Default: claude-opus-4-8. */
  model?: string;
  /** Default: 32000. */
  maxTokens?: number;
  /** USD per million tokens, used to feed `budget.usd`. Default: Opus 4.8 list price. */
  pricing?: { usdPerMTokIn: number; usdPerMTokOut: number };
  /** Override the toy prompt builder. */
  buildPrompt?: (ctx: LoopContext) => Promise<string> | string;
}

export function anthropicGenerate(opts: AnthropicAdapterOptions = {}): GenerateFn {
  const client = new Anthropic(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {});
  const model = opts.model ?? 'claude-opus-4-8';
  const pricing = opts.pricing ?? { usdPerMTokIn: 5, usdPerMTokOut: 25 };
  return async (ctx) => {
    const user = await (opts.buildPrompt ?? buildUserPrompt)(ctx);
    // Stream (long outputs) and collect the final message; adaptive thinking on.
    const stream = client.messages.stream({
      model,
      max_tokens: opts.maxTokens ?? 32_000,
      thinking: { type: 'adaptive' },
      system: MAKER_SYSTEM_PROMPT,
      output_config: { format: { type: 'json_schema', schema: PATCH_SCHEMA } },
      messages: [{ role: 'user', content: user }],
    });
    const message = await stream.finalMessage();
    if (message.stop_reason === 'refusal') {
      throw new Error('the model declined this request (stop_reason: refusal)');
    }
    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');
    const patch = parsePatch(text);
    const usd =
      (message.usage.input_tokens / 1e6) * pricing.usdPerMTokIn +
      (message.usage.output_tokens / 1e6) * pricing.usdPerMTokOut;
    return {
      ...patch,
      cost: {
        usd,
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
      },
    };
  };
}

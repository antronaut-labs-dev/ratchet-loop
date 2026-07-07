/**
 * OpenAI-compatible maker adapter — plain fetch, no SDK.
 *
 * Because `baseURL` is configurable, this one adapter also covers every
 * OpenAI-compatible endpoint: Kimi (api.moonshot.ai), GLM (open.bigmodel.cn),
 * Gemini's OpenAI-compat endpoint, together.ai, or a local server
 * (`http://localhost:11434/v1` for Ollama). The ratchet-loop core never sees
 * any of this — a maker is just a function.
 */
import type { GenerateFn, LoopContext } from 'ratchet-loop';
import { buildUserPrompt, MAKER_SYSTEM_PROMPT, parsePatch } from './shared.js';

export interface OpenAICompatibleOptions {
  /** Default: OPENAI_API_KEY env var. */
  apiKey?: string;
  /** Default: gpt-5 — override for your account/provider. */
  model?: string;
  /** Default: https://api.openai.com/v1 — point at any OpenAI-compatible server. */
  baseURL?: string;
  /** Override the toy prompt builder. */
  buildPrompt?: (ctx: LoopContext) => Promise<string> | string;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export function openaiGenerate(opts: OpenAICompatibleOptions = {}): GenerateFn {
  const baseURL = (opts.baseURL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = opts.model ?? 'gpt-5';
  return async (ctx) => {
    const apiKey = opts.apiKey ?? process.env['OPENAI_API_KEY'];
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error('openaiGenerate: set OPENAI_API_KEY or pass { apiKey }');
    }
    const user = await (opts.buildPrompt ?? buildUserPrompt)(ctx);
    const res = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: MAKER_SYSTEM_PROMPT },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) {
      throw new Error(`OpenAI-compatible endpoint returned ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as ChatCompletionResponse;
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new Error('no completion text in response');
    const patch = parsePatch(text);
    return {
      ...patch,
      cost: {
        ...(data.usage?.prompt_tokens !== undefined
          ? { inputTokens: data.usage.prompt_tokens }
          : {}),
        ...(data.usage?.completion_tokens !== undefined
          ? { outputTokens: data.usage.completion_tokens }
          : {}),
      },
    };
  };
}

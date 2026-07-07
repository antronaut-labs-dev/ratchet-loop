/**
 * Local model maker adapter — Ollama's native API, no key, no SDK, no cloud.
 *
 * `ollama pull qwen2.5-coder` then run the loop. For local servers that speak
 * the OpenAI protocol instead, use `openaiGenerate({ baseURL: 'http://localhost:11434/v1' })`.
 */
import type { GenerateFn, LoopContext } from 'ratchet-loop';
import { buildUserPrompt, MAKER_SYSTEM_PROMPT, parsePatch } from './shared.js';

export interface LocalAdapterOptions {
  /** Default: qwen2.5-coder */
  model?: string;
  /** Default: http://localhost:11434 */
  baseURL?: string;
  buildPrompt?: (ctx: LoopContext) => Promise<string> | string;
}

interface OllamaChatResponse {
  message?: { content?: string };
}

export function localGenerate(opts: LocalAdapterOptions = {}): GenerateFn {
  const baseURL = (opts.baseURL ?? 'http://localhost:11434').replace(/\/$/, '');
  const model = opts.model ?? 'qwen2.5-coder';
  return async (ctx) => {
    const user = await (opts.buildPrompt ?? buildUserPrompt)(ctx);
    const res = await fetch(`${baseURL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        format: 'json',
        messages: [
          { role: 'system', content: MAKER_SYSTEM_PROMPT },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) {
      throw new Error(
        `Ollama returned ${res.status} — is it running? (\`ollama serve\`, then \`ollama pull ${model}\`)`,
      );
    }
    const data = (await res.json()) as OllamaChatResponse;
    const text = data.message?.content;
    if (typeof text !== 'string') throw new Error('no completion text in Ollama response');
    return parsePatch(text);
  };
}

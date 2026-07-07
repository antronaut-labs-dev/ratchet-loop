/**
 * Shared plumbing for the example adapters: a prompt builder, a strict JSON
 * schema for patches, and a defensive parser. This is deliberately toy-grade —
 * it snapshots a small repo into the prompt. Real products bring their own
 * context strategy; ratchet-loop's core doesn't care either way.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FileChange, LoopContext, Patch } from 'ratchet-loop';

/** JSON Schema for the maker's output (used verbatim by structured outputs). */
export const PATCH_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'One line describing the change.' },
    files: {
      type: 'array',
      description: 'Files to write. Empty when claimsDone is true.',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the repo root.' },
          contents: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
            description: 'The FULL new file body. null deletes the file.',
          },
        },
        required: ['path', 'contents'],
        additionalProperties: false,
      },
    },
    claimsDone: {
      type: 'boolean',
      description:
        'True only if you believe the goal is already met with no changes. The external check verifies either way.',
    },
    reflection: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: '1-2 sentence self-critique of the previous failed attempt, when asked for one.',
    },
  },
  required: ['summary', 'files', 'claimsDone', 'reflection'],
  additionalProperties: false,
} as const;

export const MAKER_SYSTEM_PROMPT = [
  'You are the maker inside a ratchet loop. An external check — not you — decides when the goal is met.',
  'Each attempt, produce the smallest patch that could make the check pass.',
  'Respond with a single JSON object: {"summary": string, "files": [{"path": string, "contents": string | null}], "claimsDone": boolean, "reflection": string | null}.',
  '"contents" is the FULL new body of the file (not a diff); null deletes the file.',
  'Set claimsDone=true only if you are convinced no change is needed. The check will judge that claim.',
].join(' ');

const SKIP_DIRS = new Set(['.git', 'node_modules', '.ratchet', 'dist', 'coverage', 'build']);
const PER_FILE_CAP = 8_000;
const TOTAL_CAP = 48_000;

/** Snapshot a small repo as `--- path ---` blocks for the prompt (toy context builder). */
export async function snapshotFiles(workdir: string): Promise<string> {
  const chunks: string[] = [];
  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (total >= TOTAL_CAP) return;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.stat(abs);
      if (stat.size > 64_000) continue;
      const contents = await fs.readFile(abs, 'utf8').catch(() => '');
      if (contents.includes('\u0000')) continue; // binary
      const rel = path.relative(workdir, abs).replaceAll('\\', '/');
      const body =
        contents.length > PER_FILE_CAP
          ? `${contents.slice(0, PER_FILE_CAP)}\n…(truncated)`
          : contents;
      chunks.push(`--- ${rel} ---\n${body}`);
      total += body.length;
    }
  };
  await walk(workdir);
  return chunks.join('\n\n');
}

/** Default prompt: goal, where the loop stands, the last failure's evidence, and the repo. */
export async function buildUserPrompt(ctx: LoopContext): Promise<string> {
  const parts = [`Goal: ${ctx.goal}`, `Attempt ${ctx.attempt} of ${ctx.maxAttempts}.`];
  if (ctx.reflection !== undefined) parts.push(ctx.reflection);
  else if (ctx.lastFailure !== undefined) {
    parts.push(
      `The previous attempt failed its check. Evidence:\n${ctx.lastFailure.evidence.slice(-4_000)}`,
    );
  }
  parts.push(`Repository snapshot:\n\n${await snapshotFiles(ctx.workdir)}`);
  return parts.join('\n\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Parse the model's JSON (tolerating code fences) into a Patch, or throw loudly. */
export function parsePatch(text: string): Patch {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    throw new Error(
      `model did not return valid patch JSON (${err instanceof Error ? err.message : String(err)}): ${stripped.slice(0, 200)}`,
    );
  }
  if (!isRecord(parsed) || typeof parsed['summary'] !== 'string') {
    throw new Error('patch JSON is missing a string "summary"');
  }
  const files: FileChange[] = [];
  const rawFiles = parsed['files'];
  if (Array.isArray(rawFiles)) {
    for (const raw of rawFiles) {
      if (
        isRecord(raw) &&
        typeof raw['path'] === 'string' &&
        (typeof raw['contents'] === 'string' || raw['contents'] === null)
      ) {
        files.push({ path: raw['path'], contents: raw['contents'] });
      }
    }
  }
  const reflection = parsed['reflection'];
  return {
    summary: parsed['summary'],
    files,
    claimsDone: parsed['claimsDone'] === true,
    ...(typeof reflection === 'string' && reflection.length > 0 ? { reflection } : {}),
  };
}

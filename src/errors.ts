/** Machine-readable failure codes carried by {@link RatchetError}. */
export type RatchetErrorCode =
  | 'CONFIG_INVALID'
  | 'GENERATE_FAILED'
  | 'APPLY_FAILED'
  | 'CHECK_THREW'
  | 'COMMIT_FAILED'
  | 'GIT_FAILED'
  | 'PATH_ESCAPE'
  | 'STATE_INVALID';

/** All errors ratchet-loop raises itself. User-function errors are wrapped with `cause`. */
export class RatchetError extends Error {
  readonly code: RatchetErrorCode;

  constructor(code: RatchetErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RatchetError';
    this.code = code;
  }
}

/** Best-effort human message from an unknown thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

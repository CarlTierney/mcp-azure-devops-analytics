export interface RetryOptions {
  retries?: number;       // attempts after the first, default 6
  baseDelayMs?: number;   // default 1000
  maxDelayMs?: number;    // default 60000
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** Status code from azure-devops-node-api / typed-rest-client errors, or from the message as a fallback. */
export function statusOf(error: any): number | undefined {
  const s = error?.statusCode ?? error?.status ?? error?.response?.statusCode;
  if (typeof s === 'number') return s;
  const m = /\b(429|500|502|503|504)\b/.exec(String(error?.message ?? ''));
  return m ? Number(m[1]) : undefined;
}

/** Seconds from a Retry-After value if the error carries one. */
function retryAfterMs(error: any): number | undefined {
  const h = error?.response?.headers?.['retry-after'] ?? error?.result?.retryAfter ?? error?.retryAfter;
  const n = Number(h);
  return Number.isFinite(n) && n > 0 ? n * 1000 : undefined;
}

export function isRetryable(error: any): boolean {
  const s = statusOf(error);
  if (s !== undefined) return RETRYABLE_STATUS.has(s);
  // ADO throttling messages and transient socket errors
  return /TF400733|throttl|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(String(error?.message ?? error));
}

/**
 * Retry an ADO call on throttling (429) and transient server errors, with exponential backoff
 * and jitter. Honors Retry-After when the error exposes it.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 6;
  const base = opts.baseDelayMs ?? 1000;
  const max = opts.maxDelayMs ?? 60000;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= retries || !isRetryable(e)) throw e;
      const backoff = Math.min(max, base * 2 ** attempt);
      const delay = retryAfterMs(e) ?? Math.round(backoff / 2 + Math.random() * (backoff / 2));
      opts.onRetry?.(attempt + 1, delay, e);
      await sleep(delay);
    }
  }
}

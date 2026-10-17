import { spawn } from 'child_process';

export interface GitRunOptions {
  cwd?: string;
  /** Personal access token. Sent as an HTTP header via env config, never in argv or a config file. */
  pat?: string;
  timeoutMs?: number;
  /** Allow non-zero exit without throwing. */
  allowFailure?: boolean;
}

export interface GitRunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Run git with the PAT injected through GIT_CONFIG_COUNT env vars (git 2.31+).
 * This keeps the token out of the process list, remote URLs and .git/config.
 */
export function runGit(args: string[], opts: GitRunOptions = {}): Promise<GitRunResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
    LC_ALL: 'C',
  };
  if (opts.pat) {
    const token = Buffer.from(`:${opts.pat}`).toString('base64');
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.extraHeader';
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${token}`;
  }

  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: opts.cwd, env });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
    }
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const result = {
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        code: code ?? -1,
      };
      if (result.code !== 0 && !opts.allowFailure) {
        reject(new Error(`git ${args[0]} failed (${result.code}): ${scrub(result.stderr).trim()}`));
      } else {
        resolve(result);
      }
    });
  });
}

/** Remove anything that looks like a credential from git output before it reaches logs or tool results. */
export function scrub(text: string): string {
  return text
    .replace(/Authorization:\s*\S+\s+\S+/gi, 'Authorization: [redacted]')
    .replace(/(https?:\/\/)[^@\s/]+@/gi, '$1');
}

/** Run async tasks with a fixed concurrency limit, preserving input order in the output. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

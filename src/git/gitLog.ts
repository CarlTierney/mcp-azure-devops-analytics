import { runGit } from './gitRunner.js';
import { CommitRecord, FileChange } from './types.js';

const RS = '\x1e'; // record separator, starts each commit
const US = '\x1f'; // unit separator, between fields

const FORMAT = [RS + '%H', '%P', '%aN', '%aE', '%aI', '%cN', '%cE', '%cI', '%s'].join(US);

export interface LogOptions {
  /** Ref to walk. Defaults to the repo's default branch ("landed work"). */
  ref: string;
  /** Committer-date lower bound passed to git; filter on author date afterwards. */
  since?: Date;
  includeMerges?: boolean;
}

/**
 * Read commits with per-file line counts. Uses %aN/%aE so a .mailmap in the repo is honored.
 * Renames are detected so a moved file counts only its content changes.
 */
export async function readCommits(gitDir: string, repoId: string, opts: LogOptions): Promise<CommitRecord[]> {
  const args = ['--git-dir', gitDir, 'log', opts.ref, `--format=${FORMAT}`, '--numstat', '--find-renames', '--no-color'];
  if (!opts.includeMerges) args.push('--no-merges');
  if (opts.since) args.push(`--since=${opts.since.toISOString()}`);
  const { stdout } = await runGit(args, { timeoutMs: 30 * 60 * 1000 });
  return parseLog(stdout, repoId);
}

export function parseLog(raw: string, repoId: string): CommitRecord[] {
  const commits: CommitRecord[] = [];
  for (const chunk of raw.split(RS)) {
    if (!chunk.trim()) continue;
    const newline = chunk.indexOf('\n');
    const header = newline === -1 ? chunk : chunk.slice(0, newline);
    const body = newline === -1 ? '' : chunk.slice(newline + 1);
    const f = header.split(US);
    if (f.length < 9) continue;
    commits.push({
      sha: f[0],
      parents: f[1] ? f[1].split(' ') : [],
      authorName: f[2],
      authorEmail: f[3],
      authorDate: f[4],
      committerName: f[5],
      committerEmail: f[6],
      committerDate: f[7],
      subject: f.slice(8).join(US),
      files: parseNumstat(body),
      repoId,
    });
  }
  return commits;
}

export function parseNumstat(body: string): FileChange[] {
  const files: FileChange[] = [];
  for (const line of body.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    const binary = m[1] === '-' || m[2] === '-';
    files.push({
      path: resolveRenamePath(m[3]),
      added: binary ? 0 : Number(m[1]),
      deleted: binary ? 0 : Number(m[2]),
      binary,
    });
  }
  return files;
}

/** "src/{old => new}/f.ts" -> "src/new/f.ts", "a.ts => b.ts" -> "b.ts" */
export function resolveRenamePath(p: string): string {
  const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(p);
  if (brace) return (brace[1] + brace[3] + brace[4]).replace(/\/\//g, '/');
  const plain = /^(.*) => (.*)$/.exec(p);
  return plain ? plain[2] : p;
}

/** Line counts for a single completion commit against its first parent. Used for PR size. */
export async function diffAgainstFirstParent(gitDir: string, sha: string): Promise<FileChange[] | undefined> {
  const exists = await runGit(['--git-dir', gitDir, 'cat-file', '-e', `${sha}^{commit}`], { allowFailure: true });
  if (exists.code !== 0) return undefined;
  const parent = await runGit(['--git-dir', gitDir, 'rev-parse', '--verify', '--quiet', `${sha}^1`], { allowFailure: true });
  const base = parent.code === 0 ? parent.stdout.trim() : '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // empty tree
  const { stdout } = await runGit(['--git-dir', gitDir, 'diff', '--numstat', '--find-renames', base, sha]);
  return parseNumstat(stdout);
}

/** Resolve the ref for a repo's default branch inside a bare mirror. */
export async function resolveDefaultRef(gitDir: string, defaultBranch?: string): Promise<string | undefined> {
  const candidates = [defaultBranch, 'HEAD', 'refs/heads/main', 'refs/heads/master'].filter(Boolean) as string[];
  for (const ref of candidates) {
    const r = await runGit(['--git-dir', gitDir, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFailure: true });
    if (r.code === 0) return ref;
  }
  return undefined;
}

const MERGED_PR = /^Merged PR (\d+)\b/;

/** ADO completion commits are titled "Merged PR 123: ...". */
export function prIdFromSubject(subject: string): number | undefined {
  const m = MERGED_PR.exec(subject);
  return m ? Number(m[1]) : undefined;
}

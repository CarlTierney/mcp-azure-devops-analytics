import fs from 'fs/promises';
import path from 'path';
import { runGit, mapWithConcurrency } from './gitRunner.js';
import { CommitRecord } from './types.js';
import { PathFilter } from './changeMetrics.js';

/**
 * Code survival at a fixed horizon.
 *
 * For each commit at least `horizonDays` old, find the default-branch revision as of
 * commit date + horizon, blame each file the commit added lines to at that revision, and count
 * how many lines are still attributed to the commit. A fixed horizon keeps old and recent work
 * comparable: a 2024 commit and a 2026 commit both get measured 90 days after they landed.
 *
 * Blame uses -w (ignore whitespace) and -M (follow moves within a file), so reformatting and
 * reordering don't count as replacement. Files missing at the horizon revision (deleted or
 * renamed) are left out of both numerator and denominator and reported separately.
 */

export interface CommitSurvival {
  added: number;      // lines added in files that still existed at the horizon
  survived: number;
}

export interface SurvivalResult {
  byCommit: Map<string, CommitSurvival>;
  blamesRun: number;
  blamesCached: number;
  filesMissingAtHorizon: number;
  commitsNotMatured: number;
}

interface RefPoint { sha: string; time: number; }

/** First-parent history of the ref, oldest first, for "revision as of time T" lookups. */
export async function readRefTimeline(gitDir: string, ref: string): Promise<RefPoint[]> {
  const { stdout } = await runGit(['--git-dir', gitDir, 'log', '--first-parent', '--reverse', '--format=%H %ct', ref], {
    timeoutMs: 10 * 60 * 1000,
  });
  return stdout.split('\n').filter(Boolean).map((l) => {
    const [sha, ct] = l.split(' ');
    return { sha, time: Number(ct) * 1000 };
  });
}

/** Last revision on the timeline at or before `time`. Binary search. */
export function revisionAt(timeline: RefPoint[], time: number): string | undefined {
  let lo = 0, hi = timeline.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (timeline[mid].time <= time) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return found >= 0 ? timeline[found].sha : undefined;
}

/** Lines per originating commit from `git blame --line-porcelain`. */
export function parseBlameCounts(porcelain: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const line of porcelain.split('\n')) {
    // Header lines: "<40-hex sha> <orig line> <final line>[ <group size>]"
    if (line.length >= 44 && /^[0-9a-f]{40} \d+ \d+/.test(line)) {
      const sha = line.slice(0, 40);
      counts[sha] = (counts[sha] ?? 0) + 1;
    }
  }
  return counts;
}

export interface SurvivalOptions {
  horizonDays?: number;
  now?: Date;
  pathFilter?: PathFilter;
  cacheFile?: string;
  concurrency?: number;
  /** Only measure commits whose author date falls on or after this time. */
  since?: Date;
}

export async function measureSurvival(
  gitDir: string,
  ref: string,
  commits: CommitRecord[],
  opts: SurvivalOptions = {}
): Promise<SurvivalResult> {
  const horizonMs = (opts.horizonDays ?? 90) * 86400000;
  const now = (opts.now ?? new Date()).getTime();
  const filter = opts.pathFilter ?? new PathFilter();
  const since = opts.since?.getTime() ?? -Infinity;
  const timeline = await readRefTimeline(gitDir, ref);

  let cache: Record<string, Record<string, number> | null> = {};
  if (opts.cacheFile) {
    try { cache = JSON.parse(await fs.readFile(opts.cacheFile, 'utf8')); } catch { /* first run */ }
  }
  let dirty = false;

  // Group work by (revision, path) so each blame runs once.
  const jobs = new Map<string, { rev: string; path: string; commits: Array<{ sha: string; added: number }> }>();
  let notMatured = 0;
  for (const c of commits) {
    const t = Date.parse(c.committerDate);
    if (Date.parse(c.authorDate) < since) continue;
    if (t + horizonMs > now) { notMatured++; continue; }
    const rev = revisionAt(timeline, t + horizonMs);
    if (!rev) continue;
    for (const f of c.files) {
      if (f.binary || f.added === 0 || filter.excluded(f.path)) continue;
      const key = `${rev}:${f.path}`;
      let job = jobs.get(key);
      if (!job) { job = { rev, path: f.path, commits: [] }; jobs.set(key, job); }
      job.commits.push({ sha: c.sha, added: f.added });
    }
  }

  let blamesRun = 0, blamesCached = 0, missing = 0;
  const byCommit = new Map<string, CommitSurvival>();
  const credit = (sha: string, added: number, survived: number) => {
    const cur = byCommit.get(sha) ?? { added: 0, survived: 0 };
    cur.added += added;
    cur.survived += Math.min(survived, added); // -M can attribute moved lines; never exceed what was added
    byCommit.set(sha, cur);
  };

  await mapWithConcurrency([...jobs.entries()], opts.concurrency ?? 8, async ([key, job]) => {
    let counts = cache[key];
    if (counts === undefined) {
      const r = await runGit(
        ['--git-dir', gitDir, 'blame', '--line-porcelain', '-w', '-M', job.rev, '--', job.path],
        { allowFailure: true, timeoutMs: 5 * 60 * 1000 }
      );
      counts = r.code === 0 ? parseBlameCounts(r.stdout) : null; // null = file missing at that revision
      cache[key] = counts;
      dirty = true;
      blamesRun++;
    } else {
      blamesCached++;
    }
    if (counts === null) { missing++; return; }
    for (const c of job.commits) credit(c.sha, c.added, counts[c.sha] ?? 0);
  });

  if (opts.cacheFile && dirty) {
    await fs.mkdir(path.dirname(opts.cacheFile), { recursive: true });
    await fs.writeFile(opts.cacheFile, JSON.stringify(cache));
  }
  return { byCommit, blamesRun, blamesCached, filesMissingAtHorizon: missing, commitsNotMatured: notMatured };
}

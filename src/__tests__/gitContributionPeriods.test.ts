import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { withRetry, isRetryable, statusOf } from '../git/retry.js';
import { revisionAt, parseBlameCounts, measureSurvival } from '../git/survival.js';
import { readCommits } from '../git/gitLog.js';
import { analyzeChanges } from '../git/changeMetrics.js';
import { IdentityResolver } from '../git/identity.js';
import { ContributionAnalyzer, comparePeriods, compareToBenchmark } from '../git/contribution.js';
import { RepoInfo } from '../git/types.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contrib-periods-'));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

function git(cwd: string, args: string[], env: Record<string, string> = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: tmpRoot, ...env } });
}

type Spec = { author: [string, string]; date: string; files?: Record<string, string>; remove?: string[]; message: string };

function makeRepo(name: string, commits: Spec[]): string {
  const dir = path.join(tmpRoot, 'src', name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  for (const c of commits) {
    for (const [f, content] of Object.entries(c.files ?? {})) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), content);
    }
    for (const f of c.remove ?? []) fs.rmSync(path.join(dir, f));
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', c.message], {
      GIT_AUTHOR_NAME: c.author[0], GIT_AUTHOR_EMAIL: c.author[1], GIT_AUTHOR_DATE: c.date,
      GIT_COMMITTER_NAME: c.author[0], GIT_COMMITTER_EMAIL: c.author[1], GIT_COMMITTER_DATE: c.date,
    });
  }
  return dir;
}

function mirrorOf(src: string, name: string) {
  const m = path.join(tmpRoot, `${name}.git`);
  git(tmpRoot, ['clone', '-q', '--mirror', src, m]);
  return m;
}

const lines = (from: number, to: number, tag = 'l') => Array.from({ length: to - from }, (_, i) => `${tag}${from + i}`).join('\n') + '\n';
const CARL: [string, string] = ['Carl Tierney', 'carl@example.com'];
const BOB: [string, string] = ['Bob Dev', 'bob@example.com'];
const EVE: [string, string] = ['Eve Ops', 'eve@example.com'];

// ---------- retry ----------

describe('retry on ADO throttling', () => {
  const noSleep = async () => {};

  it('retries 429 and 503 then succeeds', async () => {
    let n = 0;
    const delays: number[] = [];
    const result = await withRetry(async () => {
      n++;
      if (n === 1) throw Object.assign(new Error('Too many requests'), { statusCode: 429 });
      if (n === 2) throw Object.assign(new Error('unavailable'), { statusCode: 503 });
      return 'ok';
    }, { sleep: noSleep, onRetry: (_a, d) => delays.push(d) });
    expect(result).toBe('ok');
    expect(n).toBe(3);
    expect(delays).toHaveLength(2);
  });

  it('does not retry client errors and gives up after the retry limit', async () => {
    let n = 0;
    await expect(withRetry(async () => { n++; throw Object.assign(new Error('nope'), { statusCode: 404 }); }, { sleep: noSleep }))
      .rejects.toThrow('nope');
    expect(n).toBe(1);
    n = 0;
    await expect(withRetry(async () => { n++; throw Object.assign(new Error('slow down'), { statusCode: 429 }); }, { sleep: noSleep, retries: 2 }))
      .rejects.toThrow('slow down');
    expect(n).toBe(3);
  });

  it('honors Retry-After and recognizes throttling by message', async () => {
    const delays: number[] = [];
    let n = 0;
    await withRetry(async () => {
      if (n++ === 0) throw Object.assign(new Error('x'), { statusCode: 429, response: { headers: { 'retry-after': '7' } } });
      return 1;
    }, { sleep: noSleep, onRetry: (_a, d) => delays.push(d) });
    expect(delays).toEqual([7000]);
    expect(isRetryable(new Error('TF400733: The request has been canceled'))).toBe(true);
    expect(isRetryable(new Error('socket hang up'))).toBe(true);
    expect(statusOf(new Error('Request failed with 502'))).toBe(502);
    expect(isRetryable(new Error('VS403496 access denied'))).toBe(false);
  });
});

// ---------- survival ----------

describe('code survival', () => {
  it('finds the revision as of a time and parses blame porcelain', () => {
    const tl = [{ sha: 'a', time: 10 }, { sha: 'b', time: 20 }, { sha: 'c', time: 30 }];
    expect(revisionAt(tl, 5)).toBeUndefined();
    expect(revisionAt(tl, 20)).toBe('b');
    expect(revisionAt(tl, 29)).toBe('b');
    expect(revisionAt(tl, 99)).toBe('c');
    const sha1 = 'a'.repeat(40), sha2 = 'b'.repeat(40);
    const porcelain = `${sha1} 1 1 2\nauthor X\n\tline\n${sha1} 2 2\nauthor X\n\tline\n${sha2} 1 3 1\nauthor Y\n\tline\n`;
    expect(parseBlameCounts(porcelain)).toEqual({ [sha1]: 2, [sha2]: 1 });
  });

  it('measures surviving lines at a fixed horizon, ignoring whitespace churn and missing files', async () => {
    const src = makeRepo('survival', [
      { author: CARL, date: '2026-01-05T09:00:00+00:00', files: { 'src/a.ts': lines(0, 10), 'src/gone.ts': lines(0, 4, 'g') }, message: 'carl writes a' },
      // whitespace-only change by Eve: must not count as replacing Carl's lines
      { author: EVE, date: '2026-01-15T09:00:00+00:00', files: { 'src/a.ts': lines(0, 10).replace(/^l/gm, '  l') }, message: 'eve reindents' },
      // Bob rewrites half of Carl's lines within the horizon
      { author: BOB, date: '2026-02-04T09:00:00+00:00', files: { 'src/a.ts': lines(0, 5).replace(/^l/gm, '  l') + lines(100, 105, 'bob') }, remove: ['src/gone.ts'], message: 'bob rewrites half' },
      // after the 90 day horizon: should not affect Carl's measurement
      { author: BOB, date: '2026-05-01T09:00:00+00:00', files: { 'src/a.ts': lines(200, 203, 'late') }, message: 'bob replaces everything later' },
      // too recent to have matured at "now"
      { author: CARL, date: '2026-09-20T09:00:00+00:00', files: { 'src/b.ts': lines(0, 8) }, message: 'carl recent' },
    ]);
    const mirror = mirrorOf(src, 'survival');
    const commits = await readCommits(mirror, 'r', { ref: 'refs/heads/main' });
    const bySubject = (s: string) => commits.find((c) => c.subject === s)!.sha;
    const cacheFile = path.join(tmpRoot, 'blame-cache.json');

    const res = await measureSurvival(mirror, 'refs/heads/main', commits, { horizonDays: 90, now: new Date('2026-10-17'), cacheFile });
    const carl = res.byCommit.get(bySubject('carl writes a'))!;
    expect(carl).toEqual({ added: 10, survived: 5 }); // gone.ts deleted by the horizon: excluded, not counted dead
    expect(res.filesMissingAtHorizon).toBe(1);
    expect(res.commitsNotMatured).toBe(1);
    expect(res.byCommit.has(bySubject('carl recent'))).toBe(false);
    // Bob's horizon is May 5. His own May 1 rewrite replaced those lines before then.
    expect(res.byCommit.get(bySubject('bob rewrites half'))).toEqual({ added: 5, survived: 0 });
    // Eve's reindent touches every line, but -w credits the content to Carl, not Eve.
    expect(res.byCommit.get(bySubject('eve reindents'))!.survived).toBe(0);

    const again = await measureSurvival(mirror, 'refs/heads/main', commits, { horizonDays: 90, now: new Date('2026-10-17'), cacheFile });
    expect(again.blamesRun).toBe(0);
    expect(again.blamesCached).toBe(res.blamesRun);
  });
});

// ---------- activity threshold ----------

describe('minimum activity per week', () => {
  it('does not let token weeks dilute per-week rates', async () => {
    const src = makeRepo('threshold', [
      { author: CARL, date: '2026-03-02T09:00:00+00:00', files: { 'a.ts': lines(0, 1) }, message: 'tiny' },       // 2 lines incl newline? 1 line
      { author: CARL, date: '2026-03-16T09:00:00+00:00', files: { 'b.ts': lines(0, 100) }, message: 'real 1' },
      { author: CARL, date: '2026-03-23T09:00:00+00:00', files: { 'c.ts': lines(0, 100) }, message: 'real 2' },
    ]);
    const commits = await readCommits(mirrorOf(src, 'threshold'), 'r', { ref: 'refs/heads/main' });
    const window = { since: new Date('2026-03-01'), until: new Date('2026-03-31') };
    const loose = analyzeChanges(commits, { window, identity: new IdentityResolver() }).developers[0];
    const strict = analyzeChanges(commits, { window, identity: new IdentityResolver(), minActiveWeekLines: 20 }).developers[0];
    expect(loose.activeWeeks).toBe(3);
    expect(strict.activeWeeks).toBe(2);
    expect(strict.lightWeeksIgnored).toBe(1);
    expect(strict.commitsPerActiveWeek).toBe(1.5);
    expect(loose.commitsPerActiveWeek).toBe(1);
  });
});

// ---------- benchmark window and pivot ----------

describe('benchmark window and pivot periods', () => {
  it('compares before and after a pivot against a benchmark taken from its own window', async () => {
    const commits: Spec[] = [];
    // Bob before the pivot: one 50-line commit per week for 4 weeks in Feb 2026
    for (let w = 0; w < 4; w++) {
      commits.push({ author: BOB, date: `2026-02-${String(2 + w * 7).padStart(2, '0')}T09:00:00+00:00`, files: { [`bob/pre${w}.ts`]: lines(0, 50) }, message: `bob pre ${w}` });
    }
    // Carl and Bob after the pivot (Apr 2026): Carl 2 x 100 lines/week, Bob 1 x 100 lines/week, 4 weeks
    for (let w = 0; w < 4; w++) {
      const day = String(6 + w * 7).padStart(2, '0');
      commits.push({ author: CARL, date: `2026-04-${day}T09:00:00+00:00`, files: { [`carl/x${w}.ts`]: lines(0, 100) }, message: `carl ${w}a` });
      commits.push({ author: CARL, date: `2026-04-${day}T11:00:00+00:00`, files: { [`carl/y${w}.ts`]: lines(0, 100) }, message: `carl ${w}b` });
      commits.push({ author: BOB, date: `2026-04-${day}T10:00:00+00:00`, files: { [`bob/post${w}.ts`]: lines(0, 100) }, message: `bob post ${w}` });
    }
    const src = makeRepo('periods', commits);
    const repo: RepoInfo = { id: 'per00001-aaaa', name: 'periods', project: 'Proj', remoteUrl: src, defaultBranch: 'refs/heads/main',
      sizeBytes: 1, isDisabled: false, isFork: false };

    const analyzer = new ContributionAnalyzer(
      { listProjects: async () => ['Proj'], listRepositories: async () => [repo] },
      { listPullRequests: async () => [], listThreads: async () => [], countIterations: async () => 0 },
      { cacheDir: path.join(tmpRoot, 'cache-periods'), orgUrl: 'x', pat: 'p', benchmark: ['carl@example.com'] }
    );
    await analyzer.sync();

    const pivot = new Date('2026-03-15');
    const window = { since: new Date('2026-01-01'), until: new Date('2026-05-31') };
    const r = await analyzer.analyzePeriods({
      windows: {
        before: { since: window.since, until: new Date(pivot.getTime() - 1) },
        after: { since: pivot, until: window.until },
        benchmark: { since: pivot, until: window.until },
      },
    });

    // Benchmark is not diluted by the months before Carl started
    const carl = r.benchmark.developers.find((d) => d.isBenchmark)!;
    expect(carl.changes!.activeWeeks).toBe(4);
    expect(carl.changes!.commitsPerActiveWeek).toBe(2);
    expect(r.before.developers.find((d) => d.isBenchmark)).toBeUndefined();
    expect(r.before.dataNotes.survival.enabled).toBe(true);

    const cmp = comparePeriods({ before: r.before, after: r.after }, r.benchmark);
    expect(cmp.benchmark!.developer).toBe('carl@example.com');
    expect(cmp.benchmarkWindow.since).toBe(pivot.toISOString());
    const bob = cmp.acrossPeriods.find((d) => d.developer === 'bob@example.com')!;
    // before: 1 commit & 50 lines per week vs Carl 2 & 200 -> ratios 0.5 and 0.25 -> geomean ~0.35
    // after:  1 commit & 100 lines per week                -> ratios 0.5 and 0.5  -> 0.5
    expect(bob.byPeriod.before.throughputIndex).toBe(0.35);
    expect(bob.byPeriod.after.throughputIndex).toBe(0.5);
    expect(bob.byPeriod.before.activeWeeks).toBe(4);
    expect(bob.byPeriod.after.survivalPct).toBe(100);

    // Same benchmark object used for a single window with separate benchmark window
    const single = compareToBenchmark(r.after, r.benchmark);
    expect(single.benchmarkWindow.since).toBe(pivot.toISOString());
  });
});

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseLog, parseNumstat, resolveRenamePath, readCommits, resolveDefaultRef, diffAgainstFirstParent, prIdFromSubject } from '../git/gitLog.js';
import { PathFilter, globToRegex, analyzeChanges, isoWeek, median } from '../git/changeMetrics.js';
import { IdentityResolver } from '../git/identity.js';
import { RepoSync, RepoSource, buildCoverageReport, stripUserInfo } from '../git/repoSync.js';
import { PrSync, PrSource, deriveFromThreads, toRecord } from '../git/prSync.js';
import { analyzePullRequests, prKey } from '../git/prMetrics.js';
import { ContributionAnalyzer, compareToBenchmark } from '../git/contribution.js';
import { scrub, mapWithConcurrency } from '../git/gitRunner.js';
import { RepoInfo, PullRequestRecord } from '../git/types.js';

// ---------- helpers ----------

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contrib-test-'));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

function git(cwd: string, args: string[], env: Record<string, string> = {}) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: tmpRoot, ...env },
  });
}

interface CommitSpec { author: [string, string]; date: string; files: Record<string, string>; message: string; committer?: [string, string]; }

function makeRepo(name: string, commits: CommitSpec[]): string {
  const dir = path.join(tmpRoot, 'src', name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  for (const c of commits) {
    for (const [f, content] of Object.entries(c.files)) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), content);
    }
    git(dir, ['add', '-A']);
    const committer = c.committer ?? c.author;
    git(dir, ['commit', '-q', '-m', c.message], {
      GIT_AUTHOR_NAME: c.author[0], GIT_AUTHOR_EMAIL: c.author[1], GIT_AUTHOR_DATE: c.date,
      GIT_COMMITTER_NAME: committer[0], GIT_COMMITTER_EMAIL: committer[1], GIT_COMMITTER_DATE: c.date,
    });
  }
  return dir;
}

const lines = (n: number, tag = 'x') => Array.from({ length: n }, (_, i) => `${tag}${i}`).join('\n') + '\n';
const CARL: [string, string] = ['Carl Tierney', 'carl@example.com'];
const CARL_ALT: [string, string] = ['Carl T', 'carl.tierney@work.example'];
const BOB: [string, string] = ['Bob Dev', 'bob@example.com'];
const ADMIN: [string, string] = ['Release Admin', 'admin@example.com'];

function repoInfo(id: string, name: string, remoteUrl: string, extra: Partial<RepoInfo> = {}): RepoInfo {
  return { id, name, project: 'Proj', remoteUrl, defaultBranch: 'refs/heads/main', sizeBytes: 1000, isDisabled: false, isFork: false, ...extra };
}

// ---------- parsing ----------

describe('git log parsing', () => {
  it('parses numstat including binary files', () => {
    const files = parseNumstat('10\t2\tsrc/a.ts\n-\t-\timg/logo.png\n\n');
    expect(files).toEqual([
      { path: 'src/a.ts', added: 10, deleted: 2, binary: false },
      { path: 'img/logo.png', added: 0, deleted: 0, binary: true },
    ]);
  });

  it('resolves rename paths to the new path', () => {
    expect(resolveRenamePath('src/{old => new}/f.ts')).toBe('src/new/f.ts');
    expect(resolveRenamePath('src/{ => sub}/f.ts')).toBe('src/sub/f.ts');
    expect(resolveRenamePath('a.ts => b.ts')).toBe('b.ts');
    expect(resolveRenamePath('plain.ts')).toBe('plain.ts');
  });

  it('parses records with separators and keeps subjects intact', () => {
    const raw = '\x1eabc\x1fp1 p2\x1fA\x1fa@x\x1f2026-01-01T10:00:00+01:00\x1fC\x1fc@x\x1f2026-01-01T10:00:00+01:00\x1fMerged PR 12: fix\n\n3\t1\tf.ts\n';
    const [c] = parseLog(raw, 'r1');
    expect(c.parents).toEqual(['p1', 'p2']);
    expect(c.subject).toBe('Merged PR 12: fix');
    expect(c.files[0]).toMatchObject({ path: 'f.ts', added: 3, deleted: 1 });
    expect(prIdFromSubject(c.subject)).toBe(12);
    expect(prIdFromSubject('Merge branch main')).toBeUndefined();
  });
});

describe('path filter', () => {
  it('matches default generated and lock file patterns', () => {
    const f = new PathFilter();
    expect(f.excluded('package-lock.json')).toBe(true);
    expect(f.excluded('web/package-lock.json')).toBe(true);
    expect(f.excluded('src/app.min.js')).toBe(true);
    expect(f.excluded('src/Forms/Main.Designer.cs')).toBe(true);
    expect(f.excluded('api/bin/Debug/x.dll')).toBe(true);
    expect(f.excluded('src/app.ts')).toBe(false);
    expect(f.excluded('src/binary/reader.ts')).toBe(false);
  });

  it('converts globs precisely', () => {
    expect(globToRegex('**/*.ts').test('a/b/c.ts')).toBe(true);
    expect(globToRegex('**/*.ts').test('c.ts')).toBe(true);
    expect(globToRegex('src/*.ts').test('src/a/b.ts')).toBe(false);
  });
});

describe('small helpers', () => {
  it('computes ISO weeks from the author local date', () => {
    expect(isoWeek('2026-01-01T23:30:00-05:00')).toBe('2026-W01');
    expect(isoWeek('2024-12-30T09:00:00+00:00')).toBe('2025-W01');
  });
  it('computes medians', () => {
    expect(median([])).toBe(0);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  it('scrubs credentials from git output', () => {
    expect(scrub('fatal: https://user:tok@dev.azure.com/x')).toBe('fatal: https://dev.azure.com/x');
    expect(scrub('Authorization: Basic abc123')).toBe('Authorization: [redacted]');
  });
  it('limits concurrency and preserves order', async () => {
    let live = 0, peak = 0;
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      live++; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live--; return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10]);
    expect(peak).toBeLessThanOrEqual(2);
  });
  it('strips user info from ADO remote URLs', () => {
    expect(stripUserInfo('https://org@dev.azure.com/org/p/_git/r')).toBe('https://dev.azure.com/org/p/_git/r');
  });
});

describe('identity resolution', () => {
  it('merges aliases from the map and flags same-name different-email identities', () => {
    const id = new IdentityResolver([{ canonical: 'carl@example.com', displayName: 'Carl', aliases: ['carl.tierney@work.example'] }]);
    expect(id.resolve('CARL.TIERNEY@work.example', 'Carl T')).toBe('carl@example.com');
    expect(id.displayName('carl@example.com')).toBe('Carl');
    id.resolve('bob@example.com', 'Bob Dev');
    id.resolve('bob@old.example', 'Bob Dev');
    expect(id.possibleDuplicates()).toEqual([{ name: 'bob dev', ids: ['bob@example.com', 'bob@old.example'] }]);
  });
});

// ---------- against a real repository ----------

describe('change metrics from a real git repo', () => {
  let mirror: string;

  beforeAll(() => {
    const src = makeRepo('app', [
      { author: CARL, date: '2026-03-02T09:00:00+00:00', files: { 'src/a.ts': lines(100) }, message: 'carl a' },
      { author: CARL, date: '2026-03-03T09:00:00+00:00', files: { 'src/a.ts': lines(80) + lines(10, 'y') }, message: 'carl a rework' },
      { author: BOB, date: '2026-03-04T09:00:00+00:00', files: { 'src/b.ts': lines(30), 'package-lock.json': lines(5000) }, message: 'bob b' },
      // squash completion: committed by an admin, title from ADO
      { author: ADMIN, date: '2026-03-10T09:00:00+00:00', files: { 'src/c.ts': lines(40) }, message: 'Merged PR 7: bob feature' },
      { author: CARL_ALT, date: '2026-03-11T09:00:00+00:00', files: { 'src/d.ts': lines(20) }, message: 'carl from work email' },
    ]);
    mirror = path.join(tmpRoot, 'mirror-app.git');
    git(tmpRoot, ['clone', '-q', '--mirror', src, mirror]);
  });

  it('reads commits from the default branch and sizes a completion commit', async () => {
    const ref = await resolveDefaultRef(mirror, 'refs/heads/main');
    expect(ref).toBe('refs/heads/main');
    const commits = await readCommits(mirror, 'r1', { ref: ref! });
    expect(commits).toHaveLength(5);
    const squash = commits.find((c) => c.subject.startsWith('Merged PR 7'))!;
    const files = await diffAgainstFirstParent(mirror, squash.sha);
    expect(files).toEqual([{ path: 'src/c.ts', added: 40, deleted: 0, binary: false }]);
    expect(await diffAgainstFirstParent(mirror, 'deadbeef'.repeat(5))).toBeUndefined();
  });

  it('attributes squash commits to the PR author, excludes lock files, detects rework', async () => {
    const commits = await readCommits(mirror, 'r1', { ref: 'refs/heads/main' });
    const identity = new IdentityResolver([{ canonical: 'carl@example.com', aliases: ['carl.tierney@work.example'] }]);
    const squash = commits.find((c) => c.subject.startsWith('Merged PR 7'))!;
    const res = analyzeChanges([...commits, ...commits], { // duplicated to simulate a fork
      window: { since: new Date('2026-03-01'), until: new Date('2026-03-31') },
      identity,
      authorOverrides: new Map([[squash.sha, 'bob@example.com']]),
    });
    expect(res.duplicateCommitsSkipped).toBe(5);
    const carl = res.developers.find((d) => d.developer === 'carl@example.com')!;
    const bob = res.developers.find((d) => d.developer === 'bob@example.com')!;
    expect(res.developers.find((d) => d.developer === 'admin@example.com')).toBeUndefined();

    expect(carl.commits).toBe(3);
    expect(carl.activeDays).toBe(3);
    expect(carl.linesAdded).toBe(100 + 10 + 20);
    expect(carl.linesDeleted).toBe(20);
    expect(carl.reworkLines).toBe(20); // deleted within 21 days of his own change to the same file

    expect(bob.commits).toBe(2);
    expect(bob.linesAdded).toBe(30 + 40);
    expect(bob.excludedLines).toBe(5000);
    expect(res.excludedLinesTotal).toBe(5000);
  });

  it('counts rework lookback but not volume for commits before the window', async () => {
    const commits = await readCommits(mirror, 'r1', { ref: 'refs/heads/main' });
    const res = analyzeChanges(commits, {
      window: { since: new Date('2026-03-03T00:00:00Z'), until: new Date('2026-03-31') },
      identity: new IdentityResolver(),
    });
    const carl = res.developers.find((d) => d.developer === 'carl@example.com')!;
    expect(carl.commits).toBe(1);
    expect(carl.reworkLines).toBe(20);
  });
});

// ---------- repo sync and coverage ----------

describe('repo sync and coverage', () => {
  it('clones, fetches, flags empty, disabled and failed repos, and reports coverage', async () => {
    const good = makeRepo('svc', [{ author: BOB, date: '2026-04-01T10:00:00+00:00', files: { 'x.ts': lines(3) }, message: 'init' }]);
    const empty = path.join(tmpRoot, 'src', 'empty');
    fs.mkdirSync(empty, { recursive: true });
    git(empty, ['init', '-q', '-b', 'main']);

    const repos: RepoInfo[] = [
      repoInfo('fork0001-aaaa', 'svc-fork', good, { isFork: true, parentRepoId: 'good0001-aaaa' }),
      repoInfo('good0001-aaaa', 'svc', good),
      repoInfo('empt0001-aaaa', 'empty', empty, { sizeBytes: 0 }),
      repoInfo('disa0001-aaaa', 'old', 'https://invalid.example/x', { isDisabled: true }),
      repoInfo('fail0001-aaaa', 'broken', path.join(tmpRoot, 'does-not-exist')),
      repoInfo('big00001-aaaa', 'big', good, { sizeBytes: 5 * 1024 ** 3 }),
    ];
    const source: RepoSource = { listProjects: async () => ['Proj'], listRepositories: async () => repos };
    const sync = new RepoSync(source, { cacheDir: path.join(tmpRoot, 'cache1'), pat: 'secret', orgUrl: 'https://dev.azure.com/org', concurrency: 3 });

    const discovered = await sync.discover();
    expect(discovered[discovered.length - 1].isFork).toBe(true); // parents first

    const first = await sync.syncAll();
    const byName = Object.fromEntries(first.map((r) => [r.repo.name, r]));
    expect(byName.svc.status).toBe('cloned');
    expect(byName.svc.headCommits).toBe(1);
    expect(byName.empty.status).toBe('empty');
    expect(byName.old.status).toBe('disabled');
    expect(byName.broken.status).toBe('failed');
    expect(byName.broken.error).not.toContain('secret');
    expect(byName.big.status).toBe('cloned');
    expect(byName.big.warnings[0]).toMatch(/Large repository/);

    const second = await sync.syncOne(repos[1]);
    expect(second.status).toBe('fetched');

    const report = buildCoverageReport(first, { 'good0001-aaaa': 4 });
    expect(report.totals).toMatchObject({ discovered: 6, cloned: 3, empty: 1, disabled: 1, failed: 1 });
    expect(report.covered).toBe(4);
    expect(report.coveragePct).toBe(66.7);
    expect(report.notCovered.map((n) => n.name).sort()).toEqual(['broken', 'old']);
    expect(report.repos.find((r) => r.name === 'svc')!.pullRequests).toBe(4);

    const manifest = await sync.readManifest();
    expect(Object.keys(manifest!.repos)).toHaveLength(6);
    expect(fs.readFileSync(path.join(tmpRoot, 'cache1', 'repos', 'manifest.json'), 'utf8')).not.toContain('secret');
  });
});

// ---------- pull requests ----------

const rawPr = (over: any = {}) => ({
  pullRequestId: 7, title: 'feature', status: 3,
  createdBy: { id: 'bob-id', uniqueName: 'bob@example.com', displayName: 'Bob Dev' },
  creationDate: new Date('2026-03-08T09:00:00Z'), closedDate: new Date('2026-03-10T09:00:00Z'),
  lastMergeCommit: { commitId: 'abc' }, isDraft: false,
  reviewers: [{ id: 'carl-id', uniqueName: 'carl@example.com', displayName: 'Carl', vote: 10 }],
  ...over,
});

describe('pull request derivation', () => {
  const repo = repoInfo('r1', 'app', '');

  it('maps ADO PR fields and treats 0001-01-01 as unset', () => {
    const rec = toRecord(rawPr({ status: 1, closedDate: new Date('0001-01-01T00:00:00Z') }), repo);
    expect(rec.status).toBe('active');
    expect(rec.closedDate).toBeUndefined();
    expect(rec.mergeCommitId).toBe('abc');
  });

  it('uses the first non-author comment or vote as first review and skips system noise', () => {
    const rec = toRecord(rawPr(), repo);
    const d = deriveFromThreads([
      { comments: [{ author: { id: 'bob-id', uniqueName: 'bob@example.com' }, publishedDate: '2026-03-08T09:30:00Z', commentType: 1 }] },
      { comments: [{ author: { id: 'svc', uniqueName: 'svc' }, publishedDate: '2026-03-08T09:40:00Z', commentType: 3 }] },
      { properties: { CodeReviewThreadType: { $value: 'VoteUpdate' } },
        comments: [{ author: { id: 'carl-id', uniqueName: 'carl@example.com' }, publishedDate: '2026-03-08T12:00:00Z', commentType: 3 }] },
      { comments: [{ author: { id: 'carl-id', uniqueName: 'carl@example.com' }, publishedDate: '2026-03-08T13:00:00Z', commentType: 1 }] },
      { isDeleted: true, comments: [{ author: { id: 'x', uniqueName: 'x' }, publishedDate: '2026-03-08T09:01:00Z', commentType: 1 }] },
    ], rec);
    expect(d.firstReviewActivityAt).toBe('2026-03-08T12:00:00.000Z');
    expect(d.commentsFromOthers).toBe(1);
    expect(d.commentsByReviewer).toEqual({ 'carl@example.com': 1 });
  });

  it('does not refetch threads for settled PRs, but refreshes active ones', async () => {
    const calls: number[] = [];
    let status = 3;
    const source: PrSource = {
      listPullRequests: async () => [rawPr({ status }), rawPr({ pullRequestId: 8, status: 1 })],
      listThreads: async (_r, id) => { calls.push(id); return []; },
      countIterations: async () => 2,
    };
    const ps = new PrSync(source, { cacheDir: path.join(tmpRoot, 'cache-pr'), includeIterations: true });
    await ps.syncRepo(repo, new Date('2026-01-01'));
    expect(calls.sort()).toEqual([7, 8]);
    calls.length = 0;
    const second = await ps.syncRepo(repo, new Date('2026-01-01'));
    expect(calls).toEqual([8]);
    expect(second.find((p) => p.id === 7)!.iterationCount).toBe(2);
    status = 2; // reopened then abandoned: status change forces refetch
    calls.length = 0;
    await ps.syncRepo(repo, new Date('2026-01-01'));
    expect(calls.sort()).toEqual([7, 8]);
  });

  it('computes author and reviewer PR metrics', () => {
    const base = toRecord(rawPr(), repo);
    const prs: PullRequestRecord[] = [
      { ...base, firstReviewActivityAt: '2026-03-08T12:00:00Z', commentsFromOthers: 2, commentsByReviewer: { 'carl@example.com': 2 } },
      { ...base, id: 8, reviewers: [], commentsFromOthers: 0, commentsByReviewer: {} },                      // no approval
      { ...base, id: 9, status: 'abandoned', closedDate: undefined, mergeCommitId: undefined },
      { ...base, id: 10, creationDate: '2025-01-01T00:00:00Z' },                                          // out of window
    ];
    const sizes = new Map([
      [prKey(prs[0]), [{ path: 'a.ts', added: 150, deleted: 10, binary: false }, { path: 'package-lock.json', added: 9000, deleted: 0, binary: false }]],
      [prKey(prs[1]), [{ path: 'b.ts', added: 900, deleted: 0, binary: false }]],
    ]);
    const m = analyzePullRequests(prs, {
      window: { since: new Date('2026-03-01'), until: new Date('2026-03-31') },
      identity: new IdentityResolver(), prSizes: sizes,
    });
    const bob = m.find((x) => x.developer === 'bob@example.com')!;
    expect(bob).toMatchObject({ prsCreated: 3, prsCompleted: 2, prsAbandoned: 1, abandonPct: 33.3,
      medianHoursToFirstReview: 3, medianHoursToComplete: 48, medianPrLines: 530, prsSized: 2,
      completedWithoutApproval: 1, sizeBands: { small: 1, medium: 0, large: 1 } });
    const carl = m.find((x) => x.developer === 'carl@example.com')!;
    expect(carl.prsReviewed).toBe(2); // PRs 7 and 9; 8 has no reviewers, 10 is outside the window
    expect(carl.reviewCommentsGiven).toBe(2);
  });
});

// ---------- end to end with benchmark ----------

describe('contribution analyzer and benchmark comparison', () => {
  it('syncs, analyzes and compares developers to the benchmark', async () => {
    const src = makeRepo('e2e', [
      { author: CARL, date: '2026-05-04T09:00:00+00:00', files: { 'a.ts': lines(200) }, message: 'c1' },
      { author: CARL, date: '2026-05-11T09:00:00+00:00', files: { 'b.ts': lines(200) }, message: 'c2' },
      { author: CARL, date: '2026-05-18T09:00:00+00:00', files: { 'c.ts': lines(200) }, message: 'c3' },
      { author: CARL, date: '2026-05-18T10:00:00+00:00', files: { 'd.ts': lines(200) }, message: 'c4' },
      { author: ADMIN, date: '2026-05-12T09:00:00+00:00', files: { 'e.ts': lines(100) }, message: 'Merged PR 21: bob work' },
      { author: BOB, date: '2026-05-13T09:00:00+00:00', files: { 'f.ts': lines(100) }, message: 'b2' },
    ]);
    const repo = repoInfo('e2e00001-aaaa', 'e2e', src);
    const mergeSha = git(src, ['log', '--format=%H', '--grep=Merged PR 21']).trim();

    const repoSource: RepoSource = { listProjects: async () => ['Proj'], listRepositories: async () => [repo] };
    const prSource: PrSource = {
      listPullRequests: async () => [
        rawPr({ pullRequestId: 21, creationDate: new Date('2026-05-11T09:00:00Z'), closedDate: new Date('2026-05-12T09:00:00Z'),
          lastMergeCommit: { commitId: mergeSha } }),
        rawPr({ pullRequestId: 22, createdBy: { id: 'carl-id', uniqueName: 'carl@example.com', displayName: 'Carl Tierney' },
          creationDate: new Date('2026-05-17T09:00:00Z'), closedDate: new Date('2026-05-17T15:00:00Z'),
          lastMergeCommit: { commitId: 'notlocal' }, reviewers: [{ id: 'bob-id', uniqueName: 'bob@example.com', vote: 10 }] }),
      ],
      listThreads: async () => [],
      countIterations: async () => 1,
    };
    const analyzer = new ContributionAnalyzer(repoSource, prSource, {
      cacheDir: path.join(tmpRoot, 'cache-e2e'), orgUrl: 'https://dev.azure.com/org', pat: 'p',
      benchmark: ['carl@example.com'],
    });

    const coverage = await analyzer.sync();
    expect(coverage.coveragePct).toBe(100);
    expect(coverage.repos[0].pullRequests).toBe(2);
    expect((await analyzer.coverage()).totals.cloned).toBe(1);

    const window = { since: new Date('2026-05-01'), until: new Date('2026-05-31') };
    const report = await analyzer.analyze({ window });
    expect(report.scope.reposAnalyzed).toBe(1);
    expect(report.dataNotes.squashCommitsCreditedToPrAuthor).toBe(1);
    expect(report.dataNotes.prsWithSize).toBe(1);
    expect(report.developers[0].isBenchmark).toBe(true);
    const bob = report.developers.find((d) => d.developer === 'bob@example.com')!;
    expect(bob.changes!.commits).toBe(2);
    expect(bob.pullRequests!.medianPrLines).toBe(100);

    const cmp = compareToBenchmark(report);
    expect(cmp.benchmark!.developer).toBe('carl@example.com');
    const b = cmp.developers.find((d) => d.developer === 'bob@example.com')!;
    const metric = (n: string) => b.metrics.find((m) => m.metric === n)!;
    // Carl: 4 commits over 3 active weeks; Bob: 2 commits in 1 active week
    expect(metric('commitsPerActiveWeek')).toMatchObject({ value: 2, benchmark: 1.3, ratio: 1.54, betterWhen: 'higher' });
    expect(metric('linesChangedPerActiveWeek')).toMatchObject({ value: 200, benchmark: 266.7 });
    expect(metric('prsCompletedPerActiveWeek')).toMatchObject({ value: 1, benchmark: 0.33 });
    expect(b.throughputIndex).toBeGreaterThan(1);

    const scoped = await analyzer.analyze({ window, developers: ['bob@example.com'] });
    expect(scoped.developers.map((d) => d.developer).sort()).toEqual(['bob@example.com', 'carl@example.com']);

    const noBench = compareToBenchmark(await analyzer.analyze({ window, benchmark: ['nobody@example.com'] }));
    expect(noBench.benchmark).toBeNull();
    expect(noBench.notes[0]).toMatch(/Benchmark developer not found/);
  });

  it('errors clearly before the first sync', async () => {
    const a = new ContributionAnalyzer(
      { listProjects: async () => [], listRepositories: async () => [] },
      { listPullRequests: async () => [], listThreads: async () => [], countIterations: async () => 0 },
      { cacheDir: path.join(tmpRoot, 'cache-none'), orgUrl: 'x', pat: 'p' }
    );
    await expect(a.analyze({ window: { since: new Date('2026-01-01'), until: new Date('2026-02-01') } }))
      .rejects.toThrow(/Run sync_repositories first/);
  });
});

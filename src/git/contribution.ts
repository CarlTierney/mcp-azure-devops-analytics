import fs from 'fs/promises';
import path from 'path';
import { RepoSync, RepoSource, buildCoverageReport, CoverageReport } from './repoSync.js';
import { PrSync, PrSource } from './prSync.js';
import { readCommits, resolveDefaultRef, diffAgainstFirstParent, prIdFromSubject } from './gitLog.js';
import { analyzeChanges, ChangeMetrics, PathFilter, DEFAULT_EXCLUDES, round } from './changeMetrics.js';
import { analyzePullRequests, PrMetrics, prKey } from './prMetrics.js';
import { IdentityResolver } from './identity.js';
import { mapWithConcurrency } from './gitRunner.js';
import { AnalysisWindow, CommitRecord, FileChange, PullRequestRecord, RepoSyncResult } from './types.js';

export interface ContributionConfig {
  cacheDir: string;
  orgUrl: string;
  pat: string;
  identityMapFile?: string;
  benchmark?: string[];          // emails / uniqueNames of the benchmark developer
  excludePaths?: string[];       // replaces DEFAULT_EXCLUDES when set
  cloneConcurrency?: number;
  reworkDays?: number;
}

export interface DeveloperContribution {
  developer: string;
  displayName: string;
  isBenchmark: boolean;
  changes?: ChangeMetrics;
  pullRequests?: PrMetrics;
}

export interface ContributionReport {
  window: { since: string; until: string; weeks: number };
  scope: { project?: string; repository?: string; reposAnalyzed: number; reposSkipped: Array<{ name: string; reason: string }> };
  basis: string;
  developers: DeveloperContribution[];
  dataNotes: {
    commitsInWindow: number;
    duplicateCommitsSkipped: number;
    excludedLinesTotal: number;
    squashCommitsCreditedToPrAuthor: number;
    prsInWindow: number;
    prsWithSize: number;
    possibleDuplicateIdentities: Array<{ name: string; ids: string[] }>;
    excludePatterns: string[];
  };
}

export class ContributionAnalyzer {
  private repoSync: RepoSync;
  private prSync: PrSync;
  private inventoryPath: string;

  constructor(repoSource: RepoSource, private prSource: PrSource, private cfg: ContributionConfig) {
    this.repoSync = new RepoSync(repoSource, {
      cacheDir: cfg.cacheDir, pat: cfg.pat, orgUrl: cfg.orgUrl, concurrency: cfg.cloneConcurrency,
    });
    this.prSync = new PrSync(prSource, { cacheDir: cfg.cacheDir });
    this.inventoryPath = path.join(cfg.cacheDir, 'repos', 'inventory.json');
  }

  /** Clone or fetch every repo, pull PR metadata, and return the coverage report. */
  async sync(params: { project?: string; prSince?: Date; includeIterations?: boolean } = {}): Promise<CoverageReport> {
    const results = await this.repoSync.syncAll(params.project);
    const prSince = params.prSince ?? new Date(Date.now() - 365 * 86400000);
    const prSync = params.includeIterations
      ? new PrSync(this.prSource, { cacheDir: this.cfg.cacheDir, includeIterations: true })
      : this.prSync;

    const prCounts: Record<string, number> = {};
    await mapWithConcurrency(results, 4, async (r) => {
      if (r.status !== 'cloned' && r.status !== 'fetched' && r.status !== 'empty') return;
      try {
        const prs = await prSync.syncRepo(r.repo, prSince);
        prCounts[r.repo.id] = prs.length;
      } catch (e: any) {
        r.warnings.push(`PR metadata sync failed: ${String(e?.message ?? e).split('\n')[0]}`);
      }
    });

    await this.mergeInventory(results, params.project);
    return buildCoverageReport(await this.loadInventory(), prCounts);
  }

  async coverage(): Promise<CoverageReport> {
    const inv = await this.loadInventory();
    const prCounts: Record<string, number> = {};
    for (const r of inv) prCounts[r.repo.id] = (await this.prSync.load(r.repo.id)).length;
    return buildCoverageReport(inv, prCounts);
  }

  async analyze(params: {
    window: AnalysisWindow; project?: string; repository?: string; developers?: string[]; benchmark?: string[];
  }): Promise<ContributionReport> {
    const identity = await IdentityResolver.fromFile(this.cfg.identityMapFile);
    const excludes = this.cfg.excludePaths ?? DEFAULT_EXCLUDES;
    const filter = new PathFilter(excludes);
    const reworkDays = this.cfg.reworkDays ?? 21;
    const lookback = new Date(params.window.since.getTime() - (reworkDays + 7) * 86400000);

    const inventory = await this.loadInventory();
    if (!inventory.length) throw new Error('No repositories synced yet. Run sync_repositories first.');

    const inScope = inventory.filter((r) =>
      (!params.project || eq(r.repo.project, params.project)) &&
      (!params.repository || eq(r.repo.name, params.repository) || r.repo.id === params.repository));
    const skipped: Array<{ name: string; reason: string }> = [];

    const allCommits: CommitRecord[] = [];
    const allPrs: PullRequestRecord[] = [];
    const prSizes = new Map<string, FileChange[]>();
    const authorOverrides = new Map<string, string>();
    let squashCredited = 0;
    let analyzed = 0;

    for (const r of inScope) {
      const label = `${r.repo.project}/${r.repo.name}`;
      if (r.status === 'disabled' || r.status === 'failed') { skipped.push({ name: label, reason: r.error ?? r.status }); continue; }
      if (r.status === 'empty' || !r.localPath) continue;
      const ref = await resolveDefaultRef(r.localPath, r.repo.defaultBranch);
      if (!ref) { skipped.push({ name: label, reason: 'No default branch found' }); continue; }
      analyzed++;

      const commits = await readCommits(r.localPath, r.repo.id, { ref, since: lookback });
      const prs = await this.prSync.load(r.repo.id);
      const prById = new Map(prs.map((p) => [p.id, p]));

      // Squash completions are single-parent "Merged PR N" commits. Credit them to the PR author,
      // since the committer is whoever clicked Complete.
      for (const c of commits) {
        const id = prIdFromSubject(c.subject);
        const pr = id !== undefined ? prById.get(id) : undefined;
        if (pr && c.parents.length === 1) {
          authorOverrides.set(c.sha, identity.resolve(pr.createdBy.uniqueName || pr.createdBy.id, pr.createdBy.displayName));
          squashCredited++;
        }
      }
      allCommits.push(...commits);

      const windowPrs = prs.filter((p) => inWindow(p.creationDate, params.window));
      allPrs.push(...windowPrs);
      const sizes = await this.prSizesFor(r.repo.id, r.localPath, windowPrs);
      for (const [k, v] of sizes) prSizes.set(k, v);
    }

    const changes = analyzeChanges(allCommits, { window: params.window, identity, pathFilter: filter, reworkDays, authorOverrides });
    const prMetrics = analyzePullRequests(allPrs, { window: params.window, identity, prSizes, pathFilter: filter });

    const benchmark = (params.benchmark?.length ? params.benchmark : this.cfg.benchmark) ?? [];
    const devIds = new Set<string>([...changes.developers.map((d) => d.developer), ...prMetrics.map((p) => p.developer)]);
    const wanted = params.developers?.length ? params.developers.map((d) => identity.resolve(d)) : undefined;

    const developers: DeveloperContribution[] = [...devIds]
      .filter((id) => !wanted || wanted.includes(id) || identity.matchesAny(id, benchmark))
      .map((id) => ({
        developer: id,
        displayName: identity.displayName(id),
        isBenchmark: identity.matchesAny(id, benchmark),
        changes: changes.developers.find((d) => d.developer === id),
        pullRequests: prMetrics.find((p) => p.developer === id),
      }))
      .sort((a, b) => Number(b.isBenchmark) - Number(a.isBenchmark) || (b.changes?.commits ?? 0) - (a.changes?.commits ?? 0));

    return {
      window: {
        since: params.window.since.toISOString(),
        until: params.window.until.toISOString(),
        weeks: round((params.window.until.getTime() - params.window.since.getTime()) / (7 * 86400000)),
      },
      scope: { project: params.project, repository: params.repository, reposAnalyzed: analyzed, reposSkipped: skipped },
      basis: 'Commits reachable from each repo\'s default branch (landed work), merges excluded, author date in window. PRs created in window.',
      developers,
      dataNotes: {
        commitsInWindow: changes.commitsInWindow,
        duplicateCommitsSkipped: changes.duplicateCommitsSkipped,
        excludedLinesTotal: changes.excludedLinesTotal,
        squashCommitsCreditedToPrAuthor: squashCredited,
        prsInWindow: allPrs.length,
        prsWithSize: [...prSizes.keys()].length,
        possibleDuplicateIdentities: identity.possibleDuplicates(),
        excludePatterns: excludes,
      },
    };
  }

  /** PR size from the local completion commit, cached by commit SHA (immutable). */
  private async prSizesFor(repoId: string, gitDir: string, prs: PullRequestRecord[]): Promise<Map<string, FileChange[]>> {
    const cacheFile = path.join(this.cfg.cacheDir, 'pr-sizes', `${repoId}.json`);
    let cache: Record<string, FileChange[]> = {};
    try { cache = JSON.parse(await fs.readFile(cacheFile, 'utf8')); } catch { /* first run */ }
    let dirty = false;
    const out = new Map<string, FileChange[]>();
    await mapWithConcurrency(prs.filter((p) => p.status === 'completed' && p.mergeCommitId), 8, async (pr) => {
      const sha = pr.mergeCommitId!;
      if (!cache[sha]) {
        const files = await diffAgainstFirstParent(gitDir, sha);
        if (!files) return;
        cache[sha] = files;
        dirty = true;
      }
      out.set(prKey(pr), cache[sha]);
    });
    if (dirty) {
      await fs.mkdir(path.dirname(cacheFile), { recursive: true });
      await fs.writeFile(cacheFile, JSON.stringify(cache));
    }
    return out;
  }

  private async loadInventory(): Promise<RepoSyncResult[]> {
    try { return JSON.parse(await fs.readFile(this.inventoryPath, 'utf8')); } catch { return []; }
  }

  /** A project-scoped sync replaces only that project's rows. */
  private async mergeInventory(results: RepoSyncResult[], project?: string): Promise<void> {
    const prior = await this.loadInventory();
    const kept = project ? prior.filter((r) => !eq(r.repo.project, project)) : [];
    await fs.mkdir(path.dirname(this.inventoryPath), { recursive: true });
    await fs.writeFile(this.inventoryPath, JSON.stringify([...kept, ...results], null, 2));
  }
}

// ---------- Benchmark comparison ----------

type Better = 'higher' | 'lower' | 'context';

export interface MetricComparison {
  metric: string;
  value: number | null;
  benchmark: number | null;
  ratio: number | null;   // value / benchmark
  betterWhen: Better;
}

export interface BenchmarkComparison {
  benchmark: { developer: string; displayName: string } | null;
  window: ContributionReport['window'];
  developers: Array<{
    developer: string;
    displayName: string;
    activeWeeks: number;
    /** Geometric mean of commit, line and completed-PR rate ratios per active week. 1.0 = benchmark. */
    throughputIndex: number | null;
    metrics: MetricComparison[];
  }>;
  notes: string[];
}

interface MetricDef { metric: string; betterWhen: Better; get: (d: DeveloperContribution, windowWeeks: number) => number | null; }

const perActiveWeek = (n: number | undefined, d: DeveloperContribution) =>
  n === undefined ? null : round(n / Math.max(1, d.changes?.activeWeeks ?? 0), 2);

const METRICS: MetricDef[] = [
  { metric: 'presencePct (active weeks / window weeks)', betterWhen: 'context',
    get: (d, w) => round(((d.changes?.activeWeeks ?? 0) / Math.max(1, w)) * 100) },
  { metric: 'commitsPerActiveWeek', betterWhen: 'higher', get: (d) => d.changes?.commitsPerActiveWeek ?? null },
  { metric: 'linesChangedPerActiveWeek', betterWhen: 'higher', get: (d) => d.changes?.linesChangedPerActiveWeek ?? null },
  { metric: 'medianLinesPerCommit', betterWhen: 'context', get: (d) => d.changes?.medianLinesPerCommit ?? null },
  { metric: 'reposTouched', betterWhen: 'context', get: (d) => d.changes?.reposTouched ?? null },
  { metric: 'reworkPct', betterWhen: 'lower', get: (d) => d.changes?.reworkPct ?? null },
  { metric: 'prsCompletedPerActiveWeek', betterWhen: 'higher', get: (d) => perActiveWeek(d.pullRequests?.prsCompleted, d) },
  { metric: 'medianPrLines', betterWhen: 'lower', get: (d) => d.pullRequests?.medianPrLines ?? null },
  { metric: 'largePrPct', betterWhen: 'lower', get: (d) => {
    const p = d.pullRequests; if (!p || !p.prsSized) return null;
    return round((p.sizeBands.large / p.prsSized) * 100);
  } },
  { metric: 'medianHoursToComplete', betterWhen: 'lower', get: (d) => d.pullRequests?.medianHoursToComplete ?? null },
  { metric: 'medianHoursToFirstReview (others reviewing their PRs)', betterWhen: 'context',
    get: (d) => d.pullRequests?.medianHoursToFirstReview ?? null },
  { metric: 'abandonPct', betterWhen: 'lower', get: (d) => d.pullRequests?.abandonPct ?? null },
  { metric: 'completedWithoutApprovalPct', betterWhen: 'lower', get: (d) => {
    const p = d.pullRequests; if (!p || !p.prsCompleted) return null;
    return round((p.completedWithoutApproval / p.prsCompleted) * 100);
  } },
  { metric: 'medianCommentsReceived', betterWhen: 'context', get: (d) => d.pullRequests?.medianCommentsReceived ?? null },
  { metric: 'prsReviewedPerActiveWeek', betterWhen: 'higher', get: (d) => perActiveWeek(d.pullRequests?.prsReviewed, d) },
];

export function compareToBenchmark(report: ContributionReport): BenchmarkComparison {
  const bench = report.developers.find((d) => d.isBenchmark);
  const w = report.window.weeks;
  const notes: string[] = [];
  if (!bench) {
    notes.push('Benchmark developer not found in this window. Check BENCHMARK_IDENTITY and the identity map; ratios are null.');
  }
  const ratio = (v: number | null, b: number | null) => (v === null || b === null || b === 0 ? null : round(v / b, 2));
  const developers = report.developers.filter((d) => !d.isBenchmark).map((d) => {
    const metrics = METRICS.map((m) => {
      const value = m.get(d, w);
      const benchmark = bench ? m.get(bench, w) : null;
      return { metric: m.metric, value, benchmark, ratio: ratio(value, benchmark), betterWhen: m.betterWhen };
    });
    const pick = ['commitsPerActiveWeek', 'linesChangedPerActiveWeek', 'prsCompletedPerActiveWeek']
      .map((n) => metrics.find((m) => m.metric === n)!.ratio)
      .filter((r): r is number => r !== null && r > 0);
    const throughputIndex = pick.length ? round(Math.exp(pick.reduce((s, r) => s + Math.log(r), 0) / pick.length), 2) : null;
    return { developer: d.developer, displayName: d.displayName, activeWeeks: d.changes?.activeWeeks ?? 0, throughputIndex, metrics };
  }).sort((a, b) => (b.throughputIndex ?? -1) - (a.throughputIndex ?? -1));

  notes.push('Rates are per active week, so part-time or late-joining developers are compared on intensity; presencePct shows how much of the window they were active.');
  notes.push('Lines exclude generated, vendored and lock files (see dataNotes.excludePatterns). Rework is a same-author, same-file approximation, not line-level blame.');
  return {
    benchmark: bench ? { developer: bench.developer, displayName: bench.displayName } : null,
    window: report.window,
    developers,
    notes,
  };
}

function eq(a: string, b: string) { return a.toLowerCase() === b.toLowerCase(); }
function inWindow(isoDate: string, w: AnalysisWindow) {
  const t = Date.parse(isoDate);
  return t >= w.since.getTime() && t <= w.until.getTime();
}

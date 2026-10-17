import fs from 'fs/promises';
import path from 'path';
import { RepoSync, RepoSource, buildCoverageReport, CoverageReport } from './repoSync.js';
import { PrSync, PrSource } from './prSync.js';
import { readCommits, resolveDefaultRef, diffAgainstFirstParent, prIdFromSubject } from './gitLog.js';
import { analyzeChanges, ChangeMetrics, PathFilter, DEFAULT_EXCLUDES, round } from './changeMetrics.js';
import { analyzePullRequests, PrMetrics, prKey } from './prMetrics.js';
import { IdentityResolver } from './identity.js';
import { mapWithConcurrency } from './gitRunner.js';
import { measureSurvival, CommitSurvival } from './survival.js';
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
  /** Days after landing at which code survival is measured. Default 90. */
  survivalDays?: number;
  /** Minimum lines changed for a week to count as active. Default 20. */
  minActiveWeekLines?: number;
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
    survival: { horizonDays: number; enabled: boolean; blamesRun: number; blamesCached: number; filesMissingAtHorizon: number; commitsNotMatured: number };
    minActiveWeekLines: number;
    possibleDuplicateIdentities: Array<{ name: string; ids: string[] }>;
    excludePatterns: string[];
  };
}

export interface AnalyzeParams {
  project?: string;
  repository?: string;
  developers?: string[];
  benchmark?: string[];
  /** Measure code survival with blame. Default true. The first run on a large org is slow; results are cached. */
  survival?: boolean;
}

interface LoadedData {
  identity: IdentityResolver;
  filter: PathFilter;
  excludes: string[];
  reworkDays: number;
  commits: CommitRecord[];
  prs: PullRequestRecord[];
  prSizes: Map<string, FileChange[]>;
  authorOverrides: Map<string, string>;
  survival: Map<string, CommitSurvival>;
  squashCredited: number;
  reposAnalyzed: number;
  skipped: Array<{ name: string; reason: string }>;
  survivalStats: ContributionReport['dataNotes']['survival'];
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

  /** Single-window analysis. */
  async analyze(params: AnalyzeParams & { window: AnalysisWindow }): Promise<ContributionReport> {
    const out = await this.analyzePeriods({ ...params, windows: { window: params.window } });
    return out.window;
  }

  /**
   * Analyze several windows in one pass over the repos. Git history, PR sizes and blame results
   * are loaded once for the union of all windows, then summarized per window.
   */
  async analyzePeriods(params: AnalyzeParams & { windows: Record<string, AnalysisWindow> }): Promise<Record<string, ContributionReport>> {
    const windows = Object.values(params.windows);
    if (!windows.length) throw new Error('At least one window is required.');
    const union: AnalysisWindow = {
      since: new Date(Math.min(...windows.map((w) => w.since.getTime()))),
      until: new Date(Math.max(...windows.map((w) => w.until.getTime()))),
    };
    const data = await this.loadData(union, params);
    const out: Record<string, ContributionReport> = {};
    for (const [label, w] of Object.entries(params.windows)) out[label] = this.buildReport(data, w, params);
    return out;
  }

  private async loadData(union: AnalysisWindow, params: AnalyzeParams): Promise<LoadedData> {
    const identity = await IdentityResolver.fromFile(this.cfg.identityMapFile);
    const excludes = this.cfg.excludePaths ?? DEFAULT_EXCLUDES;
    const filter = new PathFilter(excludes);
    const reworkDays = this.cfg.reworkDays ?? 21;
    const lookback = new Date(union.since.getTime() - (reworkDays + 7) * 86400000);
    const survivalOn = params.survival !== false;
    const horizonDays = this.cfg.survivalDays ?? 90;

    const inventory = await this.loadInventory();
    if (!inventory.length) throw new Error('No repositories synced yet. Run sync_repositories first.');

    const inScope = inventory.filter((r) =>
      (!params.project || eq(r.repo.project, params.project)) &&
      (!params.repository || eq(r.repo.name, params.repository) || r.repo.id === params.repository));

    const data: LoadedData = {
      identity, filter, excludes, reworkDays,
      commits: [], prs: [], prSizes: new Map(), authorOverrides: new Map(), survival: new Map(),
      squashCredited: 0, reposAnalyzed: 0, skipped: [],
      survivalStats: { horizonDays, enabled: survivalOn, blamesRun: 0, blamesCached: 0, filesMissingAtHorizon: 0, commitsNotMatured: 0 },
    };

    for (const r of inScope) {
      const label = `${r.repo.project}/${r.repo.name}`;
      if (r.status === 'disabled' || r.status === 'failed') { data.skipped.push({ name: label, reason: r.error ?? r.status }); continue; }
      if (r.status === 'empty' || !r.localPath) continue;
      const ref = await resolveDefaultRef(r.localPath, r.repo.defaultBranch);
      if (!ref) { data.skipped.push({ name: label, reason: 'No default branch found' }); continue; }
      data.reposAnalyzed++;

      const commits = await readCommits(r.localPath, r.repo.id, { ref, since: lookback });
      const prs = await this.prSync.load(r.repo.id);
      const prById = new Map(prs.map((p) => [p.id, p]));

      // Squash completions are single-parent "Merged PR N" commits. Credit them to the PR author,
      // since the committer is whoever clicked Complete.
      for (const c of commits) {
        const id = prIdFromSubject(c.subject);
        const pr = id !== undefined ? prById.get(id) : undefined;
        if (pr && c.parents.length === 1) {
          data.authorOverrides.set(c.sha, identity.resolve(pr.createdBy.uniqueName || pr.createdBy.id, pr.createdBy.displayName));
          data.squashCredited++;
        }
      }
      data.commits.push(...commits);

      if (survivalOn) {
        const sv = await measureSurvival(r.localPath, ref, commits, {
          horizonDays, pathFilter: filter, since: union.since,
          cacheFile: path.join(this.cfg.cacheDir, 'blame', `${r.repo.id}-${horizonDays}d.json`),
        });
        for (const [sha, v] of sv.byCommit) data.survival.set(sha, v);
        data.survivalStats.blamesRun += sv.blamesRun;
        data.survivalStats.blamesCached += sv.blamesCached;
        data.survivalStats.filesMissingAtHorizon += sv.filesMissingAtHorizon;
        data.survivalStats.commitsNotMatured += sv.commitsNotMatured;
      }

      const unionPrs = prs.filter((p) => inWindow(p.creationDate, union));
      data.prs.push(...unionPrs);
      const sizes = await this.prSizesFor(r.repo.id, r.localPath, unionPrs);
      for (const [k, v] of sizes) data.prSizes.set(k, v);
    }
    return data;
  }

  private buildReport(data: LoadedData, window: AnalysisWindow, params: AnalyzeParams): ContributionReport {
    const { identity } = data;
    const minActiveWeekLines = this.cfg.minActiveWeekLines ?? 20;
    const changes = analyzeChanges(data.commits, {
      window, identity, pathFilter: data.filter, reworkDays: data.reworkDays,
      authorOverrides: data.authorOverrides, survival: data.survival, minActiveWeekLines,
    });
    const windowPrs = data.prs.filter((p) => inWindow(p.creationDate, window));
    const prMetrics = analyzePullRequests(windowPrs, { window, identity, prSizes: data.prSizes, pathFilter: data.filter });

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
        since: window.since.toISOString(),
        until: window.until.toISOString(),
        weeks: round((window.until.getTime() - window.since.getTime()) / (7 * 86400000)),
      },
      scope: { project: params.project, repository: params.repository, reposAnalyzed: data.reposAnalyzed, reposSkipped: data.skipped },
      basis: 'Commits reachable from each repo\'s default branch (landed work), merges excluded, author date in window. PRs created in window.',
      developers,
      dataNotes: {
        commitsInWindow: changes.commitsInWindow,
        duplicateCommitsSkipped: changes.duplicateCommitsSkipped,
        excludedLinesTotal: changes.excludedLinesTotal,
        squashCommitsCreditedToPrAuthor: data.squashCredited,
        prsInWindow: windowPrs.length,
        prsWithSize: windowPrs.filter((p) => data.prSizes.has(prKey(p))).length,
        survival: data.survivalStats,
        minActiveWeekLines,
        possibleDuplicateIdentities: identity.possibleDuplicates(),
        excludePatterns: data.excludes,
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
  benchmarkWindow: ContributionReport['window'];
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
  { metric: 'survivalPct', betterWhen: 'higher', get: (d) => d.changes?.survivalPct ?? null },
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

/**
 * Compare developers in `report` to the benchmark. By default the benchmark comes from the same
 * report; pass `benchReport` to take the benchmark's figures from a different window (for
 * example, only the period the benchmark was hands-on).
 */
export function compareToBenchmark(report: ContributionReport, benchReport?: ContributionReport): BenchmarkComparison {
  const bench = (benchReport ?? report).developers.find((d) => d.isBenchmark);
  const w = report.window.weeks;
  const bw = (benchReport ?? report).window.weeks;
  const notes: string[] = [];
  if (!bench) {
    notes.push('Benchmark developer not found in this window. Check BENCHMARK_IDENTITY and the identity map; ratios are null.');
  }
  const ratio = (v: number | null, b: number | null) => (v === null || b === null || b === 0 ? null : round(v / b, 2));
  const developers = report.developers.filter((d) => !d.isBenchmark).map((d) => {
    const metrics = METRICS.map((m) => {
      const value = m.get(d, w);
      const benchmark = bench ? m.get(bench, bw) : null;
      return { metric: m.metric, value, benchmark, ratio: ratio(value, benchmark), betterWhen: m.betterWhen };
    });
    const pick = ['commitsPerActiveWeek', 'linesChangedPerActiveWeek', 'prsCompletedPerActiveWeek']
      .map((n) => metrics.find((m) => m.metric === n)!.ratio)
      .filter((r): r is number => r !== null && r > 0);
    const throughputIndex = pick.length ? round(Math.exp(pick.reduce((s, r) => s + Math.log(r), 0) / pick.length), 2) : null;
    return { developer: d.developer, displayName: d.displayName, activeWeeks: d.changes?.activeWeeks ?? 0, throughputIndex, metrics };
  }).sort((a, b) => (b.throughputIndex ?? -1) - (a.throughputIndex ?? -1));

  notes.push('Rates are per active week, so part-time or late-joining developers are compared on intensity; presencePct shows how much of the window they were active.');
  notes.push(`A week counts as active only with at least ${report.dataNotes.minActiveWeekLines} lines changed; lighter weeks are listed per developer as lightWeeksIgnored.`);
  notes.push('Lines exclude generated, vendored and lock files (see dataNotes.excludePatterns). Rework is a same-author, same-file approximation. survivalPct is line-level blame at a fixed horizon after landing.');
  return {
    benchmark: bench ? { developer: bench.developer, displayName: bench.displayName } : null,
    benchmarkWindow: (benchReport ?? report).window,
    window: report.window,
    developers,
    notes,
  };
}

export interface PeriodComparison {
  benchmark: { developer: string; displayName: string } | null;
  benchmarkWindow: ContributionReport['window'];
  periods: Record<string, BenchmarkComparison>;
  /** Same developer across periods, each period against the same benchmark. */
  acrossPeriods: Array<{
    developer: string;
    displayName: string;
    byPeriod: Record<string, { activeWeeks: number; throughputIndex: number | null; survivalPct: number | null; reworkPct: number | null }>;
  }>;
  notes: string[];
}

export function comparePeriods(periods: Record<string, ContributionReport>, benchReport: ContributionReport): PeriodComparison {
  const compared: Record<string, BenchmarkComparison> = {};
  for (const [label, rep] of Object.entries(periods)) compared[label] = compareToBenchmark(rep, benchReport);

  const ids = new Map<string, string>();
  for (const c of Object.values(compared)) for (const d of c.developers) ids.set(d.developer, d.displayName);
  const acrossPeriods = [...ids.entries()].map(([developer, displayName]) => {
    const byPeriod: PeriodComparison['acrossPeriods'][number]['byPeriod'] = {};
    for (const [label, c] of Object.entries(compared)) {
      const d = c.developers.find((x) => x.developer === developer);
      const val = (n: string) => d?.metrics.find((m) => m.metric === n)?.value ?? null;
      byPeriod[label] = { activeWeeks: d?.activeWeeks ?? 0, throughputIndex: d?.throughputIndex ?? null,
        survivalPct: val('survivalPct'), reworkPct: val('reworkPct') };
    }
    return { developer, displayName, byPeriod };
  }).sort((a, b) => a.displayName.localeCompare(b.displayName));

  const first = Object.values(compared)[0];
  return {
    benchmark: first?.benchmark ?? null,
    benchmarkWindow: benchReport.window,
    periods: compared,
    acrossPeriods,
    notes: [
      'Every period is compared to the same benchmark window, so throughputIndex is comparable across periods.',
      'A shift across periods is evidence, not attribution: team makeup, tooling and codebase state change over time.',
      ...(first?.notes ?? []),
    ],
  };
}

function eq(a: string, b: string) { return a.toLowerCase() === b.toLowerCase(); }
function inWindow(isoDate: string, w: AnalysisWindow) {
  const t = Date.parse(isoDate);
  return t >= w.since.getTime() && t <= w.until.getTime();
}

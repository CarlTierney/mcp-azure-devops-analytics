import { CommitRecord, FileChange, AnalysisWindow } from './types.js';
import { IdentityResolver } from './identity.js';
import type { CommitSurvival } from './survival.js';

/** Generated, vendored or lock files. Lines here say nothing about effort. Override with EXCLUDE_PATHS. */
export const DEFAULT_EXCLUDES = [
  '**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/*.lock', '**/packages.lock.json',
  '**/*.min.js', '**/*.min.css', '**/*.map',
  '**/node_modules/**', '**/dist/**', '**/bin/**', '**/obj/**', '**/vendor/**', '**/packages/**',
  '**/*.designer.cs', '**/*.Designer.cs', '**/*.Designer.vb', '**/*.g.cs', '**/*.g.i.cs',
  '**/Migrations/*.Designer.cs', '**/*ModelSnapshot.cs', '**/__snapshots__/**', '**/*.snap',
];

export class PathFilter {
  private regexes: RegExp[];
  constructor(globs: string[] = DEFAULT_EXCLUDES) {
    this.regexes = globs.map(globToRegex);
  }
  excluded(path: string): boolean {
    return this.regexes.some((r) => r.test(path));
  }
}

export function globToRegex(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // "**/" matches zero or more directories
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

export interface ChangeMetrics {
  developer: string;
  displayName: string;
  commits: number;
  activeDays: number;
  activeWeeks: number;
  reposTouched: number;
  linesAdded: number;
  linesDeleted: number;
  fileTouches: number;
  distinctFiles: number;
  excludedLines: number;
  medianLinesPerCommit: number;
  commitsPerActiveWeek: number;
  linesChangedPerActiveWeek: number;
  /** Lines the same developer deleted from a file they changed within the rework window. Approximation, not blame. */
  reworkLines: number;
  reworkPct: number;
  /** Share of added lines still attributed to the developer by blame at the survival horizon. */
  survivalPct?: number;
  survivalLinesMeasured: number;
  /** Weeks with commits that fell under the minimum-activity threshold and were not counted as active. */
  lightWeeksIgnored: number;
  firstCommit?: string;
  lastCommit?: string;
}

export interface ChangeAnalysisOptions {
  window: AnalysisWindow;
  identity: IdentityResolver;
  pathFilter?: PathFilter;
  reworkDays?: number;
  /** Commit SHA -> developer id override (e.g. squash commits credited to the PR author). */
  authorOverrides?: Map<string, string>;
  /** Commit SHA -> survival counts from measureSurvival(). */
  survival?: Map<string, CommitSurvival>;
  /** A week counts as active only if the developer changed at least this many lines in it. Default 0. */
  minActiveWeekLines?: number;
}

export interface ChangeAnalysisResult {
  developers: ChangeMetrics[];
  commitsInWindow: number;
  duplicateCommitsSkipped: number;
  excludedLinesTotal: number;
}

/**
 * Aggregate per-developer change metrics. Commits should cover window.since minus the rework
 * window so rework lookback works at the start of the window.
 * Commits appearing in more than one repo (forks) are counted once, in the first repo seen.
 */
export function analyzeChanges(commits: CommitRecord[], opts: ChangeAnalysisOptions): ChangeAnalysisResult {
  const filter = opts.pathFilter ?? new PathFilter();
  const reworkMs = (opts.reworkDays ?? 21) * 86400000;
  const since = opts.window.since.getTime();
  const until = opts.window.until.getTime();

  const seen = new Set<string>();
  let duplicates = 0;
  const unique: CommitRecord[] = [];
  for (const c of commits) {
    if (seen.has(c.sha)) { duplicates++; continue; }
    seen.add(c.sha);
    unique.push(c);
  }
  unique.sort((a, b) => Date.parse(a.authorDate) - Date.parse(b.authorDate));

  interface Acc {
    commits: number; days: Set<string>; weeks: Set<string>; repos: Set<string>;
    added: number; deleted: number; touches: number; files: Set<string>; excluded: number;
    perCommit: number[]; rework: number; first?: string; last?: string;
    weekLines: Map<string, number>; survAdded: number; survived: number;
  }
  const acc = new Map<string, Acc>();
  const lastTouch = new Map<string, number>(); // dev|repo|path -> time
  let inWindow = 0;
  let excludedTotal = 0;

  for (const c of unique) {
    const t = Date.parse(c.authorDate);
    const dev = opts.authorOverrides?.get(c.sha) ?? opts.identity.resolve(c.authorEmail, c.authorName);
    const counted = t >= since && t <= until;
    let commitLines = 0;
    let commitRework = 0;
    let commitExcluded = 0;
    const kept: FileChange[] = [];

    for (const f of c.files) {
      if (filter.excluded(f.path)) { commitExcluded += f.added + f.deleted; continue; }
      kept.push(f);
      commitLines += f.added + f.deleted;
      const key = `${dev}|${c.repoId}|${f.path}`;
      const prev = lastTouch.get(key);
      if (prev !== undefined && t - prev <= reworkMs) commitRework += f.deleted;
      lastTouch.set(key, t);
    }

    if (!counted) continue;
    inWindow++;
    excludedTotal += commitExcluded;
    let a = acc.get(dev);
    if (!a) {
      a = { commits: 0, days: new Set(), weeks: new Set(), repos: new Set(), added: 0, deleted: 0,
        touches: 0, files: new Set(), excluded: 0, perCommit: [], rework: 0,
        weekLines: new Map(), survAdded: 0, survived: 0 };
      acc.set(dev, a);
    }
    a.commits++;
    a.days.add(c.authorDate.slice(0, 10)); // author's local calendar day
    const wk = isoWeek(c.authorDate);
    a.weeks.add(wk);
    a.weekLines.set(wk, (a.weekLines.get(wk) ?? 0) + commitLines);
    const sv = opts.survival?.get(c.sha);
    if (sv) { a.survAdded += sv.added; a.survived += sv.survived; }
    a.repos.add(c.repoId);
    for (const f of kept) {
      a.added += f.added;
      a.deleted += f.deleted;
      a.touches++;
      a.files.add(`${c.repoId}|${f.path}`);
    }
    a.excluded += commitExcluded;
    a.perCommit.push(commitLines);
    a.rework += commitRework;
    a.first = a.first ?? c.authorDate;
    a.last = c.authorDate;
  }

  const minWeek = opts.minActiveWeekLines ?? 0;
  const developers: ChangeMetrics[] = [...acc.entries()].map(([dev, a]) => {
    const active = [...a.weekLines.values()].filter((n) => n >= minWeek).length;
    const weeks = active || 1;
    return {
      developer: dev,
      displayName: opts.identity.displayName(dev),
      commits: a.commits,
      activeDays: a.days.size,
      activeWeeks: active,
      reposTouched: a.repos.size,
      linesAdded: a.added,
      linesDeleted: a.deleted,
      fileTouches: a.touches,
      distinctFiles: a.files.size,
      excludedLines: a.excluded,
      medianLinesPerCommit: median(a.perCommit),
      commitsPerActiveWeek: round(a.commits / weeks),
      linesChangedPerActiveWeek: round((a.added + a.deleted) / weeks),
      reworkLines: a.rework,
      reworkPct: a.added ? round((a.rework / a.added) * 100) : 0,
      survivalPct: a.survAdded ? round((a.survived / a.survAdded) * 100) : undefined,
      survivalLinesMeasured: a.survAdded,
      lightWeeksIgnored: a.weeks.size - active,
      firstCommit: a.first,
      lastCommit: a.last,
    };
  }).sort((x, y) => y.commits - x.commits);

  return { developers, commitsInWindow: inWindow, duplicateCommitsSkipped: duplicates, excludedLinesTotal: excludedTotal };
}

export function isoWeek(iso: string): string {
  // Use the calendar date as written (author's local day), not UTC.
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : round((s[mid - 1] + s[mid]) / 2);
}

export function round(n: number, dp = 1): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

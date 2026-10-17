import { PullRequestRecord, AnalysisWindow, FileChange } from './types.js';
import { IdentityResolver } from './identity.js';
import { PathFilter, median, round } from './changeMetrics.js';

export interface PrSizeBands { small: number; medium: number; large: number; }

export interface PrMetrics {
  developer: string;
  displayName: string;
  // As author
  prsCreated: number;
  prsCompleted: number;
  prsAbandoned: number;
  prsActive: number;
  abandonPct: number;
  medianHoursToFirstReview?: number;
  medianHoursToComplete?: number;
  medianPrLines?: number;
  sizeBands: PrSizeBands;
  prsSized: number;
  completedWithoutApproval: number;
  medianCommentsReceived: number;
  medianIterations?: number;
  // As reviewer
  prsReviewed: number;
  reviewCommentsGiven: number;
}

export interface PrAnalysisOptions {
  window: AnalysisWindow;
  identity: IdentityResolver;
  /** PR key "repoId#id" -> file changes of its completion commit, from the local mirror. */
  prSizes?: Map<string, FileChange[]>;
  pathFilter?: PathFilter;
  smallMax?: number;   // lines changed, inclusive
  mediumMax?: number;
}

export const prKey = (pr: { repoId: string; id: number }) => `${pr.repoId}#${pr.id}`;

/** Approve (10) or approve with suggestions (5), by a person other than the author. */
function hasIndependentApproval(pr: PullRequestRecord): boolean {
  const author = pr.createdBy.id;
  return pr.reviewers.some((r) => !r.isContainer && r.id !== author && r.vote >= 5);
}

export function analyzePullRequests(prs: PullRequestRecord[], opts: PrAnalysisOptions): PrMetrics[] {
  const since = opts.window.since.getTime();
  const until = opts.window.until.getTime();
  const filter = opts.pathFilter ?? new PathFilter();
  const smallMax = opts.smallMax ?? 200;
  const mediumMax = opts.mediumMax ?? 800;

  interface Acc {
    created: number; completed: number; abandoned: number; active: number;
    firstReview: number[]; complete: number[]; lines: number[]; bands: PrSizeBands;
    noApproval: number; comments: number[]; iterations: number[];
    reviewed: Set<string>; commentsGiven: number;
  }
  const acc = new Map<string, Acc>();
  const get = (dev: string) => {
    let a = acc.get(dev);
    if (!a) {
      a = { created: 0, completed: 0, abandoned: 0, active: 0, firstReview: [], complete: [], lines: [],
        bands: { small: 0, medium: 0, large: 0 }, noApproval: 0, comments: [], iterations: [],
        reviewed: new Set(), commentsGiven: 0 };
      acc.set(dev, a);
    }
    return a;
  };

  for (const pr of prs) {
    const created = Date.parse(pr.creationDate);
    if (Number.isNaN(created) || created < since || created > until) continue;
    const author = opts.identity.resolve(pr.createdBy.uniqueName || pr.createdBy.id, pr.createdBy.displayName);
    const a = get(author);
    a.created++;
    if (pr.status === 'completed') a.completed++;
    else if (pr.status === 'abandoned') a.abandoned++;
    else if (pr.status === 'active') a.active++;

    if (pr.firstReviewActivityAt) a.firstReview.push(hours(created, Date.parse(pr.firstReviewActivityAt)));
    if (pr.status === 'completed' && pr.closedDate) {
      a.complete.push(hours(created, Date.parse(pr.closedDate)));
      if (!hasIndependentApproval(pr)) a.noApproval++;
    }
    a.comments.push(pr.commentsFromOthers);
    if (pr.iterationCount !== undefined) a.iterations.push(pr.iterationCount);

    const files = opts.prSizes?.get(prKey(pr));
    if (files) {
      const lines = files.filter((f) => !filter.excluded(f.path)).reduce((s, f) => s + f.added + f.deleted, 0);
      a.lines.push(lines);
      if (lines <= smallMax) a.bands.small++;
      else if (lines <= mediumMax) a.bands.medium++;
      else a.bands.large++;
    }

    // Reviewer side: voted or commented, and not the author.
    const authorId = pr.createdBy.id;
    for (const r of pr.reviewers) {
      if (r.isContainer || r.id === authorId || r.vote === 0) continue;
      get(opts.identity.resolve(r.uniqueName || r.id, r.displayName)).reviewed.add(prKey(pr));
    }
    for (const [who, n] of Object.entries(pr.commentsByReviewer)) {
      const dev = opts.identity.resolve(who);
      if (dev === author) continue;
      const ra = get(dev);
      ra.reviewed.add(prKey(pr));
      ra.commentsGiven += n;
    }
  }

  return [...acc.entries()].map(([dev, a]) => ({
    developer: dev,
    displayName: opts.identity.displayName(dev),
    prsCreated: a.created,
    prsCompleted: a.completed,
    prsAbandoned: a.abandoned,
    prsActive: a.active,
    abandonPct: a.created ? round((a.abandoned / a.created) * 100) : 0,
    medianHoursToFirstReview: a.firstReview.length ? median(a.firstReview) : undefined,
    medianHoursToComplete: a.complete.length ? median(a.complete) : undefined,
    medianPrLines: a.lines.length ? median(a.lines) : undefined,
    sizeBands: a.bands,
    prsSized: a.lines.length,
    completedWithoutApproval: a.noApproval,
    medianCommentsReceived: median(a.comments),
    medianIterations: a.iterations.length ? median(a.iterations) : undefined,
    prsReviewed: a.reviewed.size,
    reviewCommentsGiven: a.commentsGiven,
  })).sort((x, y) => y.prsCreated - x.prsCreated);
}

function hours(from: number, to: number): number {
  return round(Math.max(0, to - from) / 3600000);
}

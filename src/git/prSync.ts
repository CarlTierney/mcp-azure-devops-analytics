import fs from 'fs/promises';
import path from 'path';
import type * as azdev from 'azure-devops-node-api';
import { mapWithConcurrency } from './gitRunner.js';
import { withRetry } from './retry.js';
import { PullRequestRecord, RepoInfo } from './types.js';

/** Raw ADO thread shape we rely on (subset of GitPullRequestCommentThread). */
export interface RawThread {
  publishedDate?: Date | string;
  isDeleted?: boolean;
  properties?: Record<string, { $value?: unknown } | undefined>;
  comments?: Array<{
    author?: { id?: string; uniqueName?: string; displayName?: string };
    publishedDate?: Date | string;
    commentType?: number | string;
    isDeleted?: boolean;
  }>;
}

export interface PrSource {
  listPullRequests(repo: RepoInfo, since: Date): Promise<any[]>;
  listThreads(repo: RepoInfo, prId: number): Promise<RawThread[]>;
  countIterations(repo: RepoInfo, prId: number): Promise<number>;
}

const STATUS_ALL = 4;
const RANGE_CREATED = 1;

export function sdkPrSource(connection: azdev.WebApi): PrSource {
  return {
    async listPullRequests(repo, since) {
      const git = await connection.getGitApi();
      const out: any[] = [];
      const top = 500;
      for (let skip = 0; ; skip += top) {
        const batch = await withRetry(() => git.getPullRequests(
          repo.id,
          { status: STATUS_ALL, minTime: since, queryTimeRangeType: RANGE_CREATED } as any,
          repo.project, undefined, skip, top
        ));
        out.push(...batch);
        if (batch.length < top) break;
      }
      return out;
    },
    async listThreads(repo, prId) {
      const git = await connection.getGitApi();
      return (await withRetry(() => git.getThreads(repo.id, prId, repo.project))) as RawThread[];
    },
    async countIterations(repo, prId) {
      const git = await connection.getGitApi();
      return (await withRetry(() => git.getPullRequestIterations(repo.id, prId, repo.project, false))).length;
    },
  };
}

export interface PrSyncOptions {
  cacheDir: string;
  concurrency?: number;
  includeIterations?: boolean;
}

/**
 * Pull PR metadata per repo and cache it. Completed and abandoned PRs whose threads were
 * already fetched are not re-fetched; active PRs are refreshed every run.
 */
export class PrSync {
  private dir: string;
  constructor(private source: PrSource, private opts: PrSyncOptions) {
    this.dir = path.join(opts.cacheDir, 'pull-requests');
  }

  async syncRepo(repo: RepoInfo, since: Date): Promise<PullRequestRecord[]> {
    await fs.mkdir(this.dir, { recursive: true });
    const cached = new Map((await this.load(repo.id)).map((p) => [p.id, p]));
    const raw = await this.source.listPullRequests(repo, since);
    const records = raw.map((r) => toRecord(r, repo));

    const merged = await mapWithConcurrency(records, this.opts.concurrency ?? 8, async (rec) => {
      const prior = cached.get(rec.id);
      const settled = rec.status !== 'active' && prior?.threadsFetchedAt && prior.status === rec.status;
      if (settled) {
        return { ...rec, ...pickThreadFields(prior!) };
      }
      const threads = await this.source.listThreads(repo, rec.id);
      Object.assign(rec, deriveFromThreads(threads, rec));
      if (this.opts.includeIterations) {
        rec.iterationCount = await this.source.countIterations(repo, rec.id);
      }
      rec.threadsFetchedAt = new Date().toISOString();
      return rec;
    });

    // Keep cached PRs that fell outside this query window so history accumulates.
    for (const r of merged) cached.set(r.id, r);
    const all = [...cached.values()];
    await fs.writeFile(this.file(repo.id), JSON.stringify(all));
    return all;
  }

  async load(repoId: string): Promise<PullRequestRecord[]> {
    try {
      return JSON.parse(await fs.readFile(this.file(repoId), 'utf8'));
    } catch {
      return [];
    }
  }

  private file(repoId: string) {
    return path.join(this.dir, `${repoId}.json`);
  }
}

function pickThreadFields(p: PullRequestRecord) {
  return {
    firstReviewActivityAt: p.firstReviewActivityAt,
    commentsFromOthers: p.commentsFromOthers,
    commentsByReviewer: p.commentsByReviewer,
    iterationCount: p.iterationCount,
    threadsFetchedAt: p.threadsFetchedAt,
  };
}

export function toRecord(r: any, repo: RepoInfo): PullRequestRecord {
  const statusMap: Record<string | number, PullRequestRecord['status']> = {
    1: 'active', 2: 'abandoned', 3: 'completed', active: 'active', abandoned: 'abandoned', completed: 'completed',
  };
  return {
    id: r.pullRequestId,
    repoId: repo.id,
    project: repo.project,
    title: r.title ?? '',
    status: statusMap[r.status] ?? 'unknown',
    createdBy: {
      id: r.createdBy?.id ?? '',
      uniqueName: r.createdBy?.uniqueName ?? '',
      displayName: r.createdBy?.displayName ?? '',
    },
    creationDate: iso(r.creationDate)!,
    closedDate: iso(r.closedDate),
    mergeCommitId: r.lastMergeCommit?.commitId,
    sourceRef: r.sourceRefName,
    targetRef: r.targetRefName,
    isDraft: r.isDraft === true,
    reviewers: (r.reviewers ?? []).map((v: any) => ({
      id: v.id ?? '',
      uniqueName: v.uniqueName ?? '',
      displayName: v.displayName ?? '',
      vote: v.vote ?? 0,
      isContainer: v.isContainer === true,
    })),
    commentsFromOthers: 0,
    commentsByReviewer: {},
  };
}

/**
 * First review activity = earliest human comment or vote by someone other than the PR author.
 * Vote changes arrive as system threads tagged CodeReviewThreadType=VoteUpdate.
 */
export function deriveFromThreads(threads: RawThread[], pr: PullRequestRecord) {
  const authorId = pr.createdBy.id;
  const authorName = pr.createdBy.uniqueName.toLowerCase();
  const isAuthor = (a?: { id?: string; uniqueName?: string }) =>
    !!a && ((!!authorId && a.id === authorId) || (!!authorName && (a.uniqueName ?? '').toLowerCase() === authorName));
  let first: number | undefined;
  let fromOthers = 0;
  const byReviewer: Record<string, number> = {};

  for (const t of threads) {
    if (t.isDeleted) continue;
    const kind = t.properties?.CodeReviewThreadType?.$value;
    for (const c of t.comments ?? []) {
      if (c.isDeleted || isAuthor(c.author)) continue;
      const when = Date.parse(String(c.publishedDate ?? t.publishedDate ?? ''));
      const system = c.commentType === 3 || c.commentType === 'system';
      if (system && kind !== 'VoteUpdate') continue;
      if (!Number.isNaN(when)) first = first === undefined ? when : Math.min(first, when);
      if (!system) {
        fromOthers++;
        const who = (c.author?.uniqueName || c.author?.displayName || 'unknown').toLowerCase();
        byReviewer[who] = (byReviewer[who] ?? 0) + 1;
      }
    }
  }
  return {
    firstReviewActivityAt: first !== undefined ? new Date(first).toISOString() : undefined,
    commentsFromOthers: fromOthers,
    commentsByReviewer: byReviewer,
  };
}

function iso(d: Date | string | undefined): string | undefined {
  if (!d) return undefined;
  const t = new Date(d);
  // ADO returns 0001-01-01 for "not set"
  return Number.isNaN(t.getTime()) || t.getUTCFullYear() < 1971 ? undefined : t.toISOString();
}

import fs from 'fs/promises';
import path from 'path';
import type * as azdev from 'azure-devops-node-api';
import { runGit, mapWithConcurrency, scrub } from './gitRunner.js';
import { withRetry } from './retry.js';
import { Manifest, RepoInfo, RepoSyncResult } from './types.js';

export interface RepoSyncOptions {
  cacheDir: string;
  pat: string;
  orgUrl: string;
  concurrency?: number;
  /** Repos above this size get a warning. They are still cloned. */
  largeRepoWarnBytes?: number;
  /** Per-repo git timeout. Large first clones need a long one. */
  gitTimeoutMs?: number;
}

/** Minimal surface of the SDK we use, so tests can supply a fake. */
export interface RepoSource {
  listProjects(): Promise<string[]>;
  listRepositories(project: string): Promise<RepoInfo[]>;
}

export function sdkRepoSource(connection: azdev.WebApi): RepoSource {
  return {
    async listProjects() {
      const core = await connection.getCoreApi();
      const names: string[] = [];
      const page = 500;
      for (let skip = 0; ; skip += page) {
        const batch = await withRetry(() => core.getProjects(undefined, page, skip));
        names.push(...batch.map((p) => p.name!).filter(Boolean));
        if (batch.length < page) break;
      }
      return names;
    },
    async listRepositories(project: string) {
      const git = await connection.getGitApi();
      // includeHidden = true so nothing is silently left out
      const repos = await withRetry(() => git.getRepositories(project, false, false, true));
      return repos.map((r) => ({
        id: r.id!,
        name: r.name!,
        project: r.project?.name ?? project,
        remoteUrl: r.remoteUrl ?? '',
        defaultBranch: r.defaultBranch,
        sizeBytes: r.size ?? 0,
        isDisabled: r.isDisabled === true,
        isFork: r.isFork === true,
        parentRepoId: r.parentRepository?.id,
      }));
    },
  };
}

export class RepoSync {
  private reposDir: string;
  private manifestPath: string;

  constructor(private source: RepoSource, private opts: RepoSyncOptions) {
    this.reposDir = path.join(opts.cacheDir, 'repos');
    this.manifestPath = path.join(opts.cacheDir, 'repos', 'manifest.json');
  }

  async discover(projectFilter?: string): Promise<RepoInfo[]> {
    const projects = projectFilter ? [projectFilter] : await this.source.listProjects();
    const all: RepoInfo[] = [];
    for (const project of projects) {
      all.push(...(await this.source.listRepositories(project)));
    }
    // Stable order: parents before forks, so SHA dedupe credits the parent repo first.
    return all.sort((a, b) => Number(a.isFork) - Number(b.isFork) || a.project.localeCompare(b.project) || a.name.localeCompare(b.name));
  }

  localPathFor(repo: RepoInfo): string {
    const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_');
    return path.join(this.reposDir, safe(repo.project), `${safe(repo.name)}-${repo.id.slice(0, 8)}.git`);
  }

  async syncAll(projectFilter?: string): Promise<RepoSyncResult[]> {
    await fs.mkdir(this.reposDir, { recursive: true });
    const repos = await this.discover(projectFilter);
    const results = await mapWithConcurrency(repos, this.opts.concurrency ?? 6, (repo) => this.syncOne(repo));
    await this.writeManifest(results);
    return results;
  }

  async syncOne(repo: RepoInfo): Promise<RepoSyncResult> {
    const started = Date.now();
    const warnings: string[] = [];
    const localPath = this.localPathFor(repo);
    const done = (partial: Omit<RepoSyncResult, 'repo' | 'durationMs' | 'warnings'>): RepoSyncResult => ({
      repo, warnings, durationMs: Date.now() - started, ...partial,
    });

    if (repo.isDisabled) {
      return done({ status: 'disabled', error: 'Repository is disabled in Azure DevOps; clone and API access are blocked.' });
    }
    const warnAt = this.opts.largeRepoWarnBytes ?? 2 * 1024 ** 3;
    if (repo.sizeBytes > warnAt) {
      warnings.push(`Large repository (${(repo.sizeBytes / 1024 ** 3).toFixed(1)} GB); first clone may be slow.`);
    }

    const gitOpts = { pat: this.opts.pat, timeoutMs: this.opts.gitTimeoutMs ?? 60 * 60 * 1000 };
    const url = stripUserInfo(repo.remoteUrl);
    try {
      const exists = await isGitDir(localPath);
      let status: 'cloned' | 'fetched';
      if (exists) {
        await runGit(['--git-dir', localPath, 'fetch', '--prune', '--quiet', 'origin'], gitOpts);
        status = 'fetched';
      } else {
        await fs.mkdir(path.dirname(localPath), { recursive: true });
        await runGit(['clone', '--mirror', '--quiet', url, localPath], gitOpts);
        status = 'cloned';
      }
      // ADO may not advertise PR refs in a plain mirror fetch; ask for them explicitly. Best effort.
      const pr = await runGit(
        ['--git-dir', localPath, 'fetch', '--quiet', 'origin', '+refs/pull/*:refs/pull/*'],
        { ...gitOpts, allowFailure: true }
      );
      if (pr.code !== 0 && !/couldn't find remote ref/i.test(pr.stderr)) {
        warnings.push(`Could not fetch PR refs: ${scrub(pr.stderr).trim().split('\n')[0]}`);
      }

      const heads = await runGit(['--git-dir', localPath, 'for-each-ref', '--count=1', 'refs/heads'], gitOpts);
      if (!heads.stdout.trim()) {
        return done({ status: 'empty', localPath });
      }
      const count = await runGit(['--git-dir', localPath, 'rev-list', '--count', '--branches', '--tags'], gitOpts);
      return done({ status, localPath, headCommits: Number(count.stdout.trim()) || 0 });
    } catch (e: any) {
      return done({ status: 'failed', localPath, error: scrub(String(e?.message ?? e)) });
    }
  }

  async readManifest(): Promise<Manifest | undefined> {
    try {
      return JSON.parse(await fs.readFile(this.manifestPath, 'utf8'));
    } catch {
      return undefined;
    }
  }

  private async writeManifest(results: RepoSyncResult[]): Promise<void> {
    const prior = (await this.readManifest()) ?? { orgUrl: this.opts.orgUrl, updatedAt: '', repos: {} };
    const now = new Date().toISOString();
    for (const r of results) {
      prior.repos[r.repo.id] = {
        repoId: r.repo.id,
        name: r.repo.name,
        project: r.repo.project,
        localPath: r.localPath ?? this.localPathFor(r.repo),
        lastSyncAt: now,
        lastStatus: r.status,
        lastError: r.error,
      };
    }
    prior.updatedAt = now;
    prior.orgUrl = this.opts.orgUrl;
    await fs.writeFile(this.manifestPath, JSON.stringify(prior, null, 2));
  }
}

export function stripUserInfo(url: string): string {
  return url.replace(/^(https?:\/\/)[^@/]+@/i, '$1');
}

async function isGitDir(p: string): Promise<boolean> {
  try {
    await fs.access(path.join(p, 'HEAD'));
    return true;
  } catch {
    return false;
  }
}

export interface CoverageReport {
  generatedAt: string;
  totals: Record<'discovered' | 'cloned' | 'fetched' | 'empty' | 'disabled' | 'failed', number>;
  covered: number;
  coveragePct: number;
  notCovered: Array<{ project: string; name: string; status: string; reason?: string }>;
  repos: Array<{
    project: string; name: string; status: string; isFork: boolean;
    sizeMB: number; commits?: number; pullRequests?: number; warnings: string[]; error?: string;
  }>;
}

export function buildCoverageReport(
  results: RepoSyncResult[],
  prCounts: Record<string, number> = {}
): CoverageReport {
  const totals = { discovered: results.length, cloned: 0, fetched: 0, empty: 0, disabled: 0, failed: 0 };
  for (const r of results) totals[r.status]++;
  // Empty repos are covered: there is nothing to miss.
  const covered = totals.cloned + totals.fetched + totals.empty;
  return {
    generatedAt: new Date().toISOString(),
    totals,
    covered,
    coveragePct: results.length ? Math.round((covered / results.length) * 1000) / 10 : 100,
    notCovered: results
      .filter((r) => r.status === 'disabled' || r.status === 'failed')
      .map((r) => ({ project: r.repo.project, name: r.repo.name, status: r.status, reason: r.error })),
    repos: results.map((r) => ({
      project: r.repo.project,
      name: r.repo.name,
      status: r.status,
      isFork: r.repo.isFork,
      sizeMB: Math.round(r.repo.sizeBytes / 1024 / 1024),
      commits: r.headCommits,
      pullRequests: prCounts[r.repo.id],
      warnings: r.warnings,
      error: r.error,
    })),
  };
}

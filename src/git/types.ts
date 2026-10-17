// Shared types for the git-based contribution analytics.

export interface RepoInfo {
  id: string;
  name: string;
  project: string;
  remoteUrl: string;
  defaultBranch?: string;
  sizeBytes: number;
  isDisabled: boolean;
  isFork: boolean;
  parentRepoId?: string;
}

export type RepoSyncStatus =
  | 'cloned'
  | 'fetched'
  | 'empty'
  | 'disabled'
  | 'failed';

export interface RepoSyncResult {
  repo: RepoInfo;
  status: RepoSyncStatus;
  localPath?: string;
  error?: string;
  durationMs: number;
  headCommits?: number;
  warnings: string[];
}

export interface ManifestEntry {
  repoId: string;
  name: string;
  project: string;
  localPath: string;
  lastSyncAt: string;
  lastStatus: RepoSyncStatus;
  lastError?: string;
}

export interface Manifest {
  orgUrl: string;
  updatedAt: string;
  repos: Record<string, ManifestEntry>;
}

export interface FileChange {
  path: string;
  added: number;    // 0 for binary
  deleted: number;  // 0 for binary
  binary: boolean;
}

export interface CommitRecord {
  sha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorDate: string;   // ISO with the author's own offset
  committerName: string;
  committerEmail: string;
  committerDate: string;
  subject: string;
  files: FileChange[];
  repoId: string;
}

export interface PullRequestRecord {
  id: number;
  repoId: string;
  project: string;
  title: string;
  status: 'active' | 'completed' | 'abandoned' | 'unknown';
  createdBy: { id: string; uniqueName: string; displayName: string };
  creationDate: string;
  closedDate?: string;
  mergeCommitId?: string;        // completion commit on the target branch
  sourceRef?: string;
  targetRef?: string;
  isDraft: boolean;
  reviewers: Array<{ id: string; uniqueName: string; displayName: string; vote: number; isContainer: boolean }>;
  // Derived from threads
  firstReviewActivityAt?: string;    // first non-author, non-system comment
  commentsFromOthers: number;
  commentsByReviewer: Record<string, number>; // uniqueName -> count
  iterationCount?: number;
  threadsFetchedAt?: string;
}

export interface IdentityRule {
  canonical: string;          // usually the primary email
  displayName?: string;
  aliases: string[];          // other emails, ADO uniqueNames, names
}

export interface AnalysisWindow {
  since: Date;
  until: Date;
}

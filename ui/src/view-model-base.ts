import { translateEnglish, type Translate } from "./i18n";

export type JsonRecord = Record<string, unknown>;

export type ConnectionState =
  | "unconfigured"
  | "checking"
  | "connected"
  | "auth_required"
  | "unavailable";

/** Host RepositoryProviderRegistration contract. Never return plugin snake_case here. */
export type RepositoryInspection = {
  providerId: string;
  providerHost: string;
  providerScope?: string;
  ownerOrProject: string;
  repositoryId: string;
  repositoryName: string;
  cloneUrl: string;
  defaultBranch?: string;
  baseBranch?: string;
  headBranch?: string;
  pullRequest?: { number: number; title: string };
};

/** Internal UI alias for the host repository descriptor. */
export type Repository = RepositoryInspection;

export type PullRequest = {
  key: string;
  id: string;
  number: number;
  title: string;
  url: string;
  repositoryId: string;
  providerScope?: string;
  repositoryName: string;
  state: string;
  author?: string;
  authorUrl?: string;
  authorAvatarUrl?: string;
  createdAt?: string;
  updatedAt?: string;
  mergedAt?: string;
  closedAt?: string;
  sourceBranch?: string;
  destinationBranch?: string;
  headCommit?: string;
  statusLabel?: string;
  statusTone?: "success" | "warning" | "danger" | "neutral";
  tasks: TaskRowLink[];
  capabilities: string[];
};

export type TaskRowLink = {
  id: string;
  taskId: string;
  fallbackTitle: string;
  repositoryId?: string;
  connectionScope?: string;
  changeRequestNumber?: number;
};

export function pullRequestAssociationIdentity(
  connectionScope: string | undefined,
  repositoryId: string | undefined,
  number: number | undefined,
): string | undefined {
  return connectionScope && repositoryId && number && number > 0
    ? `connection:${connectionScope}\u0000repository:${repositoryId}\u0000pull-request:${number}`
    : undefined;
}

export type SavedQuery = {
  id: string;
  label: string;
  query: string;
  repositoryId: string;
  state: string;
  createdAt: string;
};

export type ReviewFile = {
  path: string;
  status: string;
  additions?: number;
  deletions?: number;
  patch?: string;
};

export type ReviewThread = {
  id: string;
  author: string;
  body: string;
  createdAt?: string;
  resolved: boolean;
  file?: string;
  comments: ReviewComment[];
};

export type ReviewComment = {
  id: string;
  parentId?: string;
  author: string;
  body: string;
  createdAt?: string;
  line?: number;
};

export type BuildStatus = {
  key: string;
  name: string;
  state: string;
  url?: string;
  target?: string;
  output?: string;
  startedAt?: string;
  completedAt?: string;
};

export type ReviewDetail = PullRequest & {
  description?: string;
  sourceBranch?: string;
  destinationBranch?: string;
  files: ReviewFile[];
  commits: Array<{ id: string; message: string; author?: string }>;
  participants: Array<{
    id?: string;
    name: string;
    role?: string;
    approved?: boolean;
    verdict?: "approved" | "changes_requested" | "pending";
    isCurrentUser?: boolean;
    url?: string;
    avatarUrl?: string;
  }>;
  threads: ReviewThread[];
  statuses: BuildStatus[];
  viewerApproved?: boolean;
  unresolvedThreadCount?: number;
};

export type HostChangeRequestDetail = {
  providerId: "bitbucket";
  reviewKey: string;
  number: number;
  title: string;
  url: string;
  state: string;
  draft?: boolean;
  author: { name: string; url?: string; avatarUrl?: string };
  createdAt?: string;
  mergedAt?: string;
  closedAt?: string;
  sourceBranch: string;
  targetBranch: string;
  additions: number;
  deletions: number;
  description?: string;
  reviewState?: string;
  pendingReviewCount?: number;
  reviews: Array<{
    id: string;
    author: { name: string };
    state: string;
    body?: string;
    createdAt?: string;
  }>;
  requestedReviewers: Array<{ name: string }>;
  checks: Array<{
    id: string;
    name: string;
    state: string;
    conclusion?: string;
    url?: string;
    output?: string;
    startedAt?: string;
    completedAt?: string;
  }>;
  comments: Array<{
    id: string;
    parentId?: string;
    author: { name: string };
    body: string;
    createdAt?: string;
    path?: string;
    line?: number;
    resolved?: boolean;
  }>;
  lastSyncedAt?: string;
};

export type HostChangeRequestDetailAction = {
  id: string;
  label: string;
  pendingLabel?: string;
  placement: "header" | "comment" | "thread";
  tone?: "default" | "success" | "danger" | "secondary";
  input?: "text";
};

export type ConnectionFormInput = {
  product: string;
  baseUrl: string;
  cloudWorkspace: string;
  authMethod: string;
  token: string;
  identity: string;
  oauthRegistrationConfigured: boolean;
  oauthClientId: string;
  oauthClientSecret: string;
  oauthCallbackUrl: string;
};

export type ConnectionIdentity = {
  field: "auth_identity";
  label: string;
  help: string;
  inputType: "email" | "text";
};

export type OAuthRegistration = {
  configured: boolean;
};

export type PullRequestCreateForm = {
  title: string;
  description: string;
  destination: string;
  closeSourceOnMerge: boolean;
};

export type TaskLaunchPreset = {
  id: "review" | "address-feedback" | "fix-ci";
  label: string;
  hint: string;
  iconName: "eye" | "message" | "tool";
  prompt(pullRequest: PullRequest): string;
};
export type WatchSummary = {
  id: string;
  status: "running" | "paused";
  lastPolled?: string;
};

export function integrationSettingsHref(workspaceId?: string): string {
  return workspaceId
    ? `/settings/workspaces/${encodeURIComponent(workspaceId)}/integrations/bitbucket`
    : "/settings/integrations/bitbucket";
}

export function displayPullRequestAuthor(author?: string): string | undefined {
  const value = author?.trim();
  if (!value || /^\d+:[a-z0-9-]{20,}$/i.test(value)) return undefined;
  return value;
}

export function oauthStartInput(workspaceId: string): { workspaceId: string } {
  return { workspaceId };
}

/** Disconnect is workspace-scoped and deliberately carries no credential body. */
export function disconnectConnectionInput(workspaceId: string): {
  workspaceId: string;
} {
  return { workspaceId };
}

export function deriveOAuthCallbackURL(
  apiBaseUrl: string,
  browserOrigin: string,
): string {
  const backendOrigin = apiBaseUrl.trim() || browserOrigin;
  return new URL(
    "/api/plugins/kandev-plugin-bitbucket/webhooks/oauth-callback",
    backendOrigin,
  ).toString();
}

export function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

export function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function number(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    typeof value === "string" &&
    value.trim() &&
    Number.isFinite(Number(value))
  )
    return Number(value);
  return undefined;
}

export function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function timestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.getUTCFullYear() > 1
      ? date.toISOString()
      : undefined;
  }
  const text = string(value);
  if (!text) return undefined;
  if (/^\d+$/.test(text)) {
    const date = new Date(Number(text));
    return Number.isFinite(date.getTime()) && date.getUTCFullYear() > 1
      ? date.toISOString()
      : undefined;
  }
  const date = new Date(text);
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() > 1
    ? text
    : undefined;
}

export function boolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function linkHref(value: unknown): string | undefined {
  const direct = string(value);
  if (direct) return direct;
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const href = linkHref(candidate);
      if (href) return href;
    }
    return undefined;
  }
  const link = record(value);
  return string(link.href) ?? string(link.url);
}

export function pullRequestURL(value: unknown): string | undefined {
  const links = record(value);
  return linkHref(links.html) ?? linkHref(links.self) ?? linkHref(value);
}

export function personLink(
  value: unknown,
  kind: "html" | "avatar",
): string | undefined {
  const person = record(value);
  return (
    linkHref(record(person.links)[kind]) ??
    linkHref(person[kind === "html" ? "url" : "avatarUrl"])
  );
}

export function itemList(value: unknown, keys: string[]): unknown[] {
  if (Array.isArray(value)) return value;
  const source = record(value);
  for (const key of keys) {
    if (Array.isArray(source[key])) return source[key] as unknown[];
  }
  return [];
}

export function toCapabilities(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((capability) => capability.trim())
      .filter(Boolean);
  }
  return array(value).flatMap((entry) =>
    typeof entry === "string" ? [entry] : [],
  );
}

export function normalizeTaskLinks(
  value: unknown,
  reviewKey = "",
  t: Translate = translateEnglish,
): TaskRowLink[] {
  return itemList(value, ["associations", "tasks", "items", "values"]).flatMap(
    (entry) => {
      const source = record(entry);
      const taskId = string(source.task_id) ?? string(source.taskId);
      const entryReviewKey =
        string(source.review_key) ?? string(source.reviewKey) ?? reviewKey;
      if (!taskId || (reviewKey && entryReviewKey !== reviewKey)) return [];
      return [
        {
          id: string(source.id) ?? `${entryReviewKey}:${taskId}`,
          taskId,
          fallbackTitle:
            string(source.task_title) ??
            string(source.taskTitle) ??
            string(source.title) ??
            t("bitbucketTask"),
        },
      ];
    },
  );
}

export function normalizePullRequestAssociations(
  value: unknown,
  t: Translate = translateEnglish,
): Record<string, TaskRowLink[]> {
  const result: Record<string, TaskRowLink[]> = {};
  for (const entry of itemList(value, ["associations", "items", "values"])) {
    const source = record(entry);
    const reviewKey = string(source.review_key) ?? string(source.reviewKey);
    if (!reviewKey) continue;
    const links = normalizeTaskLinks([source], reviewKey, t);
    const repositoryId =
      string(source.repository_id) ?? string(source.repositoryId);
    const connectionScope =
      string(source.provider_scope) ?? string(source.connectionScope);
    const changeRequestNumber =
      number(source.number) ?? number(source.changeRequestNumber);
    for (const link of links) {
      link.repositoryId = repositoryId;
      link.connectionScope = connectionScope;
      link.changeRequestNumber = changeRequestNumber;
    }
    if (links.length) {
      result[reviewKey] = [...(result[reviewKey] ?? []), ...links];
      const identity = pullRequestAssociationIdentity(
        connectionScope,
        repositoryId,
        changeRequestNumber,
      );
      if (identity) result[identity] = [...(result[identity] ?? []), ...links];
    }
  }
  return result;
}

export function normalizeReviewComment(
  value: unknown,
  t: Translate = translateEnglish,
): ReviewComment | null {
  const comment = record(value);
  const id =
    string(comment.id) ?? string(comment.ID) ?? string(comment.comment_id);
  if (!id) return null;
  const normalized: ReviewComment = {
    id,
    author:
      string(comment.author) ??
      string(comment.Author) ??
      string(record(comment.author).display_name) ??
      string(record(comment.author).displayName) ??
      t("unknown"),
    body:
      string(comment.body) ??
      string(comment.Body) ??
      string(comment.content) ??
      string(record(comment.content).raw) ??
      string(comment.text) ??
      "",
  };
  const parentId =
    string(comment.parent_id) ??
    string(comment.parentId) ??
    string(comment.ParentID);
  const createdAt =
    timestamp(comment.created_at) ??
    timestamp(comment.createdAt) ??
    timestamp(comment.When);
  const line =
    number(comment.line) ??
    number(record(comment.inline).to) ??
    number(record(comment.anchor).line);
  if (parentId) normalized.parentId = parentId;
  if (createdAt) normalized.createdAt = createdAt;
  if (line) normalized.line = line;
  return normalized;
}

export function statusTone(state: string): PullRequest["statusTone"] {
  const normalized = state.toLowerCase();
  if (/(success|passed|approved|merged|open)/.test(normalized))
    return "success";
  if (/(fail|declined|error|blocked)/.test(normalized)) return "danger";
  if (/(pending|build|review|draft)/.test(normalized)) return "warning";
  return "neutral";
}

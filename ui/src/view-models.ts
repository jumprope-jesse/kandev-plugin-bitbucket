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
};

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
    isCurrentUser?: boolean;
    url?: string;
    avatarUrl?: string;
  }>;
  threads: ReviewThread[];
  statuses: BuildStatus[];
  viewerApproved?: boolean;
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
export type WatchSummary = { id: string; status: "running" | "paused"; lastPolled?: string };

export function integrationSettingsHref(workspaceId?: string): string {
  return workspaceId
    ? `/settings/workspace/${encodeURIComponent(workspaceId)}/integrations/bitbucket`
    : "/settings/integrations/bitbucket";
}

export function displayPullRequestAuthor(author?: string): string | undefined {
  const value = author?.trim();
  if (!value || /^\d+:[a-z0-9-]{20,}$/i.test(value)) return undefined;
  return value;
}

export function relativeTimeLabel(value?: string, now = new Date()): string | undefined {
  if (!value) return undefined;
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return undefined;
  const seconds = Math.floor((now.getTime() - instant.getTime()) / 1000);
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  return instant.toLocaleDateString();
}

export function oauthStartInput(workspaceId: string): { workspaceId: string } {
  return { workspaceId };
}

/** Disconnect is workspace-scoped and deliberately carries no credential body. */
export function disconnectConnectionInput(workspaceId: string): { workspaceId: string } {
  return { workspaceId };
}

export function deriveOAuthCallbackURL(origin: string): string {
  return new URL("/api/plugins/kandev-plugin-bitbucket/webhooks/oauth-callback", origin).toString();
}

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Reads Kandev's active workspace from the public host store shape. */
export function activeWorkspaceIdFromState(state: unknown): string | undefined {
  return string(record(record(state).workspaces).activeId);
}

function number(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function timestamp(value: unknown): string | undefined {
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
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() > 1 ? text : undefined;
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function linkHref(value: unknown): string | undefined {
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

function pullRequestURL(value: unknown): string | undefined {
  const links = record(value);
  return linkHref(links.html) ?? linkHref(links.self) ?? linkHref(value);
}

function personLink(value: unknown, kind: "html" | "avatar"): string | undefined {
  const person = record(value);
  return linkHref(record(person.links)[kind]) ?? linkHref(person[kind === "html" ? "url" : "avatarUrl"]);
}

function itemList(value: unknown, keys: string[]): unknown[] {
  if (Array.isArray(value)) return value;
  const source = record(value);
  for (const key of keys) {
    if (Array.isArray(source[key])) return source[key] as unknown[];
  }
  return [];
}

function toCapabilities(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((capability) => capability.trim())
      .filter(Boolean);
  }
  return array(value).flatMap((entry) => (typeof entry === "string" ? [entry] : []));
}

function normalizeTaskLinks(value: unknown, reviewKey = ""): TaskRowLink[] {
  return itemList(value, ["associations", "tasks", "items", "values"]).flatMap((entry) => {
    const source = record(entry);
    const taskId = string(source.task_id) ?? string(source.taskId);
    const entryReviewKey = string(source.review_key) ?? string(source.reviewKey) ?? reviewKey;
    if (!taskId || (reviewKey && entryReviewKey !== reviewKey)) return [];
    return [{
      id: string(source.id) ?? `${entryReviewKey}:${taskId}`,
      taskId,
      fallbackTitle: string(source.task_title) ?? string(source.taskTitle) ?? string(source.title) ?? "Bitbucket task",
    }];
  });
}

export function normalizePullRequestAssociations(value: unknown): Record<string, TaskRowLink[]> {
  const result: Record<string, TaskRowLink[]> = {};
  for (const entry of itemList(value, ["associations", "items", "values"])) {
    const source = record(entry);
    const reviewKey = string(source.review_key) ?? string(source.reviewKey);
    if (!reviewKey) continue;
    const links = normalizeTaskLinks([source], reviewKey);
    if (links.length) result[reviewKey] = [...(result[reviewKey] ?? []), ...links];
  }
  return result;
}

function normalizeReviewComment(value: unknown): ReviewComment | null {
  const comment = record(value);
  const id = string(comment.id) ?? string(comment.ID) ?? string(comment.comment_id);
  if (!id) return null;
  const normalized: ReviewComment = {
    id,
    author:
      string(comment.author) ??
      string(comment.Author) ??
      string(record(comment.author).display_name) ??
      string(record(comment.author).displayName) ??
      "Unknown",
    body:
      string(comment.body) ??
      string(comment.Body) ??
      string(comment.content) ??
      string(record(comment.content).raw) ??
      string(comment.text) ??
      "",
  };
  const parentId = string(comment.parent_id) ?? string(comment.parentId) ?? string(comment.ParentID);
  const createdAt = timestamp(comment.created_at) ?? timestamp(comment.createdAt) ?? timestamp(comment.When);
  const line = number(comment.line) ?? number(record(comment.inline).to) ?? number(record(comment.anchor).line);
  if (parentId) normalized.parentId = parentId;
  if (createdAt) normalized.createdAt = createdAt;
  if (line) normalized.line = line;
  return normalized;
}

export function statusTone(state: string): PullRequest["statusTone"] {
  const normalized = state.toLowerCase();
  if (/(success|passed|approved|merged|open)/.test(normalized)) return "success";
  if (/(fail|declined|error|blocked)/.test(normalized)) return "danger";
  if (/(pending|build|review|draft)/.test(normalized)) return "warning";
  return "neutral";
}

function normalizeRepository(value: unknown): Repository | null {
  const source = record(value);
  const repositoryId = string(source.provider_repository_id) ?? string(source.repositoryId) ?? string(source.provider_repo_id) ?? string(source.id) ?? string(source.uuid) ?? string(source.slug);
  const repositoryName = string(source.repository_name) ?? string(source.repositoryName) ?? string(source.provider_name) ?? string(source.name) ?? string(source.slug) ?? repositoryId;
  if (!repositoryId || !repositoryName) return null;
  const repository: Repository = {
    providerId: string(source.provider_id) ?? string(source.providerId) ?? string(source.provider) ?? "bitbucket",
    providerHost: string(source.provider_host) ?? string(source.providerHost) ?? string(source.host) ?? "",
    ownerOrProject:
      string(source.owner_or_project) ?? string(source.ownerOrProject) ?? string(source.provider_owner) ?? string(source.project) ?? string(record(source.owner).username) ?? "",
    repositoryId,
    repositoryName,
    cloneUrl: string(source.clone_url) ?? string(source.cloneUrl) ?? string(source.remote_url) ?? string(source.url) ?? "",
  };
  const defaultBranch = string(source.default_branch) ?? string(source.defaultBranch);
  const baseBranch = string(source.base_branch) ?? string(source.baseBranch);
  const headBranch = string(source.head_branch) ?? string(source.headBranch) ?? string(source.checkout_branch);
  if (defaultBranch) repository.defaultBranch = defaultBranch;
  if (baseBranch) repository.baseBranch = baseBranch;
  if (headBranch) repository.headBranch = headBranch;
  return repository;
}

export function normalizeRepositories(value: unknown): Repository[] {
  return itemList(value, ["repositories", "items", "values"])
    .flatMap((item): Repository[] => {
      const repository = normalizeRepository(item);
      return repository ? [repository] : [];
    });
}

export function normalizeRepositoryInspection(value: unknown): RepositoryInspection | null {
  const source = record(value);
  const repository = normalizeRepository(
    Object.keys(record(source.repository)).length ? source.repository : source,
  );
  if (!repository) return null;
  const baseBranch = string(source.base_branch) ?? string(source.baseBranch);
  const headBranch = string(source.head_branch) ?? string(source.headBranch);
  const pullRequest = record(source.pull_request ?? source.pullRequest);
  const pullRequestNumber = number(pullRequest.number);
  const pullRequestTitle = string(pullRequest.title);
  if (baseBranch) repository.baseBranch = baseBranch;
  if (headBranch) repository.headBranch = headBranch;
  if (pullRequestNumber && pullRequestTitle) {
    repository.pullRequest = { number: pullRequestNumber, title: pullRequestTitle };
  }
  return repository;
}

export function taskRepositoryDescriptor(taskRepositories: readonly unknown[], workspaceRepositories: unknown): Repository | null {
  const taskRepository = record(taskRepositories[0]);
  const hostRepositoryID = string(taskRepository.repository_id) ?? string(taskRepository.repositoryId);
  const configuredRepositories = Array.isArray(workspaceRepositories)
    ? workspaceRepositories
    : itemList(workspaceRepositories, ["repositories", "items", "values"]);
  const configuredRepository = configuredRepositories.find((candidate) => string(record(candidate).id) === hostRepositoryID);
  const repository = normalizeRepository(configuredRepository ?? taskRepository);
  if (!repository || (!configuredRepository && !string(taskRepository.provider_id) && !string(taskRepository.providerId))) return null;
  const baseBranch = string(taskRepository.base_branch) ?? string(taskRepository.baseBranch);
  const headBranch = string(taskRepository.checkout_branch) ?? string(taskRepository.headBranch);
  if (baseBranch) repository.baseBranch = baseBranch;
  if (headBranch) repository.headBranch = headBranch;
  return repository;
}

export function taskSupportsBitbucketRepository(taskRepositories: readonly unknown[]): boolean {
  const providers = taskRepositories
    .map((repository) => {
      const source = record(repository);
      return string(source.provider_id) ?? string(source.providerId) ?? string(source.provider);
    })
    .flatMap((provider) => (provider ? [provider.toLowerCase()] : []));
  return providers.length === 0 || providers.includes("bitbucket");
}

export function pullRequestCreateBody(input: PullRequestCreateForm): JsonRecord {
  const body: JsonRecord = {};
  const title = input.title.trim();
  const description = input.description.trim();
  const destination = input.destination.trim();
  if (title) body.title = title;
  if (description) body.description = description;
  if (destination) body.destination = destination;
  if (input.closeSourceOnMerge) body.close_source_on_merge = true;
  return body;
}

export function workspacePullRequestAction(workspaceId: string, reviewKey: string, pullRequestID: string, operation?: string): { workspaceId: string; body: JsonRecord } {
  const body: JsonRecord = { review_key: reviewKey, pull_request_id: pullRequestID };
  if (operation) body.operation = operation;
  return { workspaceId, body };
}

export function workspaceReviewAction(
  workspaceId: string,
  reviewKey: string,
  pullRequestID: string,
  kind: string,
  options: { comment?: string; parentCommentId?: string; buildKey?: string } = {},
): { workspaceId: string; body: JsonRecord } {
  const body: JsonRecord = { review_key: reviewKey, pull_request_id: pullRequestID, kind };
  const comment = options.comment?.trim();
  if (comment) body.comment = comment;
  if (options.parentCommentId) body.parent_comment_id = options.parentCommentId;
  if (options.buildKey) body.build_key = options.buildKey;
  return { workspaceId, body };
}

export function linkPullRequestBody(reference: string): JsonRecord | null {
  const key = reference.trim();
  if (/^[^/#\s]+\/[^/#\s]+#[1-9]\d*$/.test(key)) return { review_key: key };
  let url: URL;
  try {
    url = new URL(key);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const cloud = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)(?:\/|$)/i);
  if (cloud) return { review_key: `${cloud[1]}/${cloud[2]}#${cloud[3]}` };
  const dataCenter = url.pathname.match(/(?:^|\/)projects\/([^/]+)\/repos\/([^/]+)\/pull-requests\/(\d+)(?:\/|$)/i);
  return dataCenter ? { review_key: `${dataCenter[1]}/${dataCenter[2]}#${dataCenter[3]}` } : null;
}

export function pluginRepositoryInput(value: unknown): JsonRecord {
  const repository = normalizeRepository(value);
  if (!repository) return {};
  const body: JsonRecord = {
    provider_id: repository.providerId,
    provider_host: repository.providerHost,
    owner_or_project: repository.ownerOrProject,
    provider_repository_id: repository.repositoryId,
    name: repository.repositoryName,
    clone_url: repository.cloneUrl,
  };
  if (repository.defaultBranch) body.default_branch = repository.defaultBranch;
  if (repository.baseBranch) body.base_branch = repository.baseBranch;
  if (repository.headBranch) body.head_branch = repository.headBranch;
  return body;
}

export function pullRequestListRequest(
  repository: RepositoryInspection | null,
  query: string,
  state: string,
): { actionKey: "pullrequests.search" | "pullrequests.queue"; body: JsonRecord } {
  const parsed = parsePullRequestListQuery(query, state);
  if (repository) {
    return {
      actionKey: "pullrequests.search",
      body: { repository: pluginRepositoryInput(repository), query: parsed.query, state: parsed.state },
    };
  }
  return { actionKey: "pullrequests.queue", body: { view: "queue", query: parsed.query, state: parsed.state } };
}

const PULL_REQUEST_STATES = new Set(["open", "all", "merged", "declined"]);
const PULL_REQUEST_STATE_TOKEN = /(^|\s)state:(open|all|merged|declined)(?=\s|$)/gi;

function normalizedPullRequestState(value: string): string {
  const state = value.trim().toLowerCase();
  return PULL_REQUEST_STATES.has(state) ? state : "open";
}

export function pullRequestScopeQuery(state: string): string {
  return `state:${normalizedPullRequestState(state)}`;
}

export function parsePullRequestListQuery(
  query: string,
  fallbackState: string,
): { query: string; state: string } {
  let state = normalizedPullRequestState(fallbackState);
  const textQuery = query.replace(
    PULL_REQUEST_STATE_TOKEN,
    (_match, prefix: string, value: string) => {
      state = normalizedPullRequestState(value);
      return prefix;
    },
  );
  return { query: textQuery.trim().replace(/\s+/g, " "), state };
}

const MAX_SAVED_QUERIES = 50;

export function normalizeSavedQueries(value: unknown): SavedQuery[] {
  return array(value)
    .flatMap((entry): SavedQuery[] => {
      const source = record(entry);
      const id = string(source.id);
      const label = string(source.label);
      const query = typeof source.query === "string" ? source.query.trim() : undefined;
      const repositoryId =
        typeof source.repositoryId === "string" ? source.repositoryId.trim() : undefined;
      const state = string(source.state);
      const createdAt = string(source.createdAt);
      if (
        !id ||
        !label ||
        query === undefined ||
        repositoryId === undefined ||
        !state ||
        !PULL_REQUEST_STATES.has(state.toLowerCase()) ||
        !createdAt
      ) {
        return [];
      }
      return [{ id, label, query, repositoryId, state: state.toLowerCase(), createdAt }];
    })
    .slice(-MAX_SAVED_QUERIES);
}

export function canSaveDashboardQuery(query: string, repositoryId: string): boolean {
  return Boolean(query.trim() || repositoryId.trim());
}

export function newSavedQuery(
  input: Pick<SavedQuery, "label" | "query" | "repositoryId" | "state">,
  id: string,
  createdAt: string,
): SavedQuery {
  return {
    id,
    label: input.label.trim(),
    query: input.query.trim(),
    repositoryId: input.repositoryId.trim(),
    state: normalizedPullRequestState(input.state),
    createdAt,
  };
}

export function normalizePullRequests(value: unknown): PullRequest[] {
  return itemList(value, ["pull_requests", "pullRequests", "items", "values"])
    .map((item) => {
      const source = record(item);
      const id =
        string(source.id) ??
        string(source.key) ??
        string(source.uuid) ??
        String(number(source.number) ?? number(source.id) ?? "");
      const repository = record(source.repository);
      const repositorySlug = string(repository.slug) ?? string(repository.name);
      const repositoryNamespace =
        string(record(repository.project).key) ??
        string(record(repository.owner).username) ??
        string(record(repository.workspace).slug);
      const repositoryId =
        string(source.repository_id) ??
        string(source.repositoryId) ??
        string(repository.full_name) ??
        (repositoryNamespace && repositorySlug ? `${repositoryNamespace}/${repositorySlug}` : undefined) ??
        string(repository.id) ??
        "";
      const numberValue = number(source.number) ?? number(source.id) ?? 0;
      const title = string(source.title) ?? `Pull request ${numberValue || id}`;
      if (!id || !repositoryId || !numberValue) return null;
      const status = record(source.status);
      const state = string(source.state) ?? string(source.status) ?? "UNKNOWN";
      const reviewKey = string(source.review_key) ?? string(source.reviewKey) ?? `${repositoryId}:${id}`;
      const author = record(source.author);
      const sourceRef = record(source.source);
      const destinationRef = record(source.destination);
      const fromRef = record(source.fromRef);
      const toRef = record(source.toRef);
      return {
        key: reviewKey,
        id,
        number: numberValue,
        title,
        url: string(source.url) ?? pullRequestURL(source.links) ?? "",
        repositoryId,
        repositoryName: string(source.repository_name) ?? string(source.repositoryName) ?? string(repository.name) ?? repositoryId,
        state,
        author:
          string(source.author_display_name) ??
          string(source.authorDisplayName) ??
          string(author.display_name) ??
          string(author.displayName) ??
          string(author.name) ??
          string(source.author),
        authorUrl: string(source.author_url) ?? string(source.authorUrl) ?? personLink(author, "html"),
        authorAvatarUrl:
          string(source.author_avatar_url) ??
          string(source.authorAvatarUrl) ??
          personLink(author, "avatar"),
        createdAt:
          timestamp(source.created_at) ??
          timestamp(source.createdAt) ??
          timestamp(source.created_on) ??
          timestamp(source.createdDate),
        updatedAt:
          timestamp(source.updated_at) ??
          timestamp(source.updatedAt) ??
          timestamp(source.updated_on) ??
          timestamp(source.updatedDate),
        mergedAt: timestamp(source.merged_at) ?? timestamp(source.mergedAt),
        closedAt: timestamp(source.closed_at) ?? timestamp(source.closedAt),
        sourceBranch:
          string(source.source_branch) ??
          string(source.sourceBranch) ??
          string(record(sourceRef.branch).name) ??
          string(sourceRef.branch) ??
          string(fromRef.displayId) ??
          string(fromRef.id)?.replace(/^refs\/heads\//, ""),
        destinationBranch:
          string(source.destination_branch) ??
          string(source.destinationBranch) ??
          string(record(destinationRef.branch).name) ??
          string(destinationRef.branch) ??
          string(toRef.displayId) ??
          string(toRef.id)?.replace(/^refs\/heads\//, ""),
        headCommit:
          string(source.head_commit) ??
          string(source.headCommit) ??
          string(record(sourceRef.commit).hash) ??
          string(fromRef.latestCommit),
        statusLabel: string(status.label) ?? string(source.status_label) ?? string(source.statusLabel),
        statusTone: statusTone(string(status.state) ?? state),
        tasks: normalizeTaskLinks(source.associations ?? source.tasks, reviewKey),
        capabilities: toCapabilities(source.capabilities),
      };
    })
    .flatMap((item): PullRequest[] => (item ? [item] : []));
}

function isCurrentUserParticipant(participant: JsonRecord): boolean {
  const user = record(participant.user);
  return participant.is_current_user === true ||
    participant.isCurrentUser === true ||
    participant.currentUser === true ||
    user.is_current_user === true ||
    user.isCurrentUser === true;
}

function normalizeViewerApproval(source: JsonRecord, participants: unknown[]): boolean | undefined {
  const direct =
    boolean(source.viewer_approved) ??
    boolean(source.viewerApproved) ??
    boolean(source.current_user_approved) ??
    boolean(source.currentUserApproved);
  if (direct !== undefined) return direct;
  const viewer = participants.map(record).find(isCurrentUserParticipant);
  if (!viewer) return undefined;
  return boolean(viewer.approved) ?? (string(viewer.status)?.toUpperCase() === "APPROVED");
}

export function normalizeReviewDetail(value: unknown): ReviewDetail | null {
  const source = record(value);
  const pr = normalizePullRequests({ pull_requests: [source] })[0];
  if (!pr) return null;
  const participantItems = itemList(source.participants ?? source.reviewers, ["items", "values"]);
  return {
    ...pr,
    description: string(source.description) ?? string(record(source.description).raw),
    sourceBranch: pr.sourceBranch,
    destinationBranch: pr.destinationBranch,
    files: itemList(source.files, ["items", "values"]).flatMap((entry) => {
      const file = record(entry);
      const path = string(file.path) ?? string(file.name);
      return path
        ? [{ path, status: string(file.status) ?? "modified", additions: number(file.additions), deletions: number(file.deletions), patch: string(file.patch) }]
        : [];
    }),
    commits: itemList(source.commits, ["items", "values"]).flatMap((entry) => {
      const commit = record(entry);
      const id = string(commit.id) ?? string(commit.hash);
      return id ? [{ id, message: string(commit.message) ?? id, author: string(commit.author) ?? string(record(commit.author).name) }] : [];
    }),
    participants: participantItems.flatMap((entry) => {
      const participant = record(entry);
      const user = record(participant.user);
      const name =
        string(participant.name) ??
        string(participant.display_name) ??
        string(participant.displayName) ??
        string(user.display_name) ??
        string(user.displayName) ??
        string(user.name);
      const approved =
        boolean(participant.approved) ??
        (string(participant.status)?.toUpperCase() === "APPROVED");
      const isCurrentUser =
        boolean(participant.is_current_user) ??
        boolean(participant.isCurrentUser) ??
        boolean(participant.currentUser) ??
        boolean(user.is_current_user) ??
        boolean(user.isCurrentUser);
      return name
        ? [{
            id: string(participant.id) ?? string(user.account_id) ?? string(user.slug),
            name,
            role: string(participant.role),
            approved,
            isCurrentUser,
            url: personLink(user, "html"),
            avatarUrl: personLink(user, "avatar"),
          }]
        : [];
    }),
    threads: itemList(source.threads, ["items", "values"]).flatMap((entry) => {
      const thread = record(entry);
      const id = string(thread.id) ?? string(thread.comment_id);
      if (!id) return [];
      const comments = itemList(thread.comments, ["items", "values"])
        .flatMap((comment): ReviewComment[] => {
          const normalized = normalizeReviewComment(comment);
          return normalized ? [normalized] : [];
        });
      const rootComment = comments[0];
      return [{
        id,
        author: rootComment?.author ?? string(thread.author) ?? string(record(thread.author).display_name) ?? "Unknown",
        body: rootComment?.body ?? string(thread.body) ?? string(thread.content) ?? "",
        createdAt: rootComment?.createdAt ?? timestamp(thread.created_at) ?? timestamp(thread.createdAt),
        resolved: thread.resolved === true,
        file: string(thread.file) ?? string(thread.path),
        comments: comments.length > 0 ? comments : [{ id, author: string(thread.author) ?? string(record(thread.author).display_name) ?? "Unknown", body: string(thread.body) ?? string(thread.content) ?? "" }],
      }];
    }),
    statuses: itemList(source.statuses ?? source.builds, ["items", "values"]).flatMap((entry) => {
      const status = record(entry);
      const key = string(status.key) ?? string(status.id);
      const name = string(status.name) ?? key;
      const state = string(status.state);
      const url = string(status.url) ?? pullRequestURL(status.links);
      const target = string(status.target) ?? string(status.refname);
      const output = string(status.output) ?? string(status.description);
      const startedAt =
        timestamp(status.started_at) ??
        timestamp(status.startedAt) ??
        timestamp(status.created_on) ??
        timestamp(status.createdDate);
      const completedAt =
        timestamp(status.completed_at) ??
        timestamp(status.completedAt) ??
        timestamp(status.updated_on) ??
        timestamp(status.updatedDate);
      return key && name && state
        ? [{
            key,
            name,
            state,
            ...(url ? { url } : {}),
            ...(target ? { target } : {}),
            ...(output ? { output } : {}),
            ...(startedAt ? { startedAt } : {}),
            ...(completedAt ? { completedAt } : {}),
          }]
        : [];
    }),
    viewerApproved: normalizeViewerApproval(source, participantItems),
  };
}

function hostChangeRequestState(value: string): string {
  const state = value.trim().toUpperCase();
  if (state === "MERGED") return "merged";
  if (["DECLINED", "CLOSED", "SUPERSEDED"].includes(state)) return "closed";
  if (state === "DRAFT") return "draft";
  return "open";
}

export function changeRequestDetailModel(detail: ReviewDetail): HostChangeRequestDetail {
  const reviewers = detail.participants.filter((participant) =>
    ["REVIEWER", "APPROVER"].includes(participant.role?.toUpperCase() ?? "REVIEWER"),
  );
  const approved = reviewers.filter((participant) => participant.approved);
  const requested = reviewers.filter((participant) => !participant.approved);
  const person = (participant: ReviewDetail["participants"][number]) => ({
    name: participant.name,
    ...(participant.url ? { url: participant.url } : {}),
    ...(participant.avatarUrl ? { avatarUrl: participant.avatarUrl } : {}),
  });
  const comments = detail.threads.flatMap((thread) =>
    thread.comments.map((comment) => ({
      id: comment.id,
      ...(comment.parentId ? { parentId: comment.parentId } : {}),
      author: { name: comment.author },
      body: comment.body,
      ...(comment.createdAt ? { createdAt: comment.createdAt } : {}),
      ...(thread.file ? { path: thread.file } : {}),
      ...(comment.line ? { line: comment.line } : {}),
      resolved: thread.resolved,
    })),
  );
  return {
    providerId: "bitbucket",
    reviewKey: detail.key,
    number: detail.number,
    title: detail.title,
    url: detail.url,
    state: hostChangeRequestState(detail.state),
    ...(detail.state.trim().toUpperCase() === "DRAFT" ? { draft: true } : {}),
    author: {
      name: detail.author ?? "Unknown",
      ...(detail.authorUrl ? { url: detail.authorUrl } : {}),
      ...(detail.authorAvatarUrl ? { avatarUrl: detail.authorAvatarUrl } : {}),
    },
    ...(detail.createdAt ? { createdAt: detail.createdAt } : {}),
    ...(detail.mergedAt ? { mergedAt: detail.mergedAt } : {}),
    ...(detail.closedAt ? { closedAt: detail.closedAt } : {}),
    sourceBranch: detail.sourceBranch ?? "source",
    targetBranch: detail.destinationBranch ?? "destination",
    additions: detail.files.reduce((total, file) => total + (file.additions ?? 0), 0),
    deletions: detail.files.reduce((total, file) => total + (file.deletions ?? 0), 0),
    ...(detail.description ? { description: detail.description } : {}),
    ...(approved.length > 0
      ? { reviewState: "approved" }
      : requested.length > 0
        ? { reviewState: "pending" }
        : {}),
    ...(requested.length > 0 ? { pendingReviewCount: requested.length } : {}),
    reviews: approved.map((participant) => ({
      id: participant.id ?? participant.name,
      author: person(participant),
      state: "APPROVED",
    })),
    requestedReviewers: requested.map(person),
    checks: detail.statuses.map((status) => ({
      id: status.key,
      name: status.name,
      state: status.state,
      ...(status.url ? { url: status.url } : {}),
      ...(status.output ? { output: status.output } : {}),
      ...(status.startedAt ? { startedAt: status.startedAt } : {}),
      ...(status.completedAt ? { completedAt: status.completedAt } : {}),
    })),
    comments,
    ...(detail.updatedAt ? { lastSyncedAt: detail.updatedAt } : {}),
  };
}

export function changeRequestDetailActions(
  detail: ReviewDetail,
): HostChangeRequestDetailAction[] {
  if (hostChangeRequestState(detail.state) !== "open") return [];
  const can = (capability: string) => detail.capabilities.includes(capability);
  const actions: HostChangeRequestDetailAction[] = [];
  if (can("approve")) {
    actions.push(detail.viewerApproved
      ? {
          id: "unapprove",
          label: "Remove approval",
          pendingLabel: "Removing approval…",
          placement: "header",
          tone: "secondary",
        }
      : {
          id: "approve",
          label: "Approve",
          pendingLabel: "Approving…",
          placement: "header",
          tone: "success",
        });
  }
  if (can("merge")) {
    actions.push({ id: "merge", label: "Merge", pendingLabel: "Merging…", placement: "header" });
  }
  if (can("decline")) {
    actions.push({
      id: "decline",
      label: "Decline",
      pendingLabel: "Declining…",
      placement: "header",
      tone: "danger",
    });
  }
  if (can("comments")) {
    actions.push({ id: "comment", label: "Comment", placement: "comment", input: "text" });
  }
  if (can("thread_replies")) {
    actions.push({ id: "reply", label: "Reply", placement: "thread", input: "text" });
  }
  return actions;
}

export function connectionIdentity(product: string, authMethod: string): ConnectionIdentity | null {
  if (product === "cloud" && authMethod === "api_token") {
    return {
      field: "auth_identity",
      label: "Atlassian account email",
      help: "Used with this API token for Bitbucket Cloud REST. Git uses x-bitbucket-api-token-auth.",
      inputType: "email",
    };
  }
  if (product === "data_center" && (authMethod === "user_pat" || authMethod === "oauth")) {
    return {
      field: "auth_identity",
      label: "Bitbucket username",
      help: "Used for HTTPS Git with this Data Center PAT or OAuth credential.",
      inputType: "text",
    };
  }
  return null;
}

export function validateConnectionIdentity(input: ConnectionFormInput): string | null {
  const identity = connectionIdentity(input.product, input.authMethod);
  const value = input.identity.trim();
  if (!identity) return null;
  if (!value) return `Enter ${identity.label.toLowerCase()}.`;
  if (identity.inputType === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return "Enter a valid Atlassian account email.";
  }
  return null;
}

export function validateCloudWorkspace(input: ConnectionFormInput): string | null {
  if (input.product !== "cloud" || input.cloudWorkspace.trim()) return null;
  return "Enter Bitbucket Cloud workspace slug or ID.";
}

export function currentWatchFilter(query: string, state: string): JsonRecord {
  return { query: query.trim(), states: state === "all" ? [] : [state] };
}

export function taskLaunchPresets(): TaskLaunchPreset[] {
  return [
    {
      id: "review",
      label: "Review",
      hint: "Read the diff, flag issues",
      iconName: "eye",
      prompt: (pullRequest) => `Review Bitbucket pull request ${pullRequest.url || pullRequest.key}. Inspect the changes, run relevant tests, and report concrete findings.`,
    },
    {
      id: "address-feedback",
      label: "Address feedback",
      hint: "Apply review comments",
      iconName: "message",
      prompt: (pullRequest) => `Address the review feedback on Bitbucket pull request ${pullRequest.url || pullRequest.key}. Make the requested changes, verify them, and summarize what changed.`,
    },
    {
      id: "fix-ci",
      label: "Fix CI",
      hint: "Diagnose failing checks",
      iconName: "tool",
      prompt: (pullRequest) => `Fix the failing CI checks on Bitbucket pull request ${pullRequest.url || pullRequest.key}. Reproduce the failures, implement the smallest correct fix, and run the relevant checks.`,
    },
  ];
}

export function taskDialogInitialValues(
  pullRequest: PullRequest,
  preset: TaskLaunchPreset,
  hostRepositoryId?: string,
  remoteRepository?: RepositoryInspection,
): JsonRecord {
  const values: JsonRecord = {
    title: `${preset.label}: ${pullRequest.title}`,
    description: preset.prompt(pullRequest),
  };
  if (hostRepositoryId) values.repositoryId = hostRepositoryId;
  else if (pullRequest.url) {
    values.remoteUrl = pullRequest.url;
    if (remoteRepository) values.remoteRepository = remoteRepository;
  }
  if (pullRequest.sourceBranch) {
    values.branch = pullRequest.sourceBranch;
    values.checkoutBranch = pullRequest.sourceBranch;
  }
  return values;
}

export function usePluginTaskCreation(hostRepositoryId?: string): boolean {
  return !hostRepositoryId?.trim();
}

export function taskLaunchBody(
  pullRequest: PullRequest,
  payload: JsonRecord,
  launchId: string,
): JsonRecord {
  const task: JsonRecord = {
    title: string(payload.title) ?? "",
    description: string(payload.description) ?? "",
    workflow_id: string(payload.workflow_id) ?? "",
    start_agent: payload.start_agent === true,
    plan_mode: payload.plan_mode === true,
  };
  const workflowStepID = string(payload.workflow_step_id);
  const agentProfileID = string(payload.agent_profile_id);
  const executorProfileID = string(payload.executor_profile_id);
  if (workflowStepID) task.workflow_step_id = workflowStepID;
  if (agentProfileID) task.agent_profile_id = agentProfileID;
  if (executorProfileID) task.executor_profile_id = executorProfileID;
  return { review_key: pullRequest.key, launch_id: launchId, task };
}

export function taskFromLaunchResult(value: unknown): JsonRecord {
  const result = record(value);
  const taskID = string(result.task_id);
  if (!taskID) throw new Error("Bitbucket task launch returned no task id.");
  return { id: taskID, bitbucketLinked: result.linked === true };
}

export function normalizeWatches(value: unknown): WatchSummary[] {
  return itemList(value, ["watches", "items", "values"]).flatMap((entry): WatchSummary[] => {
    const watch = record(entry);
    const id = string(watch.id);
    const rawStatus = string(watch.status)?.toLowerCase();
    if (!id || (rawStatus !== "running" && rawStatus !== "paused")) return [];
    const summary: WatchSummary = { id, status: rawStatus };
    const lastPolled = string(watch.last_polled) ?? string(watch.lastPolled);
    if (lastPolled) summary.lastPolled = lastPolled;
    return [summary];
  });
}

export function validateOAuthRegistration(input: ConnectionFormInput): string | null {
  if (input.authMethod !== "oauth") return null;
  const clientID = input.oauthClientId.trim();
  const clientSecret = input.oauthClientSecret.trim();
  if (input.oauthRegistrationConfigured && !clientID && !clientSecret) return null;
  if (!clientID) return "Enter OAuth client ID.";
  if (!clientSecret) return "Enter OAuth client secret.";
  if (!input.oauthCallbackUrl.trim()) return "OAuth callback URL is unavailable.";
  return null;
}

export function connectionOAuthRegistration(value: unknown): OAuthRegistration {
  const source = record(value);
  return {
    configured: source.oauth_registration_configured === true,
  };
}

export function connectionActionBody(input: ConnectionFormInput): JsonRecord {
  const body: JsonRecord = {
    product: input.product,
    auth_method: input.authMethod,
  };
  const baseUrl = input.baseUrl.trim();
  const cloudWorkspace = input.cloudWorkspace.trim();
  const token = input.token.trim();
  const identity = input.identity.trim();
  const identityField = connectionIdentity(input.product, input.authMethod);
  if (baseUrl) body.base_url = baseUrl;
  if (input.product === "cloud" && cloudWorkspace) body.cloud_workspace = cloudWorkspace;
  if (input.authMethod !== "oauth" && token) body.token = token;
  if (identityField && identity) body[identityField.field] = identity;
  return body;
}

export function connectionSaveBody(input: ConnectionFormInput): JsonRecord {
  const body = connectionActionBody(input);
  if (input.authMethod !== "oauth") return body;
  const clientID = input.oauthClientId.trim();
  const clientSecret = input.oauthClientSecret.trim();
  if (clientID || clientSecret) {
    body.oauth_client_id = clientID;
    body.oauth_client_secret = clientSecret;
    body.oauth_redirect_url = input.oauthCallbackUrl.trim();
  }
  return body;
}

export function connectionState(value: unknown): ConnectionState {
  const candidate = string(record(value).state) ?? string(record(value).status) ?? "unconfigured";
  return ["unconfigured", "checking", "connected", "auth_required", "unavailable"].includes(candidate)
    ? (candidate as ConnectionState)
    : "unavailable";
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const source = record(error);
  return string(source.message) ?? string(source.error) ?? "Bitbucket request failed. Try again.";
}

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
  updatedAt?: string;
  statusLabel?: string;
  statusTone?: "success" | "warning" | "danger" | "neutral";
  capabilities: string[];
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
};

export type BuildStatus = {
  key: string;
  name: string;
  state: string;
  url?: string;
  target?: string;
};

export type ReviewDetail = PullRequest & {
  description?: string;
  sourceBranch?: string;
  destinationBranch?: string;
  files: ReviewFile[];
  commits: Array<{ id: string; message: string; author?: string }>;
  participants: Array<{ name: string; role?: string; approved?: boolean }>;
  threads: ReviewThread[];
  statuses: BuildStatus[];
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

export type LaunchPreset = { id: string; name: string };
export type WatchSummary = { id: string; status: "running" | "paused"; lastPolled?: string };

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

function normalizeReviewComment(value: unknown): ReviewComment | null {
  const comment = record(value);
  const id = string(comment.id) ?? string(comment.ID) ?? string(comment.comment_id);
  if (!id) return null;
  const normalized: ReviewComment = {
    id,
    author: string(comment.author) ?? string(comment.Author) ?? string(record(comment.author).display_name) ?? "Unknown",
    body: string(comment.body) ?? string(comment.Body) ?? string(comment.content) ?? "",
  };
  const parentId = string(comment.parent_id) ?? string(comment.parentId) ?? string(comment.ParentID);
  const createdAt = string(comment.created_at) ?? string(comment.createdAt) ?? string(comment.When);
  if (parentId) normalized.parentId = parentId;
  if (createdAt) normalized.createdAt = createdAt;
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
      const repositoryId = string(source.repository_id) ?? string(source.repositoryId) ?? string(repository.id) ?? "";
      const numberValue = number(source.number) ?? number(source.id) ?? 0;
      const title = string(source.title) ?? `Pull request ${numberValue || id}`;
      if (!id || !repositoryId || !numberValue) return null;
      const status = record(source.status);
      const state = string(source.state) ?? string(source.status) ?? "UNKNOWN";
      return {
        key: string(source.review_key) ?? string(source.reviewKey) ?? `${repositoryId}:${id}`,
        id,
        number: numberValue,
        title,
        url: string(source.url) ?? string(source.links) ?? "",
        repositoryId,
        repositoryName: string(source.repository_name) ?? string(source.repositoryName) ?? string(repository.name) ?? repositoryId,
        state,
        author: string(source.author) ?? string(record(source.author).display_name) ?? string(record(source.author).name),
        updatedAt: string(source.updated_at) ?? string(source.updatedAt),
        statusLabel: string(status.label) ?? string(source.status_label) ?? string(source.statusLabel),
        statusTone: statusTone(string(status.state) ?? state),
        capabilities: toCapabilities(source.capabilities),
      };
    })
    .flatMap((item): PullRequest[] => (item ? [item] : []));
}

export function normalizeReviewDetail(value: unknown): ReviewDetail | null {
  const source = record(value);
  const pr = normalizePullRequests({ pull_requests: [source] })[0];
  if (!pr) return null;
  return {
    ...pr,
    description: string(source.description),
    sourceBranch: string(source.source_branch) ?? string(record(source.source).branch),
    destinationBranch: string(source.destination_branch) ?? string(record(source.destination).branch),
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
    participants: itemList(source.participants, ["items", "values"]).flatMap((entry) => {
      const participant = record(entry);
      const name = string(participant.name) ?? string(participant.display_name) ?? string(record(participant.user).display_name);
      return name ? [{ name, role: string(participant.role), approved: participant.approved === true }] : [];
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
        createdAt: rootComment?.createdAt ?? string(thread.created_at) ?? string(thread.createdAt),
        resolved: thread.resolved === true,
        file: string(thread.file) ?? string(thread.path),
        comments: comments.length > 0 ? comments : [{ id, author: string(thread.author) ?? string(record(thread.author).display_name) ?? "Unknown", body: string(thread.body) ?? string(thread.content) ?? "" }],
      }];
    }),
    statuses: itemList(source.statuses, ["items", "values"]).flatMap((entry) => {
      const status = record(entry);
      const key = string(status.key) ?? string(status.id);
      const name = string(status.name) ?? key;
      const state = string(status.state);
      return key && name && state
        ? [{ key, name, state, url: string(status.url), target: string(status.target) }]
        : [];
    }),
  };
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

export function launchPresets(): LaunchPreset[] {
  return [
    { id: "default", name: "Default" },
    { id: "review", name: "Review and test" },
    { id: "implement", name: "Implement change" },
  ];
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

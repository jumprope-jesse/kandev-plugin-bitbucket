import type {
  JsonRecord,
  PullRequestCreateForm,
  Repository,
  RepositoryInspection,
  SavedQuery,
} from "./view-model-base";
import { array, itemList, number, record, string } from "./view-model-base";

export function normalizeRepository(value: unknown): Repository | null {
  const source = record(value);
  const repositoryId =
    string(source.provider_repository_id) ??
    string(source.repositoryId) ??
    string(source.provider_repo_id) ??
    string(source.id) ??
    string(source.uuid) ??
    string(source.slug);
  const repositoryName =
    string(source.repository_name) ??
    string(source.repositoryName) ??
    string(source.provider_name) ??
    string(source.name) ??
    string(source.slug) ??
    repositoryId;
  if (!repositoryId || !repositoryName) return null;
  const repository: Repository = {
    providerId:
      string(source.provider_id) ??
      string(source.providerId) ??
      string(source.provider) ??
      "bitbucket",
    providerHost:
      string(source.provider_host) ??
      string(source.providerHost) ??
      string(source.host) ??
      "",
    ownerOrProject:
      string(source.owner_or_project) ??
      string(source.ownerOrProject) ??
      string(source.provider_owner) ??
      string(source.project) ??
      string(record(source.owner).username) ??
      "",
    repositoryId,
    repositoryName,
    cloneUrl:
      string(source.clone_url) ??
      string(source.cloneUrl) ??
      string(source.remote_url) ??
      string(source.url) ??
      "",
  };
  const defaultBranch =
    string(source.default_branch) ?? string(source.defaultBranch);
  const baseBranch = string(source.base_branch) ?? string(source.baseBranch);
  const headBranch =
    string(source.head_branch) ??
    string(source.headBranch) ??
    string(source.checkout_branch);
  if (defaultBranch) repository.defaultBranch = defaultBranch;
  if (baseBranch) repository.baseBranch = baseBranch;
  if (headBranch) repository.headBranch = headBranch;
  return repository;
}

export function normalizeRepositories(value: unknown): Repository[] {
  return itemList(value, ["repositories", "items", "values"]).flatMap(
    (item): Repository[] => {
      const repository = normalizeRepository(item);
      return repository ? [repository] : [];
    },
  );
}

export function normalizeRepositoryInspection(
  value: unknown,
): RepositoryInspection | null {
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
    repository.pullRequest = {
      number: pullRequestNumber,
      title: pullRequestTitle,
    };
  }
  return repository;
}

export function taskRepositoryDescriptor(
  taskRepositories: readonly unknown[],
  workspaceRepositories: unknown,
): Repository | null {
  const taskRepository = record(taskRepositories[0]);
  const hostRepositoryID =
    string(taskRepository.repository_id) ?? string(taskRepository.repositoryId);
  const configuredRepositories = Array.isArray(workspaceRepositories)
    ? workspaceRepositories
    : itemList(workspaceRepositories, ["repositories", "items", "values"]);
  const configuredRepository = configuredRepositories.find(
    (candidate) => string(record(candidate).id) === hostRepositoryID,
  );
  const repository = normalizeRepository(
    configuredRepository ?? taskRepository,
  );
  if (
    !repository ||
    (!configuredRepository &&
      !string(taskRepository.provider_id) &&
      !string(taskRepository.providerId))
  )
    return null;
  const baseBranch =
    string(taskRepository.base_branch) ?? string(taskRepository.baseBranch);
  const headBranch =
    string(taskRepository.checkout_branch) ?? string(taskRepository.headBranch);
  if (baseBranch) repository.baseBranch = baseBranch;
  if (headBranch) repository.headBranch = headBranch;
  return repository;
}

export function taskSupportsBitbucketRepository(
  taskRepositories: readonly unknown[],
): boolean {
  const providers = taskRepositories
    .map((repository) => {
      const source = record(repository);
      return (
        string(source.provider_id) ??
        string(source.providerId) ??
        string(source.provider)
      );
    })
    .flatMap((provider) => (provider ? [provider.toLowerCase()] : []));
  return providers.length === 0 || providers.includes("bitbucket");
}

export function pullRequestCreateBody(
  input: PullRequestCreateForm,
): JsonRecord {
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

export function workspacePullRequestAction(
  workspaceId: string,
  reviewKey: string,
  pullRequestID: string,
  operation?: string,
): { workspaceId: string; body: JsonRecord } {
  const body: JsonRecord = {
    review_key: reviewKey,
    pull_request_id: pullRequestID,
  };
  if (operation) body.operation = operation;
  return { workspaceId, body };
}

export function workspaceReviewAction(
  workspaceId: string,
  reviewKey: string,
  pullRequestID: string,
  kind: string,
  options: {
    comment?: string;
    parentCommentId?: string;
    buildKey?: string;
  } = {},
): { workspaceId: string; body: JsonRecord } {
  const body: JsonRecord = {
    review_key: reviewKey,
    pull_request_id: pullRequestID,
    kind,
  };
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
  const cloud = url.pathname.match(
    /^\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)(?:\/|$)/i,
  );
  if (cloud) return { review_key: `${cloud[1]}/${cloud[2]}#${cloud[3]}` };
  const dataCenter = url.pathname.match(
    /(?:^|\/)projects\/([^/]+)\/repos\/([^/]+)\/pull-requests\/(\d+)(?:\/|$)/i,
  );
  return dataCenter
    ? { review_key: `${dataCenter[1]}/${dataCenter[2]}#${dataCenter[3]}` }
    : null;
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
): {
  actionKey: "pullrequests.search" | "pullrequests.queue";
  body: JsonRecord;
} {
  const parsed = parsePullRequestListQuery(query, state);
  if (repository) {
    return {
      actionKey: "pullrequests.search",
      body: {
        repository: pluginRepositoryInput(repository),
        query: parsed.query,
        state: parsed.state,
      },
    };
  }
  return {
    actionKey: "pullrequests.queue",
    body: { view: "queue", query: parsed.query, state: parsed.state },
  };
}

const PULL_REQUEST_STATES = new Set(["open", "all", "merged", "declined"]);
const PULL_REQUEST_STATE_TOKEN =
  /(^|\s)state:(open|all|merged|declined)(?=\s|$)/gi;

export function normalizedPullRequestState(value: string): string {
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
      const query =
        typeof source.query === "string" ? source.query.trim() : undefined;
      const repositoryId =
        typeof source.repositoryId === "string"
          ? source.repositoryId.trim()
          : undefined;
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
      return [
        {
          id,
          label,
          query,
          repositoryId,
          state: state.toLowerCase(),
          createdAt,
        },
      ];
    })
    .slice(-MAX_SAVED_QUERIES);
}

export function canSaveDashboardQuery(
  query: string,
  repositoryId: string,
): boolean {
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

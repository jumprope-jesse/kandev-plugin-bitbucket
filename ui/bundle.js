// ui/src/view-models.ts
function integrationSettingsHref(workspaceId) {
  return workspaceId ? `/settings/workspace/${encodeURIComponent(workspaceId)}/integrations/bitbucket` : "/settings/integrations/bitbucket";
}
function displayPullRequestAuthor(author) {
  const value = author?.trim();
  if (!value || /^\d+:[a-z0-9-]{20,}$/i.test(value)) return void 0;
  return value;
}
function relativeTimeLabel(value, now = /* @__PURE__ */ new Date()) {
  if (!value) return void 0;
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return void 0;
  const seconds = Math.floor((now.getTime() - instant.getTime()) / 1e3);
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
function oauthStartInput(workspaceId) {
  return { workspaceId };
}
function disconnectConnectionInput(workspaceId) {
  return { workspaceId };
}
function deriveOAuthCallbackURL(origin) {
  return new URL("/api/plugins/kandev-plugin-bitbucket/webhooks/oauth-callback", origin).toString();
}
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function string(value) {
  return typeof value === "string" && value.trim() ? value : void 0;
}
function activeWorkspaceIdFromState(state) {
  return string(record(record(state).workspaces).activeId);
}
function number(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return void 0;
}
function array(value) {
  return Array.isArray(value) ? value : [];
}
function timestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date2 = new Date(value);
    return Number.isFinite(date2.getTime()) && date2.getUTCFullYear() > 1 ? date2.toISOString() : void 0;
  }
  const text2 = string(value);
  if (!text2) return void 0;
  if (/^\d+$/.test(text2)) {
    const date2 = new Date(Number(text2));
    return Number.isFinite(date2.getTime()) && date2.getUTCFullYear() > 1 ? date2.toISOString() : void 0;
  }
  const date = new Date(text2);
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() > 1 ? text2 : void 0;
}
function boolean(value) {
  return typeof value === "boolean" ? value : void 0;
}
function linkHref(value) {
  const direct = string(value);
  if (direct) return direct;
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const href = linkHref(candidate);
      if (href) return href;
    }
    return void 0;
  }
  const link = record(value);
  return string(link.href) ?? string(link.url);
}
function pullRequestURL(value) {
  const links = record(value);
  return linkHref(links.html) ?? linkHref(links.self) ?? linkHref(value);
}
function personLink(value, kind) {
  const person = record(value);
  return linkHref(record(person.links)[kind]) ?? linkHref(person[kind === "html" ? "url" : "avatarUrl"]);
}
function itemList(value, keys) {
  if (Array.isArray(value)) return value;
  const source = record(value);
  for (const key of keys) {
    if (Array.isArray(source[key])) return source[key];
  }
  return [];
}
function toCapabilities(value) {
  if (typeof value === "string") {
    return value.split(",").map((capability) => capability.trim()).filter(Boolean);
  }
  return array(value).flatMap((entry) => typeof entry === "string" ? [entry] : []);
}
function normalizeTaskLinks(value, reviewKey = "") {
  return itemList(value, ["associations", "tasks", "items", "values"]).flatMap((entry) => {
    const source = record(entry);
    const taskId = string(source.task_id) ?? string(source.taskId);
    const entryReviewKey = string(source.review_key) ?? string(source.reviewKey) ?? reviewKey;
    if (!taskId || reviewKey && entryReviewKey !== reviewKey) return [];
    return [{
      id: string(source.id) ?? `${entryReviewKey}:${taskId}`,
      taskId,
      fallbackTitle: string(source.task_title) ?? string(source.taskTitle) ?? string(source.title) ?? "Bitbucket task"
    }];
  });
}
function normalizePullRequestAssociations(value) {
  const result = {};
  for (const entry of itemList(value, ["associations", "items", "values"])) {
    const source = record(entry);
    const reviewKey = string(source.review_key) ?? string(source.reviewKey);
    if (!reviewKey) continue;
    const links = normalizeTaskLinks([source], reviewKey);
    if (links.length) result[reviewKey] = [...result[reviewKey] ?? [], ...links];
  }
  return result;
}
function normalizeReviewComment(value) {
  const comment = record(value);
  const id = string(comment.id) ?? string(comment.ID) ?? string(comment.comment_id);
  if (!id) return null;
  const normalized = {
    id,
    author: string(comment.author) ?? string(comment.Author) ?? string(record(comment.author).display_name) ?? string(record(comment.author).displayName) ?? "Unknown",
    body: string(comment.body) ?? string(comment.Body) ?? string(comment.content) ?? string(record(comment.content).raw) ?? string(comment.text) ?? ""
  };
  const parentId = string(comment.parent_id) ?? string(comment.parentId) ?? string(comment.ParentID);
  const createdAt = timestamp(comment.created_at) ?? timestamp(comment.createdAt) ?? timestamp(comment.When);
  const line = number(comment.line) ?? number(record(comment.inline).to) ?? number(record(comment.anchor).line);
  if (parentId) normalized.parentId = parentId;
  if (createdAt) normalized.createdAt = createdAt;
  if (line) normalized.line = line;
  return normalized;
}
function statusTone(state) {
  const normalized = state.toLowerCase();
  if (/(success|passed|approved|merged|open)/.test(normalized)) return "success";
  if (/(fail|declined|error|blocked)/.test(normalized)) return "danger";
  if (/(pending|build|review|draft)/.test(normalized)) return "warning";
  return "neutral";
}
function normalizeRepository(value) {
  const source = record(value);
  const repositoryId = string(source.provider_repository_id) ?? string(source.repositoryId) ?? string(source.provider_repo_id) ?? string(source.id) ?? string(source.uuid) ?? string(source.slug);
  const repositoryName = string(source.repository_name) ?? string(source.repositoryName) ?? string(source.provider_name) ?? string(source.name) ?? string(source.slug) ?? repositoryId;
  if (!repositoryId || !repositoryName) return null;
  const repository = {
    providerId: string(source.provider_id) ?? string(source.providerId) ?? string(source.provider) ?? "bitbucket",
    providerHost: string(source.provider_host) ?? string(source.providerHost) ?? string(source.host) ?? "",
    ownerOrProject: string(source.owner_or_project) ?? string(source.ownerOrProject) ?? string(source.provider_owner) ?? string(source.project) ?? string(record(source.owner).username) ?? "",
    repositoryId,
    repositoryName,
    cloneUrl: string(source.clone_url) ?? string(source.cloneUrl) ?? string(source.remote_url) ?? string(source.url) ?? ""
  };
  const defaultBranch = string(source.default_branch) ?? string(source.defaultBranch);
  const baseBranch = string(source.base_branch) ?? string(source.baseBranch);
  const headBranch = string(source.head_branch) ?? string(source.headBranch) ?? string(source.checkout_branch);
  if (defaultBranch) repository.defaultBranch = defaultBranch;
  if (baseBranch) repository.baseBranch = baseBranch;
  if (headBranch) repository.headBranch = headBranch;
  return repository;
}
function normalizeRepositories(value) {
  return itemList(value, ["repositories", "items", "values"]).flatMap((item) => {
    const repository = normalizeRepository(item);
    return repository ? [repository] : [];
  });
}
function normalizeRepositoryInspection(value) {
  const source = record(value);
  const repository = normalizeRepository(
    Object.keys(record(source.repository)).length ? source.repository : source
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
function workspaceReviewAction(workspaceId, reviewKey, pullRequestID, kind, options = {}) {
  const body = { review_key: reviewKey, pull_request_id: pullRequestID, kind };
  const comment = options.comment?.trim();
  if (comment) body.comment = comment;
  if (options.parentCommentId) body.parent_comment_id = options.parentCommentId;
  if (options.buildKey) body.build_key = options.buildKey;
  return { workspaceId, body };
}
function linkPullRequestBody(reference) {
  const key = reference.trim();
  if (/^[^/#\s]+\/[^/#\s]+#[1-9]\d*$/.test(key)) return { review_key: key };
  let url;
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
function pluginRepositoryInput(value) {
  const repository = normalizeRepository(value);
  if (!repository) return {};
  const body = {
    provider_id: repository.providerId,
    provider_host: repository.providerHost,
    owner_or_project: repository.ownerOrProject,
    provider_repository_id: repository.repositoryId,
    name: repository.repositoryName,
    clone_url: repository.cloneUrl
  };
  if (repository.defaultBranch) body.default_branch = repository.defaultBranch;
  if (repository.baseBranch) body.base_branch = repository.baseBranch;
  if (repository.headBranch) body.head_branch = repository.headBranch;
  return body;
}
function pullRequestListRequest(repository, query, state) {
  const parsed = parsePullRequestListQuery(query, state);
  if (repository) {
    return {
      actionKey: "pullrequests.search",
      body: { repository: pluginRepositoryInput(repository), query: parsed.query, state: parsed.state }
    };
  }
  return { actionKey: "pullrequests.queue", body: { view: "queue", query: parsed.query, state: parsed.state } };
}
var PULL_REQUEST_STATES = /* @__PURE__ */ new Set(["open", "all", "merged", "declined"]);
var PULL_REQUEST_STATE_TOKEN = /(^|\s)state:(open|all|merged|declined)(?=\s|$)/gi;
function normalizedPullRequestState(value) {
  const state = value.trim().toLowerCase();
  return PULL_REQUEST_STATES.has(state) ? state : "open";
}
function pullRequestScopeQuery(state) {
  return `state:${normalizedPullRequestState(state)}`;
}
function parsePullRequestListQuery(query, fallbackState) {
  let state = normalizedPullRequestState(fallbackState);
  const textQuery = query.replace(
    PULL_REQUEST_STATE_TOKEN,
    (_match, prefix, value) => {
      state = normalizedPullRequestState(value);
      return prefix;
    }
  );
  return { query: textQuery.trim().replace(/\s+/g, " "), state };
}
var MAX_SAVED_QUERIES = 50;
function normalizeSavedQueries(value) {
  return array(value).flatMap((entry) => {
    const source = record(entry);
    const id = string(source.id);
    const label = string(source.label);
    const query = typeof source.query === "string" ? source.query.trim() : void 0;
    const repositoryId = typeof source.repositoryId === "string" ? source.repositoryId.trim() : void 0;
    const state = string(source.state);
    const createdAt = string(source.createdAt);
    if (!id || !label || query === void 0 || repositoryId === void 0 || !state || !PULL_REQUEST_STATES.has(state.toLowerCase()) || !createdAt) {
      return [];
    }
    return [{ id, label, query, repositoryId, state: state.toLowerCase(), createdAt }];
  }).slice(-MAX_SAVED_QUERIES);
}
function canSaveDashboardQuery(query, repositoryId) {
  return Boolean(query.trim() || repositoryId.trim());
}
function newSavedQuery(input, id, createdAt) {
  return {
    id,
    label: input.label.trim(),
    query: input.query.trim(),
    repositoryId: input.repositoryId.trim(),
    state: normalizedPullRequestState(input.state),
    createdAt
  };
}
function normalizePullRequests(value) {
  return itemList(value, ["pull_requests", "pullRequests", "items", "values"]).map((item) => {
    const source = record(item);
    const id = string(source.id) ?? string(source.key) ?? string(source.uuid) ?? String(number(source.number) ?? number(source.id) ?? "");
    const repository = record(source.repository);
    const repositorySlug = string(repository.slug) ?? string(repository.name);
    const repositoryNamespace = string(record(repository.project).key) ?? string(record(repository.owner).username) ?? string(record(repository.workspace).slug);
    const repositoryId = string(source.repository_id) ?? string(source.repositoryId) ?? string(repository.full_name) ?? (repositoryNamespace && repositorySlug ? `${repositoryNamespace}/${repositorySlug}` : void 0) ?? string(repository.id) ?? "";
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
      author: string(source.author_display_name) ?? string(source.authorDisplayName) ?? string(author.display_name) ?? string(author.displayName) ?? string(author.name) ?? string(source.author),
      authorUrl: string(source.author_url) ?? string(source.authorUrl) ?? personLink(author, "html"),
      authorAvatarUrl: string(source.author_avatar_url) ?? string(source.authorAvatarUrl) ?? personLink(author, "avatar"),
      createdAt: timestamp(source.created_at) ?? timestamp(source.createdAt) ?? timestamp(source.created_on) ?? timestamp(source.createdDate),
      updatedAt: timestamp(source.updated_at) ?? timestamp(source.updatedAt) ?? timestamp(source.updated_on) ?? timestamp(source.updatedDate),
      mergedAt: timestamp(source.merged_at) ?? timestamp(source.mergedAt),
      closedAt: timestamp(source.closed_at) ?? timestamp(source.closedAt),
      sourceBranch: string(source.source_branch) ?? string(source.sourceBranch) ?? string(record(sourceRef.branch).name) ?? string(sourceRef.branch) ?? string(fromRef.displayId) ?? string(fromRef.id)?.replace(/^refs\/heads\//, ""),
      destinationBranch: string(source.destination_branch) ?? string(source.destinationBranch) ?? string(record(destinationRef.branch).name) ?? string(destinationRef.branch) ?? string(toRef.displayId) ?? string(toRef.id)?.replace(/^refs\/heads\//, ""),
      headCommit: string(source.head_commit) ?? string(source.headCommit) ?? string(record(sourceRef.commit).hash) ?? string(fromRef.latestCommit),
      statusLabel: string(status.label) ?? string(source.status_label) ?? string(source.statusLabel),
      statusTone: statusTone(string(status.state) ?? state),
      tasks: normalizeTaskLinks(source.associations ?? source.tasks, reviewKey),
      capabilities: toCapabilities(source.capabilities)
    };
  }).flatMap((item) => item ? [item] : []);
}
function isCurrentUserParticipant(participant) {
  const user = record(participant.user);
  return participant.is_current_user === true || participant.isCurrentUser === true || participant.currentUser === true || user.is_current_user === true || user.isCurrentUser === true;
}
function normalizeViewerApproval(source, participants) {
  const direct = boolean(source.viewer_approved) ?? boolean(source.viewerApproved) ?? boolean(source.current_user_approved) ?? boolean(source.currentUserApproved);
  if (direct !== void 0) return direct;
  const viewer = participants.map(record).find(isCurrentUserParticipant);
  if (!viewer) return void 0;
  return boolean(viewer.approved) ?? string(viewer.status)?.toUpperCase() === "APPROVED";
}
function normalizeReviewDetail(value) {
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
      return path ? [{ path, status: string(file.status) ?? "modified", additions: number(file.additions), deletions: number(file.deletions), patch: string(file.patch) }] : [];
    }),
    commits: itemList(source.commits, ["items", "values"]).flatMap((entry) => {
      const commit = record(entry);
      const id = string(commit.id) ?? string(commit.hash);
      return id ? [{ id, message: string(commit.message) ?? id, author: string(commit.author) ?? string(record(commit.author).name) }] : [];
    }),
    participants: participantItems.flatMap((entry) => {
      const participant = record(entry);
      const user = record(participant.user);
      const name = string(participant.name) ?? string(participant.display_name) ?? string(participant.displayName) ?? string(user.display_name) ?? string(user.displayName) ?? string(user.name);
      const approved = boolean(participant.approved) ?? string(participant.status)?.toUpperCase() === "APPROVED";
      const isCurrentUser = boolean(participant.is_current_user) ?? boolean(participant.isCurrentUser) ?? boolean(participant.currentUser) ?? boolean(user.is_current_user) ?? boolean(user.isCurrentUser);
      return name ? [{
        id: string(participant.id) ?? string(user.account_id) ?? string(user.slug),
        name,
        role: string(participant.role),
        approved,
        isCurrentUser,
        url: personLink(user, "html"),
        avatarUrl: personLink(user, "avatar")
      }] : [];
    }),
    threads: itemList(source.threads, ["items", "values"]).flatMap((entry) => {
      const thread = record(entry);
      const id = string(thread.id) ?? string(thread.comment_id);
      if (!id) return [];
      const comments = itemList(thread.comments, ["items", "values"]).flatMap((comment) => {
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
        comments: comments.length > 0 ? comments : [{ id, author: string(thread.author) ?? string(record(thread.author).display_name) ?? "Unknown", body: string(thread.body) ?? string(thread.content) ?? "" }]
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
      const startedAt = timestamp(status.started_at) ?? timestamp(status.startedAt) ?? timestamp(status.created_on) ?? timestamp(status.createdDate);
      const completedAt = timestamp(status.completed_at) ?? timestamp(status.completedAt) ?? timestamp(status.updated_on) ?? timestamp(status.updatedDate);
      return key && name && state ? [{
        key,
        name,
        state,
        ...url ? { url } : {},
        ...target ? { target } : {},
        ...output ? { output } : {},
        ...startedAt ? { startedAt } : {},
        ...completedAt ? { completedAt } : {}
      }] : [];
    }),
    viewerApproved: normalizeViewerApproval(source, participantItems)
  };
}
function hostChangeRequestState(value) {
  const state = value.trim().toUpperCase();
  if (state === "MERGED") return "merged";
  if (["DECLINED", "CLOSED", "SUPERSEDED"].includes(state)) return "closed";
  if (state === "DRAFT") return "draft";
  return "open";
}
function changeRequestDetailModel(detail) {
  const reviewers = detail.participants.filter(
    (participant) => ["REVIEWER", "APPROVER"].includes(participant.role?.toUpperCase() ?? "REVIEWER")
  );
  const approved = reviewers.filter((participant) => participant.approved);
  const requested = reviewers.filter((participant) => !participant.approved);
  const person = (participant) => ({
    name: participant.name,
    ...participant.url ? { url: participant.url } : {},
    ...participant.avatarUrl ? { avatarUrl: participant.avatarUrl } : {}
  });
  const comments = detail.threads.flatMap(
    (thread) => thread.comments.map((comment) => ({
      id: comment.id,
      ...comment.parentId ? { parentId: comment.parentId } : {},
      author: { name: comment.author },
      body: comment.body,
      ...comment.createdAt ? { createdAt: comment.createdAt } : {},
      ...thread.file ? { path: thread.file } : {},
      ...comment.line ? { line: comment.line } : {},
      resolved: thread.resolved
    }))
  );
  return {
    providerId: "bitbucket",
    reviewKey: detail.key,
    number: detail.number,
    title: detail.title,
    url: detail.url,
    state: hostChangeRequestState(detail.state),
    ...detail.state.trim().toUpperCase() === "DRAFT" ? { draft: true } : {},
    author: {
      name: detail.author ?? "Unknown",
      ...detail.authorUrl ? { url: detail.authorUrl } : {},
      ...detail.authorAvatarUrl ? { avatarUrl: detail.authorAvatarUrl } : {}
    },
    ...detail.createdAt ? { createdAt: detail.createdAt } : {},
    ...detail.mergedAt ? { mergedAt: detail.mergedAt } : {},
    ...detail.closedAt ? { closedAt: detail.closedAt } : {},
    sourceBranch: detail.sourceBranch ?? "source",
    targetBranch: detail.destinationBranch ?? "destination",
    additions: detail.files.reduce((total, file) => total + (file.additions ?? 0), 0),
    deletions: detail.files.reduce((total, file) => total + (file.deletions ?? 0), 0),
    ...detail.description ? { description: detail.description } : {},
    ...approved.length > 0 ? { reviewState: "approved" } : requested.length > 0 ? { reviewState: "pending" } : {},
    ...requested.length > 0 ? { pendingReviewCount: requested.length } : {},
    reviews: approved.map((participant) => ({
      id: participant.id ?? participant.name,
      author: person(participant),
      state: "APPROVED"
    })),
    requestedReviewers: requested.map(person),
    checks: detail.statuses.map((status) => ({
      id: status.key,
      name: status.name,
      state: status.state,
      ...status.url ? { url: status.url } : {},
      ...status.output ? { output: status.output } : {},
      ...status.startedAt ? { startedAt: status.startedAt } : {},
      ...status.completedAt ? { completedAt: status.completedAt } : {}
    })),
    comments,
    ...detail.updatedAt ? { lastSyncedAt: detail.updatedAt } : {}
  };
}
function changeRequestDetailActions(detail) {
  if (hostChangeRequestState(detail.state) !== "open") return [];
  const can = (capability) => detail.capabilities.includes(capability);
  const actions = [];
  if (can("approve")) {
    actions.push(detail.viewerApproved ? {
      id: "unapprove",
      label: "Remove approval",
      pendingLabel: "Removing approval\u2026",
      placement: "header",
      tone: "secondary"
    } : {
      id: "approve",
      label: "Approve",
      pendingLabel: "Approving\u2026",
      placement: "header",
      tone: "success"
    });
  }
  if (can("merge")) {
    actions.push({ id: "merge", label: "Merge", pendingLabel: "Merging\u2026", placement: "header" });
  }
  if (can("decline")) {
    actions.push({
      id: "decline",
      label: "Decline",
      pendingLabel: "Declining\u2026",
      placement: "header",
      tone: "danger"
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
function connectionIdentity(product, authMethod) {
  if (product === "cloud" && authMethod === "api_token") {
    return {
      field: "auth_identity",
      label: "Atlassian account email",
      help: "Used with this API token for Bitbucket Cloud REST. Git uses x-bitbucket-api-token-auth.",
      inputType: "email"
    };
  }
  if (product === "data_center" && (authMethod === "user_pat" || authMethod === "oauth")) {
    return {
      field: "auth_identity",
      label: "Bitbucket username",
      help: "Used for HTTPS Git with this Data Center PAT or OAuth credential.",
      inputType: "text"
    };
  }
  return null;
}
function validateConnectionIdentity(input) {
  const identity = connectionIdentity(input.product, input.authMethod);
  const value = input.identity.trim();
  if (!identity) return null;
  if (!value) return `Enter ${identity.label.toLowerCase()}.`;
  if (identity.inputType === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return "Enter a valid Atlassian account email.";
  }
  return null;
}
function validateCloudWorkspace(input) {
  if (input.product !== "cloud" || input.cloudWorkspace.trim()) return null;
  return "Enter Bitbucket Cloud workspace slug or ID.";
}
function taskLaunchPresets() {
  return [
    {
      id: "review",
      label: "Review",
      hint: "Read the diff, flag issues",
      iconName: "eye",
      prompt: (pullRequest) => `Review Bitbucket pull request ${pullRequest.url || pullRequest.key}. Inspect the changes, run relevant tests, and report concrete findings.`
    },
    {
      id: "address-feedback",
      label: "Address feedback",
      hint: "Apply review comments",
      iconName: "message",
      prompt: (pullRequest) => `Address the review feedback on Bitbucket pull request ${pullRequest.url || pullRequest.key}. Make the requested changes, verify them, and summarize what changed.`
    },
    {
      id: "fix-ci",
      label: "Fix CI",
      hint: "Diagnose failing checks",
      iconName: "tool",
      prompt: (pullRequest) => `Fix the failing CI checks on Bitbucket pull request ${pullRequest.url || pullRequest.key}. Reproduce the failures, implement the smallest correct fix, and run the relevant checks.`
    }
  ];
}
function taskDialogInitialValues(pullRequest, preset, hostRepositoryId, remoteRepository) {
  const values = {
    title: `${preset.label}: ${pullRequest.title}`,
    description: preset.prompt(pullRequest)
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
function usePluginTaskCreation(hostRepositoryId) {
  return !hostRepositoryId?.trim();
}
function taskLaunchBody(pullRequest, payload, launchId) {
  const task = {
    title: string(payload.title) ?? "",
    description: string(payload.description) ?? "",
    workflow_id: string(payload.workflow_id) ?? "",
    start_agent: payload.start_agent === true,
    plan_mode: payload.plan_mode === true
  };
  const workflowStepID = string(payload.workflow_step_id);
  const agentProfileID = string(payload.agent_profile_id);
  const executorProfileID = string(payload.executor_profile_id);
  if (workflowStepID) task.workflow_step_id = workflowStepID;
  if (agentProfileID) task.agent_profile_id = agentProfileID;
  if (executorProfileID) task.executor_profile_id = executorProfileID;
  return { review_key: pullRequest.key, launch_id: launchId, task };
}
function taskFromLaunchResult(value) {
  const result = record(value);
  const taskID = string(result.task_id);
  if (!taskID) throw new Error("Bitbucket task launch returned no task id.");
  return { id: taskID, bitbucketLinked: result.linked === true };
}
function normalizeWatches(value) {
  return itemList(value, ["watches", "items", "values"]).flatMap((entry) => {
    const watch = record(entry);
    const id = string(watch.id);
    const rawStatus = string(watch.status)?.toLowerCase();
    if (!id || rawStatus !== "running" && rawStatus !== "paused") return [];
    const summary = { id, status: rawStatus };
    const lastPolled = string(watch.last_polled) ?? string(watch.lastPolled);
    if (lastPolled) summary.lastPolled = lastPolled;
    return [summary];
  });
}
function validateOAuthRegistration(input) {
  if (input.authMethod !== "oauth") return null;
  const clientID = input.oauthClientId.trim();
  const clientSecret = input.oauthClientSecret.trim();
  if (input.oauthRegistrationConfigured && !clientID && !clientSecret) return null;
  if (!clientID) return "Enter OAuth client ID.";
  if (!clientSecret) return "Enter OAuth client secret.";
  if (!input.oauthCallbackUrl.trim()) return "OAuth callback URL is unavailable.";
  return null;
}
function connectionOAuthRegistration(value) {
  const source = record(value);
  return {
    configured: source.oauth_registration_configured === true
  };
}
function connectionActionBody(input) {
  const body = {
    product: input.product,
    auth_method: input.authMethod
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
function connectionSaveBody(input) {
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
function connectionState(value) {
  const candidate = string(record(value).state) ?? string(record(value).status) ?? "unconfigured";
  return ["unconfigured", "checking", "connected", "auth_required", "unavailable"].includes(candidate) ? candidate : "unavailable";
}
function errorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  const source = record(error);
  return string(source.message) ?? string(source.error) ?? "Bitbucket request failed. Try again.";
}

// ui/src/task-review-status.ts
async function loadTaskPullRequestDetails(invokeAction, context, signal) {
  const scope = {
    ...context.workspaceId ? { workspaceId: context.workspaceId } : {},
    taskId: context.taskId
  };
  const linkedResponse = await invokeAction(
    "pullrequests.get",
    { ...scope, body: { view: "task" } },
    { signal }
  );
  const linked = normalizePullRequests(linkedResponse);
  return Promise.all(linked.map(async (pullRequest) => {
    const detailResponse = await invokeAction(
      "pullrequests.get",
      {
        ...scope,
        body: {
          review_key: pullRequest.key,
          pull_request_id: pullRequest.id,
          include: ["participants", "threads", "status"]
        }
      },
      { signal }
    );
    return normalizeReviewDetail(detailResponse) ?? pullRequest;
  }));
}
function normalizePipelineState(value) {
  const state = value.trim().toUpperCase();
  if (["SUCCESS", "SUCCESSFUL", "PASSED", "COMPLETED"].includes(state)) return "success";
  if (["FAILED", "FAILURE", "ERROR", "STOPPED"].includes(state)) return "failure";
  if (["PENDING", "INPROGRESS", "IN_PROGRESS", "RUNNING"].includes(state)) return "pending";
  return "neutral";
}
function pullRequestState(value) {
  const state = value.trim().toUpperCase();
  if (state === "MERGED") return "merged";
  if (state === "DRAFT") return "draft";
  if (["DECLINED", "CLOSED", "SUPERSEDED"].includes(state)) return "closed";
  return "open";
}
function changeRequestStatusView(pullRequest, refreshedAt = Date.now()) {
  const checks = (pullRequest.statuses ?? []).map((status) => ({
    id: status.key,
    label: status.name,
    state: normalizePipelineState(status.state),
    ...status.target ? { detail: status.target } : {},
    ...status.url ? { url: status.url } : {}
  }));
  const states = checks.map((row) => row.state);
  const reviewers = "participants" in pullRequest && Array.isArray(pullRequest.participants) ? pullRequest.participants.filter(
    (participant) => ["REVIEWER", "APPROVER"].includes(participant.role?.toUpperCase() ?? "REVIEWER")
  ) : [];
  const approved = reviewers.filter((participant) => participant.approved).length;
  const requested = reviewers.length - approved;
  const unresolvedComments = "threads" in pullRequest && Array.isArray(pullRequest.threads) ? pullRequest.threads.filter((thread) => !thread.resolved).length : 0;
  const providerUpdatedAt = pullRequest.updatedAt ? Date.parse(pullRequest.updatedAt) : Number.NaN;
  const updatedAt = Number.isFinite(providerUpdatedAt) ? providerUpdatedAt : refreshedAt;
  const pipelineState = states.includes("failure") ? "failure" : states.includes("pending") ? "pending" : states.length > 0 && states.every((state) => state === "success") ? "success" : "neutral";
  return {
    number: pullRequest.number,
    state: pullRequestState(pullRequest.state),
    pipelineState,
    checks,
    ...reviewers.length > 0 ? {
      review: {
        state: approved > 0 ? "approved" : "pending",
        approved,
        ...requested > 0 ? { requested } : {}
      }
    } : {},
    ...unresolvedComments > 0 ? { unresolvedComments } : {},
    updatedAt
  };
}
function reviewSummaryForPullRequest(pullRequest, refreshedAt = Date.now()) {
  return {
    providerId: "bitbucket",
    reviewKey: pullRequest.key,
    title: pullRequest.title,
    url: pullRequest.url,
    repositoryId: pullRequest.repositoryId,
    state: pullRequest.state,
    ...pullRequest.statusLabel ? {
      statusBadge: {
        label: pullRequest.statusLabel,
        ...pullRequest.statusTone ? { tone: pullRequest.statusTone } : {}
      }
    } : {},
    taskStatus: changeRequestStatusView(pullRequest, refreshedAt)
  };
}

// ui/src/bundle.ts
var PLUGIN_ID = "kandev-plugin-bitbucket";
var action = {
  connectionGet: "connection.get",
  connectionSave: "connection.save",
  connectionDisconnect: "connection.disconnect",
  oauthStart: "oauth.start",
  repositoriesList: "repositories.list",
  repositoriesBranches: "repositories.branches",
  repositoriesInspect: "repositories.inspect",
  pullRequestsGet: "pullrequests.get",
  pullRequestsAssociations: "pullrequests.associations",
  pullRequestsInspect: "pullrequests.inspect",
  pullRequestsLink: "pullrequests.link",
  pullRequestsCreate: "pullrequests.create",
  pullRequestsUnlink: "pullrequests.unlink",
  reviewsAction: "reviews.action",
  tasksLaunch: "tasks.launch",
  watchesGet: "watches.get",
  watchesUpdate: "watches.update",
  watchesRun: "watches.run",
  watchesPause: "watches.pause",
  watchesResume: "watches.resume",
  watchesPreviewReset: "watches.preview_reset",
  watchesPreviewDelete: "watches.preview_delete",
  watchesReset: "watches.reset",
  watchesDelete: "watches.delete"
};
var reviewStore = /* @__PURE__ */ (() => {
  const snapshots = /* @__PURE__ */ new Map();
  const listeners = /* @__PURE__ */ new Map();
  return {
    get(taskId) {
      return snapshots.get(taskId) ?? [];
    },
    set(taskId, pullRequests) {
      snapshots.set(taskId, pullRequests.map((pullRequest) => reviewSummaryForPullRequest(pullRequest)));
      listeners.get(taskId)?.forEach((listener) => listener());
    },
    subscribe(taskId, listener) {
      const taskListeners = listeners.get(taskId) ?? /* @__PURE__ */ new Set();
      taskListeners.add(listener);
      listeners.set(taskId, taskListeners);
      return () => {
        taskListeners.delete(listener);
        if (taskListeners.size === 0) listeners.delete(taskId);
      };
    },
    clear() {
      snapshots.clear();
      listeners.forEach((taskListeners) => taskListeners.forEach((listener) => listener()));
      listeners.clear();
    }
  };
})();
var associationStore = /* @__PURE__ */ (() => {
  const snapshots = /* @__PURE__ */ new Map();
  const listeners = /* @__PURE__ */ new Map();
  return {
    get(workspaceId) {
      return snapshots.get(workspaceId) ?? [];
    },
    set(workspaceId, value) {
      const associations = normalizePullRequestAssociations(value);
      snapshots.set(
        workspaceId,
        Object.entries(associations).flatMap(
          ([reviewKey, tasks]) => tasks.map((task) => ({ providerId: "bitbucket", taskId: task.taskId, reviewKey }))
        )
      );
      listeners.get(workspaceId)?.forEach((listener) => listener());
    },
    subscribe(workspaceId, listener) {
      const workspaceListeners = listeners.get(workspaceId) ?? /* @__PURE__ */ new Set();
      workspaceListeners.add(listener);
      listeners.set(workspaceId, workspaceListeners);
      return () => {
        workspaceListeners.delete(listener);
        if (workspaceListeners.size === 0) listeners.delete(workspaceId);
      };
    },
    clear() {
      snapshots.clear();
      listeners.forEach(
        (workspaceListeners) => workspaceListeners.forEach((listener) => listener())
      );
      listeners.clear();
    }
  };
})();
async function refreshAssociationStore(host, workspaceId, signal) {
  const response = await host.api.invokeAction(
    action.pullRequestsAssociations,
    { workspaceId },
    { signal }
  );
  if (!signal.aborted) associationStore.set(workspaceId, response);
}
async function refreshReviewStore(host, taskId, signal, workspaceId) {
  const pullRequests = await loadTaskPullRequestDetails(
    (key, input, options) => host.api.invokeAction(key, input, options),
    { taskId, ...workspaceId ? { workspaceId } : {} },
    signal
  );
  if (!signal.aborted) reviewStore.set(taskId, pullRequests);
}
function record2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function text(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value : fallback;
}
function useActiveWorkspaceId(host) {
  const { React } = host;
  const [activeWorkspaceId, setActiveWorkspaceId] = React.useState(
    () => activeWorkspaceIdFromState(host.store.getState())
  );
  React.useEffect(() => {
    const sync = () => setActiveWorkspaceId(activeWorkspaceIdFromState(host.store.getState()));
    sync();
    return host.store.subscribe(sync);
  }, [host]);
  return activeWorkspaceId;
}
var SAVED_QUERIES_KEY = "dashboard-saved-queries";
function useSavedQueries(host, workspaceId) {
  const { React } = host;
  const [queries, setQueries] = React.useState([]);
  const load = async () => {
    if (!workspaceId) {
      setQueries([]);
      return;
    }
    const entry = await host.storage.get("workspace", workspaceId, SAVED_QUERIES_KEY);
    setQueries(normalizeSavedQueries(entry?.value));
  };
  React.useEffect(() => {
    if (!workspaceId) {
      setQueries([]);
      return;
    }
    let active = true;
    const sync = async () => {
      const entry = await host.storage.get("workspace", workspaceId, SAVED_QUERIES_KEY);
      if (active) setQueries(normalizeSavedQueries(entry?.value));
    };
    void sync();
    const unsubscribe = host.storage.subscribe(
      { scope: "workspace", scopeId: workspaceId, key: SAVED_QUERIES_KEY },
      () => void sync()
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [host, workspaceId]);
  const persist = async (next) => {
    if (!workspaceId) return;
    const normalized = normalizeSavedQueries(next);
    setQueries(normalized);
    try {
      await host.storage.set("workspace", workspaceId, SAVED_QUERIES_KEY, normalized);
    } catch (error) {
      await load();
      throw error;
    }
  };
  return {
    queries,
    async save(input) {
      const created = newSavedQuery(
        input,
        `saved-${globalThis.crypto.randomUUID()}`,
        (/* @__PURE__ */ new Date()).toISOString()
      );
      await persist([...queries, created]);
      return created;
    },
    remove(id) {
      void persist(queries.filter((query) => query.id !== id));
    }
  };
}
function requestBody(input) {
  if (!input) return void 0;
  return JSON.parse(JSON.stringify(input));
}
function usePluginQuery(host, key, input, enabled = true) {
  const { React } = host;
  const serializedInput = JSON.stringify(input ?? {});
  const [reload, setReload] = React.useState(0);
  const [state, setState] = React.useState({
    data: null,
    loading: enabled,
    error: null,
    lastFetchedAt: null
  });
  React.useEffect(() => {
    let active = true;
    const controller = new AbortController();
    if (!enabled) {
      setState({ data: null, loading: false, error: null, lastFetchedAt: null });
      return () => {
        active = false;
        controller.abort();
      };
    }
    setState((previous) => ({ ...previous, loading: true, error: null }));
    void host.api.invokeAction(key, requestBody(JSON.parse(serializedInput)), {
      signal: controller.signal
    }).then((data) => {
      if (active) setState({ data, loading: false, error: null, lastFetchedAt: /* @__PURE__ */ new Date() });
    }).catch((error) => {
      if (active) setState((previous) => ({ ...previous, loading: false, error: errorMessage(error) }));
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [enabled, host.api, key, reload, serializedInput]);
  const refresh = React.useCallback(() => setReload((value) => value + 1), []);
  return { ...state, refresh };
}
function useAbortableAction(host) {
  const { React } = host;
  const activeController = React.useRef(null);
  React.useEffect(
    () => () => {
      activeController.current?.abort();
    },
    []
  );
  const invoke = async (key, input) => {
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    try {
      const result = await host.api.invokeAction(key, input, { signal: controller.signal });
      if (controller.signal.aborted) throw new DOMException("Request aborted", "AbortError");
      return result;
    } finally {
      if (activeController.current === controller) activeController.current = null;
    }
  };
  return {
    invoke,
    cancel() {
      activeController.current?.abort();
    }
  };
}
function isAbortError(reason) {
  return record2(reason).name === "AbortError";
}
function icon(h2, name) {
  const paths = {
    watch: "M3 12s3.2-5 9-5 9 5 9 5-3.2 5-9 5-9-5-9-5Zm9 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
    back: "m15 18-6-6 6-6"
  };
  return h2(
    "svg",
    {
      viewBox: "0 0 24 24",
      width: 18,
      height: 18,
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.8,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": true
    },
    h2("path", { d: paths[name] ?? paths.back })
  );
}
function pullRequestStateIcon(host, pullRequest) {
  const normalized = pullRequest.state.toLowerCase();
  const merged = normalized === "merged";
  const closed = normalized === "declined" || normalized === "closed";
  return host.jsx(
    host.ui.IntegrationIcon,
    {
      name: merged ? "merged" : closed ? "pull-request-closed" : "pull-request",
      className: `h-4 w-4 ${merged ? "text-purple-600 dark:text-purple-400" : closed ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"}`
    }
  );
}
function Badge(host, label, tone = "neutral") {
  return host.jsx(host.ui.Badge, { className: `bb-badge bb-badge-${tone}` }, label);
}
function EmptyState(host, title, detail, actionLabel, onAction) {
  const { jsx: h2, ui } = host;
  return h2(
    "section",
    { className: "bb-empty", role: "status" },
    h2("h2", null, title),
    h2("p", null, detail),
    actionLabel && onAction ? h2(ui.Button, { type: "button", className: "min-h-11", onClick: onAction }, actionLabel) : null
  );
}
function DisconnectConfirmation({
  host,
  workspaceId,
  onSuccess,
  onCancel
}) {
  const { jsx: h2, ui, React } = host;
  const [disconnecting, setDisconnecting] = React.useState(false);
  const [error, setError] = React.useState(null);
  const disconnect = async () => {
    setDisconnecting(true);
    setError(null);
    try {
      await host.api.invokeAction(action.connectionDisconnect, disconnectConnectionInput(workspaceId));
      onSuccess();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setDisconnecting(false);
    }
  };
  return h2(
    "section",
    { className: "bb-disconnect-confirm" },
    h2("p", null, "Disconnect Bitbucket connection?"),
    h2("p", { className: "bb-capability-note" }, "Stored Bitbucket credentials and connection settings for this workspace will be removed."),
    error ? h2("p", { className: "bb-error", role: "alert" }, error) : null,
    h2(
      "div",
      { className: "bb-card-actions" },
      h2(ui.Button, { type: "button", variant: "outline", className: "min-h-11", disabled: disconnecting, onClick: onCancel }, "Cancel"),
      h2(ui.Button, { type: "button", variant: "destructive", className: "min-h-11", disabled: disconnecting, onClick: () => void disconnect() }, disconnecting ? "Disconnecting\u2026" : "Disconnect Bitbucket")
    )
  );
}
function ConnectionHealth({ host, workspaceId: scopedWorkspaceId }) {
  const { jsx: h2, ui, React } = host;
  const responsive = host.useResponsiveBreakpoint();
  const connection = usePluginQuery(
    host,
    action.connectionGet,
    scopedWorkspaceId ? { workspaceId: scopedWorkspaceId } : void 0,
    Boolean(scopedWorkspaceId)
  );
  const [saving, setSaving] = React.useState(false);
  const [message, setMessage] = React.useState(null);
  const [product, setProduct] = React.useState("cloud");
  const [baseUrl, setBaseUrl] = React.useState("");
  const [cloudWorkspace, setCloudWorkspace] = React.useState("");
  const [authMethod, setAuthMethod] = React.useState("api_token");
  const [token, setToken] = React.useState("");
  const details = record2(connection.data);
  const [identity, setIdentity] = React.useState("");
  const oauthRegistration = connectionOAuthRegistration(details);
  const [oauthClientId, setOAuthClientId] = React.useState("");
  const [oauthClientSecret, setOAuthClientSecret] = React.useState("");
  const oauthCallbackUrl = deriveOAuthCallbackURL(window.location.origin);
  const [disconnectOpen, setDisconnectOpen] = React.useState(false);
  React.useEffect(() => {
    if (!connection.data) return;
    setProduct(text(details.product, "cloud"));
    setBaseUrl(text(details.base_url));
    setCloudWorkspace(text(details.cloud_workspace));
    setAuthMethod(text(details.auth_method, "api_token"));
    setIdentity(text(details.auth_identity));
  }, [connection.data]);
  const state = connectionState(details);
  const identityField = connectionIdentity(product, authMethod);
  const formInput = () => ({ product, baseUrl, cloudWorkspace, authMethod, token, identity, oauthRegistrationConfigured: oauthRegistration.configured, oauthClientId, oauthClientSecret, oauthCallbackUrl });
  const connectionValidationError = () => validateCloudWorkspace(formInput()) ?? validateConnectionIdentity(formInput()) ?? validateOAuthRegistration(formInput());
  const oauthReady = authMethod === "oauth" && !connectionValidationError();
  const label = {
    unconfigured: "Not configured",
    checking: "Checking connection",
    connected: "Connected",
    auth_required: "Authentication required",
    unavailable: "Unavailable"
  };
  const saveConnection = async () => {
    if (!scopedWorkspaceId) return;
    const validationError = connectionValidationError();
    if (validationError) {
      setMessage(validationError);
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      await host.api.invokeAction(action.connectionSave, {
        workspaceId: scopedWorkspaceId,
        body: {
          ...connectionSaveBody(formInput()),
          probe: true
        }
      });
      setToken("");
      setOAuthClientSecret("");
      setMessage("Connection saved and health check started.");
      connection.refresh();
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };
  const startOauth = async () => {
    if (!scopedWorkspaceId) return;
    const validationError = connectionValidationError();
    if (validationError) {
      setMessage(validationError);
      return;
    }
    setSaving(true);
    try {
      await host.api.invokeAction(action.connectionSave, {
        workspaceId: scopedWorkspaceId,
        body: {
          ...connectionSaveBody(formInput()),
          probe: false
        }
      });
      setOAuthClientSecret("");
      const result = await host.api.invokeAction(action.oauthStart, oauthStartInput(scopedWorkspaceId));
      const href = text(record2(result).url) || text(record2(result).authorization_url);
      if (href) window.location.assign(href);
      else setMessage("OAuth authorization is ready. Continue in the connection settings.");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };
  const completeDisconnect = () => {
    setToken("");
    setOAuthClientSecret("");
    setProduct("cloud");
    setBaseUrl("");
    setCloudWorkspace("");
    setAuthMethod("api_token");
    setIdentity("");
    setOAuthClientId("");
    setDisconnectOpen(false);
    setMessage("Bitbucket disconnected. Stored credentials cleared.");
    connection.refresh();
  };
  const openDisconnectConfirmation = () => {
    if (!scopedWorkspaceId) return;
    if (responsive.isMobile) {
      setDisconnectOpen(true);
      return;
    }
    let modal;
    modal = host.openModal({
      title: "Disconnect Bitbucket",
      size: "sm",
      content: () => h2(DisconnectConfirmation, { host, workspaceId: scopedWorkspaceId, onSuccess: () => {
        completeDisconnect();
        modal?.close();
      }, onCancel: () => modal?.close() })
    });
  };
  return h2(
    ui.Card,
    { className: "bb-connection", "data-testid": "bitbucket-connection-health" },
    h2(
      ui.CardHeader,
      null,
      h2("div", { className: "bb-title-row" }, h2(ui.CardTitle, null, "Connection"), Badge(host, label[state], state === "connected" ? "success" : state === "auth_required" ? "warning" : "neutral")),
      h2(ui.CardDescription, null, text(details.product, "Connect Bitbucket Cloud or Data Center for this workspace."))
    ),
    h2(
      ui.CardContent,
      { className: "bb-settings-form" },
      connection.loading ? h2(ui.Spinner, { "aria-label": "Checking Bitbucket connection" }) : null,
      connection.error ? h2("p", { className: "bb-error", role: "alert" }, connection.error) : null,
      message ? h2("p", { className: "bb-message", role: "status" }, message) : null,
      h2(ui.Label, { htmlFor: "bitbucket-product" }, "Bitbucket product"),
      h2(ui.Select, { value: product, onValueChange: (next) => {
        setProduct(next);
        setAuthMethod(next === "cloud" ? "api_token" : "user_pat");
        setCloudWorkspace("");
        setIdentity("");
        setToken("");
        setOAuthClientId("");
        setOAuthClientSecret("");
      } }, h2(ui.SelectTrigger, { id: "bitbucket-product", className: "min-h-11" }, h2(ui.SelectValue, null)), h2(ui.SelectContent, null, h2(ui.SelectItem, { value: "cloud" }, "Bitbucket Cloud"), h2(ui.SelectItem, { value: "data_center" }, "Bitbucket Data Center"))),
      product === "cloud" ? h2("div", { className: "bb-field" }, h2(ui.Label, { htmlFor: "bitbucket-cloud-workspace" }, "Bitbucket workspace"), h2(ui.Input, { id: "bitbucket-cloud-workspace", "data-testid": "bitbucket-cloud-workspace", className: "min-h-11", autoComplete: "organization", value: cloudWorkspace, onChange: (event) => setCloudWorkspace(event.target.value), placeholder: "workspace-slug", "aria-describedby": "bitbucket-cloud-workspace-help" }), h2("p", { id: "bitbucket-cloud-workspace-help", className: "bb-capability-note" }, "Workspace slug or ID from bitbucket.org/workspace; required to list repositories.")) : null,
      product === "data_center" ? h2("div", { className: "bb-field" }, h2(ui.Label, { htmlFor: "bitbucket-base-url" }, "Data Center URL"), h2(ui.Input, { id: "bitbucket-base-url", className: "min-h-11", value: baseUrl, onChange: (event) => setBaseUrl(event.target.value), placeholder: "https://bitbucket.example.com/bitbucket" })) : null,
      h2(ui.Label, { htmlFor: "bitbucket-auth-method" }, "Authentication"),
      h2(ui.Select, { value: authMethod, onValueChange: (next) => {
        setAuthMethod(next);
        if (next === "oauth") setToken("");
        if (next !== "oauth") {
          setOAuthClientId("");
          setOAuthClientSecret("");
        }
      } }, h2(ui.SelectTrigger, { id: "bitbucket-auth-method", className: "min-h-11" }, h2(ui.SelectValue, null)), h2(ui.SelectContent, null, product === "cloud" ? [h2(ui.SelectItem, { value: "api_token" }, "API token"), h2(ui.SelectItem, { value: "oauth" }, "OAuth 2.0")] : [h2(ui.SelectItem, { value: "user_pat" }, "Personal access token"), h2(ui.SelectItem, { value: "project_token" }, "Project access token"), h2(ui.SelectItem, { value: "repository_token" }, "Repository access token"), h2(ui.SelectItem, { value: "oauth" }, "OAuth 2.0")])),
      authMethod !== "oauth" ? h2("div", { className: "bb-field" }, h2(ui.Label, { htmlFor: "bitbucket-token" }, "Access token"), h2(ui.Input, { id: "bitbucket-token", type: "password", className: "min-h-11", autoComplete: "off", value: token, onChange: (event) => setToken(event.target.value), placeholder: "Stored only by Bitbucket secret handling" })) : null,
      identityField ? h2("div", { className: "bb-field" }, h2(ui.Label, { htmlFor: "bitbucket-connection-identity" }, identityField.label), h2(ui.Input, { id: "bitbucket-connection-identity", "data-testid": "bitbucket-connection-identity", type: identityField.inputType, className: "min-h-11", autoComplete: identityField.inputType === "email" ? "email" : "username", value: identity, onChange: (event) => setIdentity(event.target.value), "aria-describedby": "bitbucket-connection-identity-help" }), h2("p", { id: "bitbucket-connection-identity-help", className: "bb-capability-note" }, identityField.help)) : null,
      authMethod === "oauth" ? h2("section", { className: "bb-oauth-registration", "aria-label": "OAuth client registration" }, oauthRegistration.configured ? h2("p", { className: "bb-capability-note", role: "status" }, "OAuth app registration is configured. Enter both values only to replace it.") : null, h2("div", { className: "bb-field" }, h2(ui.Label, { htmlFor: "bitbucket-oauth-client-id" }, oauthRegistration.configured ? "OAuth client ID (optional to replace)" : "OAuth client ID"), h2(ui.Input, { id: "bitbucket-oauth-client-id", "data-testid": "bitbucket-oauth-client-id", className: "min-h-11", autoComplete: "off", value: oauthClientId, onChange: (event) => setOAuthClientId(event.target.value) })), h2("div", { className: "bb-field" }, h2(ui.Label, { htmlFor: "bitbucket-oauth-client-secret" }, oauthRegistration.configured ? "OAuth client secret (optional to replace)" : "OAuth client secret"), h2(ui.Input, { id: "bitbucket-oauth-client-secret", "data-testid": "bitbucket-oauth-client-secret", type: "password", className: "min-h-11", autoComplete: "off", value: oauthClientSecret, onChange: (event) => setOAuthClientSecret(event.target.value), "aria-describedby": "bitbucket-oauth-client-secret-help" }), h2("p", { id: "bitbucket-oauth-client-secret-help", className: "bb-capability-note" }, "Stored only by Bitbucket secret handling. Existing secrets are never displayed.")), h2("div", { className: "bb-field" }, h2(ui.Label, { htmlFor: "bitbucket-oauth-callback-url" }, "OAuth callback URL"), h2(ui.Input, { id: "bitbucket-oauth-callback-url", "data-testid": "bitbucket-oauth-callback-url", type: "url", className: "min-h-11", readOnly: true, value: oauthCallbackUrl, "aria-describedby": "bitbucket-oauth-callback-url-help" }), h2("p", { id: "bitbucket-oauth-callback-url-help", className: "bb-capability-note" }, "Copy this Kandev callback URL into your OAuth app. It is derived from this Kandev origin."))) : null,
      authMethod === "oauth" ? h2(ui.Button, { type: "button", className: "min-h-11", disabled: saving || !oauthReady, onClick: startOauth }, "Connect with OAuth") : null,
      h2(ui.Separator, null),
      h2(
        "div",
        { className: "bb-settings-actions" },
        h2(ui.Button, { type: "button", variant: "outline", className: "min-h-11", disabled: saving, onClick: saveConnection }, "Check connection"),
        h2(ui.Button, { type: "button", variant: "destructive", className: "bb-settings-disconnect min-h-11", disabled: saving || !scopedWorkspaceId, onClick: openDisconnectConfirmation }, "Disconnect Bitbucket")
      ),
      responsive.isMobile && scopedWorkspaceId ? h2(
        ui.Drawer,
        { open: disconnectOpen, onOpenChange: (open) => setDisconnectOpen(open) },
        h2(
          ui.DrawerContent,
          { className: "bb-disconnect-drawer" },
          h2(ui.DrawerHeader, null, h2(ui.DrawerTitle, null, "Disconnect Bitbucket"), h2(ui.DrawerDescription, null, "Remove this workspace Bitbucket connection.")),
          h2("div", { className: "bb-drawer-scroll" }, h2(DisconnectConfirmation, { host, workspaceId: scopedWorkspaceId, onSuccess: completeDisconnect, onCancel: () => setDisconnectOpen(false) }))
        )
      ) : null
    )
  );
}
function taskCreateContext(state, workspaceId) {
  if (!workspaceId) return null;
  const workflowState = record2(state.workflows);
  const workflows = Array.isArray(workflowState.items) ? workflowState.items.map(record2) : [];
  const activeWorkflowId = text(workflowState.activeId);
  const workflow = workflows.find((candidate) => text(candidate.id) === activeWorkflowId && text(candidate.workspaceId) === workspaceId) ?? workflows.find((candidate) => text(candidate.workspaceId) === workspaceId || text(candidate.workspace_id) === workspaceId);
  const workflowId = text(workflow?.id);
  if (!workflowId) return null;
  const kanban = record2(state.kanban);
  const snapshots = record2(record2(state.kanbanMulti).snapshots);
  const snapshot = record2(snapshots[workflowId]);
  const rawSteps = text(kanban.workflowId) === workflowId && Array.isArray(kanban.steps) ? kanban.steps : Array.isArray(snapshot.steps) ? snapshot.steps : [];
  const steps = rawSteps.map(record2).sort((left, right) => Number(left.position ?? 0) - Number(right.position ?? 0)).map((step) => ({ id: text(step.id), title: text(step.title) || text(step.name), ...record2(step.events) ? { events: record2(step.events) } : {} })).filter((step) => step.id && step.title);
  if (!steps[0]) return null;
  const repositoryState = record2(state.repositories);
  const byWorkspace = record2(repositoryState.itemsByWorkspaceId);
  const repositories = Array.isArray(byWorkspace[workspaceId]) ? byWorkspace[workspaceId].map(record2) : [];
  return { workflowId, defaultStepId: steps[0].id, steps, repositories };
}
function matchingHostRepositoryId(repositories, pullRequest) {
  const match = repositories.find((repository) => {
    if (text(repository.provider).toLowerCase() !== "bitbucket") return false;
    return text(repository.provider_repo_id) === pullRequest.repositoryId || pullRequest.url && text(repository.remote_url) && pullRequest.url.includes(text(repository.provider_owner)) && pullRequest.url.includes(text(repository.provider_name));
  });
  return match ? text(match.id) || void 0 : void 0;
}
function DashboardPullRequestList({ host, pullRequests, loading, error, tasksByReview, onStartTask }) {
  const { jsx: h2, ui } = host;
  const presets = taskLaunchPresets();
  return h2(
    "div",
    { "data-testid": "bitbucket-pr-queue" },
    h2(
      ui.ChangeRequestList,
      { loading, error, emptyMessage: "No pull requests match this filter.", isEmpty: pullRequests.length === 0 },
      ...pullRequests.map((pullRequest) => {
        const author = displayPullRequestAuthor(pullRequest.author);
        const opened = relativeTimeLabel(pullRequest.createdAt);
        const metadata = h2(
          "span",
          { className: "bb-change-request-metadata" },
          h2("span", null, `${pullRequest.repositoryId}#${pullRequest.number}`),
          author ? h2("span", null, ` \xB7 by ${author}`) : null,
          opened ? h2("span", null, ` \xB7 opened ${opened}`) : null,
          pullRequest.sourceBranch && pullRequest.destinationBranch ? h2("span", null, ` \xB7 ${pullRequest.sourceBranch} \u2192 ${pullRequest.destinationBranch}`) : null,
          h2("span", null, " \xB7 "),
          Badge(host, pullRequest.statusLabel ?? pullRequest.state, pullRequest.statusTone)
        );
        const tasks = tasksByReview[pullRequest.key] ?? pullRequest.tasks;
        return h2(ui.ChangeRequestRow, {
          key: pullRequest.key,
          stateIcon: pullRequestStateIcon(host, pullRequest),
          title: pullRequest.title,
          href: pullRequest.url,
          metadata,
          taskIndicator: h2(ui.TaskRowIndicator, { tasks, testIdPrefix: `bitbucket-pr-${pullRequest.number}-task` }),
          action: pullRequest.capabilities.includes("launch_task") ? h2(ui.IntegrationStartTaskMenu, {
            presets,
            onSelect: (selected) => {
              const preset = presets.find((candidate) => candidate.id === selected.id);
              if (preset) onStartTask(pullRequest, preset);
            },
            triggerTestId: "bitbucket-start-task-trigger",
            itemTestId: "bitbucket-start-task-preset"
          }) : null,
          testId: "bitbucket-pr-row",
          dataAttributes: { "data-pr-number": pullRequest.number }
        });
      })
    )
  );
}
function ReviewDetailPanel({
  host,
  workspaceId: scopedWorkspaceId,
  taskId,
  reviewKey,
  presentation
}) {
  const { jsx: h2, ui, React } = host;
  const review = usePluginQuery(
    host,
    taskId ? action.pullRequestsGet : action.pullRequestsInspect,
    taskId ? {
      taskId,
      body: {
        review_key: reviewKey,
        include: ["files", "commits", "participants", "threads", "status"]
      }
    } : scopedWorkspaceId ? {
      workspaceId: scopedWorkspaceId,
      body: {
        review_key: reviewKey,
        include: ["files", "commits", "participants", "threads", "status"]
      }
    } : void 0,
    Boolean((taskId || scopedWorkspaceId) && reviewKey)
  );
  const detail = normalizeReviewDetail(review.data);
  const [busyActionId, setBusyActionId] = React.useState(null);
  const [actionError, setActionError] = React.useState(null);
  const request = useAbortableAction(host);
  const runAction = async (requestValue) => {
    if (!detail || !scopedWorkspaceId || busyActionId) return;
    const kind = requestValue.actionId === "comment" ? "add_comment" : requestValue.actionId;
    setBusyActionId(requestValue.actionId);
    setActionError(null);
    try {
      await request.invoke(
        action.reviewsAction,
        workspaceReviewAction(scopedWorkspaceId, detail.key, detail.id, kind, {
          ...requestValue.body ? { comment: requestValue.body } : {},
          ...requestValue.threadId ? { parentCommentId: requestValue.threadId } : {}
        })
      );
      review.refresh();
    } catch (reason) {
      if (!isAbortError(reason)) setActionError(errorMessage(reason));
    } finally {
      setBusyActionId(null);
    }
  };
  return h2(ui.ChangeRequestDetail, {
    detail: detail ? changeRequestDetailModel(detail) : null,
    presentation: presentation ?? "desktop",
    loading: review.loading,
    error: review.error,
    onRefresh: review.refresh,
    onRetry: review.refresh,
    actions: detail ? changeRequestDetailActions(detail) : [],
    busyActionId,
    onAction: runAction,
    notice: actionError ? h2("p", { className: "bb-error", role: "alert" }, actionError) : null
  });
}
function watchPreviewTaskCount(value) {
  const response = record2(value);
  const taskIDs = response.task_ids ?? response.TaskIDs;
  return Array.isArray(taskIDs) ? taskIDs.length : 0;
}
function WatchRow({ host, watch, disabled, run, preview }) {
  const { jsx: h2, ui } = host;
  const toggleKey = watch.status === "running" ? action.watchesPause : action.watchesResume;
  return h2(
    "li",
    { className: "bb-watch-row", key: watch.id },
    h2("div", null, h2("strong", null, watch.id), Badge(host, watch.status, watch.status === "running" ? "success" : "neutral"), watch.lastPolled ? h2("span", null, `Last polled ${watch.lastPolled}`) : null),
    h2(
      "div",
      { className: "bb-secondary-actions" },
      h2(ui.Button, { type: "button", variant: "outline", className: "min-h-11", disabled, onClick: () => run(action.watchesRun, watch.id) }, "Run now"),
      h2(ui.Button, { type: "button", variant: "outline", className: "min-h-11", disabled, onClick: () => run(toggleKey, watch.id) }, watch.status === "running" ? "Pause" : "Resume"),
      h2(ui.Button, { type: "button", variant: "ghost", className: "min-h-11", disabled, onClick: () => preview("reset", watch.id) }, "Reset"),
      h2(ui.Button, { type: "button", variant: "destructive", className: "min-h-11", disabled, onClick: () => preview("delete", watch.id) }, "Delete")
    )
  );
}
function WatchConfirmation({ host, pending, disabled, confirm, cancel }) {
  const { jsx: h2, ui } = host;
  return h2(
    "div",
    { className: "bb-watch-confirm", role: "alert" },
    h2("p", null, `${pending.kind === "delete" ? "Deleting" : "Resetting"} this watch will remove ${pending.taskCount} plugin-owned task${pending.taskCount === 1 ? "" : "s"}. Adopted and manual tasks stay untouched.`),
    h2(
      "div",
      { className: "bb-secondary-actions" },
      h2(ui.Button, { type: "button", variant: "destructive", className: "min-h-11", disabled, onClick: confirm }, `Confirm ${pending.kind}`),
      h2(ui.Button, { type: "button", variant: "outline", className: "min-h-11", disabled, onClick: cancel }, "Cancel")
    )
  );
}
function Watches({ host, workspaceId: scopedWorkspaceId, filter, showCreate = true }) {
  const { jsx: h2, ui, React } = host;
  const watches = usePluginQuery(host, action.watchesGet, scopedWorkspaceId ? { workspaceId: scopedWorkspaceId } : void 0, Boolean(scopedWorkspaceId));
  const [working, setWorking] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [pending, setPending] = React.useState(null);
  const invoke = async (key, body) => {
    if (!scopedWorkspaceId) return null;
    setWorking(key);
    setError(null);
    try {
      const response = await host.api.invokeAction(key, { workspaceId: scopedWorkspaceId, body });
      watches.refresh();
      return response;
    } catch (reason) {
      setError(errorMessage(reason));
      return null;
    } finally {
      setWorking(null);
    }
  };
  const run = (key, watchId) => {
    void invoke(key, { watch_id: watchId });
  };
  const preview = async (kind, watchId) => {
    const key = kind === "reset" ? action.watchesPreviewReset : action.watchesPreviewDelete;
    const response = await invoke(key, { watch_id: watchId });
    if (response) setPending({ watchId, kind, taskCount: watchPreviewTaskCount(response) });
  };
  const confirm = async () => {
    if (!pending) return;
    const key = pending.kind === "reset" ? action.watchesReset : action.watchesDelete;
    const response = await invoke(key, { watch_id: pending.watchId });
    if (response) setPending(null);
  };
  const watchItems = normalizeWatches(watches.data);
  return h2(
    ui.Card,
    { className: "bb-watches" },
    h2(ui.CardHeader, null, h2(ui.CardTitle, null, "Watches"), h2(ui.CardDescription, null, "Poll saved pull-request criteria and create only plugin-owned tasks.")),
    h2(
      ui.CardContent,
      { className: "bb-card-actions" },
      watches.error ? h2("p", { className: "bb-error", role: "alert" }, watches.error) : null,
      error ? h2("p", { className: "bb-error", role: "alert" }, error) : null,
      watchItems.length ? h2("ul", { className: "bb-watch-list" }, ...watchItems.map((watch) => h2(WatchRow, { host, watch, disabled: Boolean(working), run, preview: (kind, watchId) => void preview(kind, watchId) }))) : h2("p", null, "No saved watches."),
      pending ? h2(WatchConfirmation, { host, pending, disabled: Boolean(working), confirm: () => void confirm(), cancel: () => setPending(null) }) : null,
      showCreate ? h2(ui.Button, { type: "button", variant: "outline", className: "min-h-11", disabled: Boolean(working), onClick: () => void invoke(action.watchesUpdate, { enabled: true, filter }) }, icon(h2, "watch"), "Add current filter watch") : null
    )
  );
}
function repositoryFilter(host, repositories, repository, setRepository) {
  const { jsx: h2, ui } = host;
  return h2(
    ui.Select,
    { value: repository || "__all__", onValueChange: (value) => setRepository(value === "__all__" ? "" : value) },
    h2(ui.SelectTrigger, { id: "bitbucket-repository-filter", className: "bb-repository-filter", "aria-label": "Repository" }, h2(ui.SelectValue, { placeholder: "All repositories" })),
    h2(ui.SelectContent, null, h2(ui.SelectItem, { value: "__all__" }, "All repositories"), ...repositories.map((candidate) => h2(ui.SelectItem, { key: candidate.repositoryId, value: candidate.repositoryId }, `${candidate.ownerOrProject}/${candidate.repositoryName}`)))
  );
}
function StateScopeBar({
  host,
  selection,
  savedQueries,
  onSelect,
  onDeleteSaved,
  canSaveCurrent,
  onSaveCurrent
}) {
  const { jsx: h2, ui } = host;
  const presets = [
    { value: "open", label: "Open", iconName: "pull-request", group: "inbox" },
    { value: "all", label: "All", iconName: "filter", group: "inbox" },
    { value: "merged", label: "Merged", iconName: "merged", group: "created" },
    { value: "declined", label: "Declined", iconName: "pull-request-closed", group: "created" }
  ];
  return h2(ui.IntegrationScopeBar, {
    testId: "bitbucket-scope-bar",
    savedMenuTestId: "bitbucket-saved-filters",
    kinds: [{ value: "pull_requests", label: "Pull requests" }],
    selected: selection,
    onSelect,
    presetsByKind: () => presets,
    savedPresets: savedQueries.map((query) => ({
      id: query.id,
      kind: "pull_requests",
      label: query.label
    })),
    onDeleteSaved,
    canSaveCurrent,
    onSaveCurrent
  });
}
function MobileFilters({ host, repositories, repository, setRepository, ...scope }) {
  const { jsx: h2, ui, React } = host;
  const [open, setOpen] = React.useState(false);
  const mobileScope = {
    ...scope,
    onSelect(selection) {
      scope.onSelect(selection);
      setOpen(false);
    },
    onSaveCurrent() {
      setOpen(false);
      scope.onSaveCurrent();
    }
  };
  return h2(
    ui.Sheet,
    { open, onOpenChange: setOpen },
    h2(ui.SheetTrigger, { asChild: true }, h2(ui.Button, { type: "button", variant: "outline", className: "min-h-11", "aria-label": "Open Bitbucket filters" }, h2(ui.IntegrationIcon, { name: "filter", className: "h-4 w-4" }), "Filters")),
    h2(
      ui.SheetContent,
      { side: "left", className: "bb-filter-sheet" },
      h2(ui.SheetHeader, null, h2(ui.SheetTitle, null, "Bitbucket filters"), h2(ui.SheetDescription, null, "Narrow pull requests by repository and state.")),
      h2(
        "div",
        { className: "bb-mobile-filter-fields" },
        h2(StateScopeBar, { host, ...mobileScope }),
        h2(ui.Label, { htmlFor: "bitbucket-repository-filter" }, "Repository"),
        repositoryFilter(host, repositories, repository, setRepository)
      )
    )
  );
}
function useHostStoreState(host) {
  const { React } = host;
  const [state, setState] = React.useState(() => host.store.getState());
  React.useEffect(() => host.store.subscribe(() => setState(host.store.getState())), [host]);
  return state;
}
function ConnectionNotice({ host, connection, workspaceId }) {
  const { jsx: h2, ui } = host;
  if (connection.loading) return h2("div", { className: "bb-connection-loading" }, h2(ui.Spinner, { "aria-label": "Checking Bitbucket connection" }));
  const state = connectionState(record2(connection.data));
  if (state === "connected") return null;
  const checking = state === "checking";
  const message = connection.error ?? (checking ? "Kandev is verifying the saved connection." : "Connect Bitbucket for this workspace to load pull requests.");
  return h2(ui.Alert, { className: "bb-connection-notice" }, h2(ui.AlertTitle, null, checking ? "Checking Bitbucket connection" : "Bitbucket needs attention"), h2(ui.AlertDescription, { className: "bb-notice-content" }, h2("span", null, message), checking ? null : h2(ui.Button, { type: "button", variant: "outline", className: "min-h-11", onClick: () => host.navigate(integrationSettingsHref(workspaceId)) }, "Configure Bitbucket")));
}
function BitbucketPage({ host }) {
  const { jsx: h2, ui, React } = host;
  const responsive = host.useResponsiveBreakpoint();
  const activeWorkspaceId = useActiveWorkspaceId(host);
  const hostState = useHostStoreState(host);
  const initialQuery = pullRequestScopeQuery("open");
  const [searchDraft, setSearchDraft] = React.useState(initialQuery);
  const [search, setSearch] = React.useState(initialQuery);
  const [state, setState] = React.useState("open");
  const [repository, setRepository] = React.useState("");
  const [scopeSelection, setScopeSelection] = React.useState({
    kind: "pull_requests",
    source: "preset",
    id: "open"
  });
  const [saveDialogOpen, setSaveDialogOpen] = React.useState(false);
  const savedQueries = useSavedQueries(host, activeWorkspaceId);
  const [launch, setLaunch] = React.useState(null);
  const pluginCreatedTaskIDs = React.useRef(/* @__PURE__ */ new Set());
  const connection = usePluginQuery(
    host,
    action.connectionGet,
    activeWorkspaceId ? { workspaceId: activeWorkspaceId } : void 0,
    Boolean(activeWorkspaceId)
  );
  const connected = connectionState(record2(connection.data)) === "connected";
  const repositoriesQuery = usePluginQuery(host, action.repositoriesList, activeWorkspaceId ? { workspaceId: activeWorkspaceId } : void 0, Boolean(activeWorkspaceId && connected));
  const repositories = normalizeRepositories(repositoriesQuery.data);
  const selectedRepository = repositories.find((candidate) => candidate.repositoryId === repository) ?? null;
  const queueRequest = pullRequestListRequest(selectedRepository, search, state);
  const queue = usePluginQuery(
    host,
    queueRequest.actionKey,
    activeWorkspaceId ? { workspaceId: activeWorkspaceId, body: queueRequest.body } : void 0,
    Boolean(activeWorkspaceId && connected)
  );
  const pullRequests = normalizePullRequests(queue.data);
  const associations = usePluginQuery(
    host,
    action.pullRequestsAssociations,
    activeWorkspaceId ? { workspaceId: activeWorkspaceId, body: { review_keys: pullRequests.map((pullRequest) => pullRequest.key) } } : void 0,
    Boolean(activeWorkspaceId && connected && pullRequests.length)
  );
  const tasksByReview = normalizePullRequestAssociations(associations.data);
  const createContext = taskCreateContext(hostState, activeWorkspaceId);
  const noWorkspace = !activeWorkspaceId;
  const commitSearch = () => {
    const committed = searchDraft.trim();
    setSearch(committed);
    setState(parsePullRequestListQuery(committed, state).state);
  };
  const selectScopeState = (nextState) => {
    const query = pullRequestScopeQuery(nextState);
    setState(nextState);
    setSearchDraft(query);
    setSearch(query);
    setScopeSelection({ kind: "pull_requests", source: "preset", id: nextState });
  };
  const selectDashboardScope = (selection) => {
    if (selection.source === "preset") {
      selectScopeState(selection.id);
      return;
    }
    const saved = savedQueries.queries.find((query) => query.id === selection.id);
    if (!saved) return;
    setScopeSelection(selection);
    setSearchDraft(saved.query);
    setSearch(saved.query);
    setState(saved.state);
    setRepository(saved.repositoryId);
  };
  const deleteSavedQuery = (id) => {
    savedQueries.remove(id);
    if (scopeSelection.source === "saved" && scopeSelection.id === id) selectScopeState("open");
  };
  const saveCurrentQuery = async (label, defaultRepositoryId) => {
    const query = searchDraft.trim();
    const parsed = parsePullRequestListQuery(query, state);
    const created = await savedQueries.save({
      label,
      query,
      repositoryId: defaultRepositoryId,
      state: parsed.state
    });
    setSearch(query);
    setState(parsed.state);
    setScopeSelection({ kind: "pull_requests", source: "saved", id: created.id });
    setRepository(defaultRepositoryId);
  };
  const canSaveCurrent = canSaveDashboardQuery(searchDraft, repository);
  const scopeProps = {
    selection: scopeSelection,
    savedQueries: savedQueries.queries,
    onSelect: selectDashboardScope,
    onDeleteSaved: deleteSavedQuery,
    canSaveCurrent,
    onSaveCurrent: () => {
      if (canSaveCurrent) setSaveDialogOpen(true);
    }
  };
  const finishTaskCreation = async (taskValue) => {
    const taskId = text(record2(taskValue).id);
    if (!activeWorkspaceId || !launch || !taskId) return;
    const linkedByLaunch = pluginCreatedTaskIDs.current.delete(taskId);
    try {
      if (!linkedByLaunch) {
        await host.api.invokeAction(action.pullRequestsLink, {
          workspaceId: activeWorkspaceId,
          taskId,
          body: { review_key: launch.pullRequest.key, pull_request_id: launch.pullRequest.id }
        });
      }
      associations.refresh();
    } catch {
    } finally {
      setLaunch(null);
      host.navigate(`/tasks/${encodeURIComponent(taskId)}`);
    }
  };
  const selectedHostRepositoryId = launch && createContext ? matchingHostRepositoryId(createContext.repositories, launch.pullRequest) : void 0;
  const launchRemoteRepository = launch ? repositories.find((candidate) => candidate.repositoryId === launch.pullRequest.repositoryId) : void 0;
  const createBitbucketTask = async (payload) => {
    if (!activeWorkspaceId || !launch) throw new Error("Bitbucket task launch is unavailable.");
    const result = await host.api.invokeAction(action.tasksLaunch, {
      workspaceId: activeWorkspaceId,
      body: taskLaunchBody(launch.pullRequest, payload, launch.launchId)
    });
    const task = taskFromLaunchResult(result);
    const taskId = text(task.id);
    if (task.bitbucketLinked === true) pluginCreatedTaskIDs.current.add(taskId);
    associations.refresh();
    return task;
  };
  const taskDialog = launch && createContext ? h2(ui.TaskCreateDialog, {
    open: true,
    onOpenChange: (open) => {
      if (!open) setLaunch(null);
    },
    mode: "create",
    workspaceId: activeWorkspaceId ?? null,
    workflowId: createContext.workflowId,
    defaultStepId: createContext.defaultStepId,
    steps: createContext.steps,
    initialValues: taskDialogInitialValues(
      launch.pullRequest,
      launch.preset,
      selectedHostRepositoryId,
      launchRemoteRepository
    ),
    createTask: usePluginTaskCreation(selectedHostRepositoryId) ? createBitbucketTask : void 0,
    onSuccess: (task) => void finishTaskCreation(task)
  }) : null;
  const filter = responsive.isMobile ? h2(MobileFilters, { host, repositories, repository, setRepository, ...scopeProps }) : repositoryFilter(host, repositories, repository, setRepository);
  const workbenchBody = !connected ? null : [
    responsive.isMobile ? null : h2(StateScopeBar, { host, ...scopeProps }),
    h2(ui.IntegrationListToolbar, {
      title: "Pull requests",
      count: pullRequests.length,
      loading: queue.loading,
      lastFetchedAt: queue.lastFetchedAt,
      customQuery: searchDraft,
      committedQuery: search,
      onCustomQueryChange: setSearchDraft,
      onCommitCustomQuery: commitSearch,
      onRefresh: queue.refresh,
      filter,
      queryPlaceholder: 'Custom query \u2014 press Enter. e.g. "state:open fix login"',
      titleTestId: "bitbucket-list-toolbar",
      queryTestId: "bitbucket-list-query",
      refreshTestId: "bitbucket-list-refresh"
    }),
    h2(
      "section",
      { className: "bb-results", "data-testid": "bitbucket-results", "aria-label": "Pull request results" },
      h2(DashboardPullRequestList, {
        host,
        pullRequests,
        loading: queue.loading,
        error: queue.error,
        tasksByReview,
        onStartTask: (pullRequest, preset) => setLaunch({
          pullRequest,
          preset,
          launchId: globalThis.crypto.randomUUID()
        })
      })
    ),
    taskDialog,
    h2(ui.IntegrationSaveQueryDialog, {
      open: saveDialogOpen,
      onOpenChange: setSaveDialogOpen,
      description: "Save this Bitbucket pull-request search for the current workspace.",
      suggestedLabel: searchDraft.trim() || (repository ? "Repository pull requests" : "Saved query"),
      query: searchDraft,
      repositoryId: repository,
      repositoryOptions: repositories.map((candidate) => ({
        value: candidate.repositoryId,
        label: `${candidate.ownerOrProject}/${candidate.repositoryName}`
      })),
      onSave: saveCurrentQuery
    })
  ];
  return h2(
    "main",
    { className: `bb-workbench ${responsive.isMobile ? "bb-mobile" : "bb-desktop"}`, "data-testid": "bitbucket-workbench" },
    noWorkspace ? EmptyState(host, "Choose a workspace", "Open Bitbucket from a workspace to connect and browse pull requests.") : [h2(ConnectionNotice, { host, connection, workspaceId: activeWorkspaceId }), workbenchBody]
  );
}
function registerNativeIntegrations(registry, host) {
  registry.registerRepositoryProvider({
    id: "bitbucket",
    label: "Bitbucket",
    icon: "bitbucket",
    async listRepositories({ workspaceId: scopedWorkspaceId, signal }) {
      const response = await host.api.invokeAction(action.repositoriesList, { workspaceId: scopedWorkspaceId }, { signal });
      if (signal.aborted) return [];
      return normalizeRepositories(response);
    },
    matchesURL(url) {
      return /(?:^git@bitbucket\.org:|^https?:\/\/[^/]*bitbucket[^/]*\/|\/scm\/)/i.test(url);
    },
    async listBranches({ workspaceId: scopedWorkspaceId, repository, signal }) {
      const response = await host.api.invokeAction(action.repositoriesBranches, { workspaceId: scopedWorkspaceId, body: { repository: pluginRepositoryInput(repository) } }, { signal });
      if (signal.aborted) return [];
      const branches = record2(response).branches;
      return Array.isArray(branches) ? branches : [];
    },
    async inspectURL({ workspaceId: scopedWorkspaceId, url, signal }) {
      const response = await host.api.invokeAction(action.repositoriesInspect, { workspaceId: scopedWorkspaceId, body: { url } }, { signal });
      return signal.aborted ? null : normalizeRepositoryInspection(response);
    },
    supportsDraft: false,
    async createChangeRequest({
      workspaceId,
      taskId,
      sessionId,
      repositoryId,
      title,
      body,
      baseBranch,
      signal
    }) {
      const response = await host.api.invokeAction(
        action.pullRequestsCreate,
        {
          workspaceId,
          taskId,
          sessionId,
          repositoryId,
          body: {
            title,
            description: body,
            ...baseBranch ? { destination: baseBranch } : {}
          }
        },
        { signal }
      );
      void Promise.all([
        refreshReviewStore(host, taskId, new AbortController().signal, workspaceId),
        refreshAssociationStore(host, workspaceId, new AbortController().signal)
      ]).catch(() => void 0);
      return {
        url: text(response.url),
        provider: "bitbucket"
      };
    }
  });
  registry.registerTaskAction({
    id: "link-pull-request",
    label: "Bitbucket Pull Request",
    icon: "bitbucket",
    placement: "link",
    async run(context) {
      host.openTaskLinkDialog({
        title: "Link Bitbucket pull request",
        description: "Use a Bitbucket pull request URL or canonical key for this task.",
        inputLabel: "Pull request",
        placeholder: "workspace/repository#42",
        emptyError: "Enter a Bitbucket pull request URL or key.",
        failureMessage: "Failed to link Bitbucket pull request.",
        successMessage: "Bitbucket pull request linked",
        inputTestId: "bitbucket-review-reference",
        errorTestId: "bitbucket-review-reference-error",
        submitTestId: "bitbucket-review-reference-submit",
        async onSubmit(reference) {
          const body = linkPullRequestBody(reference);
          if (!body) throw new Error("Enter a Bitbucket pull request URL or key.");
          await host.api.invokeAction(action.pullRequestsLink, {
            workspaceId: context.workspaceId,
            taskId: context.taskId,
            body
          });
          void refreshReviewStore(
            host,
            context.taskId,
            new AbortController().signal,
            context.workspaceId
          ).catch(() => void 0);
          void refreshAssociationStore(
            host,
            context.workspaceId,
            new AbortController().signal
          ).catch(() => void 0);
        }
      });
    }
  });
  registry.registerReviewProvider({
    id: "bitbucket",
    label: "Bitbucket",
    icon: "bitbucket",
    changeRequestNoun: "pull request",
    order: 30,
    getSnapshot: (taskId) => reviewStore.get(taskId),
    subscribe: (taskId, listener) => reviewStore.subscribe(taskId, listener),
    async refresh(taskId, signal) {
      await refreshReviewStore(host, taskId, signal);
    },
    getAssociationSnapshot: (workspaceId) => associationStore.get(workspaceId),
    subscribeAssociations: (workspaceId, listener) => associationStore.subscribe(workspaceId, listener),
    async refreshAssociations(workspaceId, signal) {
      await refreshAssociationStore(host, workspaceId, signal);
    },
    async unlink({ workspaceId, taskId, reviewKey, signal }) {
      await host.api.invokeAction(
        action.pullRequestsUnlink,
        { workspaceId, taskId, body: { review_key: reviewKey } },
        { signal }
      );
    },
    ReviewPanel: (props = {}) => h(ReviewDetailPanel, {
      host,
      workspaceId: text(props.workspaceId) || void 0,
      taskId: text(props.taskId) || void 0,
      reviewKey: text(props.reviewKey),
      presentation: text(props.presentation) === "mobile" ? "mobile" : "desktop"
    })
  });
}
function makeIntegrationSettings(host) {
  return function IntegrationSettings(props = {}) {
    const activeWorkspaceId = useActiveWorkspaceId(host);
    const scopedWorkspaceId = text(props.workspaceId) || activeWorkspaceId;
    return host.jsx("div", { className: "bb-plugin-settings" }, host.jsx(ConnectionHealth, { host, workspaceId: scopedWorkspaceId }), host.jsx(Watches, { host, workspaceId: scopedWorkspaceId, filter: {}, showCreate: false }));
  };
}
function makeTopbarActions(host) {
  return function TopbarActions() {
    const activeWorkspaceId = useActiveWorkspaceId(host);
    return host.jsx(host.ui.Button, { type: "button", variant: "ghost", size: "sm", className: "bb-topbar-settings", "aria-label": "Open Bitbucket settings", onClick: () => host.navigate(integrationSettingsHref(activeWorkspaceId)) }, "Settings");
  };
}
var h = (type, props, ...children) => currentHost?.jsx(type, props, ...children);
var currentHost = null;
window.registerKandevPlugin(PLUGIN_ID, {
  initialize(registry, host) {
    currentHost = host;
    registry.registerNavItem({ id: "bitbucket", label: "Bitbucket", path: "/bitbucket", icon: "bitbucket", section: "integrations" });
    registry.registerRoute("/bitbucket", () => host.jsx(BitbucketPage, { host }), { topbar: { title: "Bitbucket", subtitle: "Pull requests", icon: "bitbucket", actions: makeTopbarActions(host) } });
    registry.registerIntegrationSettings({
      id: "bitbucket",
      label: "Bitbucket",
      description: "Connect Bitbucket Cloud or Data Center for this workspace.",
      icon: "bitbucket",
      Component: makeIntegrationSettings(host)
    });
    registerNativeIntegrations(registry, host);
  },
  destroy() {
    reviewStore.clear();
    associationStore.clear();
    currentHost = null;
  }
});

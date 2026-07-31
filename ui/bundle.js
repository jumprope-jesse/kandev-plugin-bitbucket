// ui/src/view-models.ts
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
function normalizeReviewComment(value) {
  const comment = record(value);
  const id = string(comment.id) ?? string(comment.ID) ?? string(comment.comment_id);
  if (!id) return null;
  const normalized = {
    id,
    author: string(comment.author) ?? string(comment.Author) ?? string(record(comment.author).display_name) ?? "Unknown",
    body: string(comment.body) ?? string(comment.Body) ?? string(comment.content) ?? ""
  };
  const parentId = string(comment.parent_id) ?? string(comment.parentId) ?? string(comment.ParentID);
  const createdAt = string(comment.created_at) ?? string(comment.createdAt) ?? string(comment.When);
  if (parentId) normalized.parentId = parentId;
  if (createdAt) normalized.createdAt = createdAt;
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
function taskSupportsBitbucketRepository(taskRepositories) {
  const providers = taskRepositories.map((repository) => {
    const source = record(repository);
    return string(source.provider_id) ?? string(source.providerId) ?? string(source.provider);
  }).flatMap((provider) => provider ? [provider.toLowerCase()] : []);
  return providers.length === 0 || providers.includes("bitbucket");
}
function pullRequestCreateBody(input) {
  const body = {};
  const title = input.title.trim();
  const description = input.description.trim();
  const destination = input.destination.trim();
  if (title) body.title = title;
  if (description) body.description = description;
  if (destination) body.destination = destination;
  if (input.closeSourceOnMerge) body.close_source_on_merge = true;
  return body;
}
function workspacePullRequestAction(workspaceId, reviewKey, pullRequestID, operation) {
  const body = { review_key: reviewKey, pull_request_id: pullRequestID };
  if (operation) body.operation = operation;
  return { workspaceId, body };
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
function normalizePullRequests(value) {
  return itemList(value, ["pull_requests", "pullRequests", "items", "values"]).map((item) => {
    const source = record(item);
    const id = string(source.id) ?? string(source.key) ?? string(source.uuid) ?? String(number(source.number) ?? number(source.id) ?? "");
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
      capabilities: toCapabilities(source.capabilities)
    };
  }).flatMap((item) => item ? [item] : []);
}
function normalizeReviewDetail(value) {
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
      return path ? [{ path, status: string(file.status) ?? "modified", additions: number(file.additions), deletions: number(file.deletions), patch: string(file.patch) }] : [];
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
      const comments = itemList(thread.comments, ["items", "values"]).flatMap((comment) => {
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
        comments: comments.length > 0 ? comments : [{ id, author: string(thread.author) ?? string(record(thread.author).display_name) ?? "Unknown", body: string(thread.body) ?? string(thread.content) ?? "" }]
      }];
    }),
    statuses: itemList(source.statuses, ["items", "values"]).flatMap((entry) => {
      const status = record(entry);
      const key = string(status.key) ?? string(status.id);
      const name = string(status.name) ?? key;
      const state = string(status.state);
      return key && name && state ? [{ key, name, state, url: string(status.url), target: string(status.target) }] : [];
    })
  };
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
function currentWatchFilter(query, state) {
  return { query: query.trim(), states: state === "all" ? [] : [state] };
}
function launchPresets() {
  return [
    { id: "default", name: "Default" },
    { id: "review", name: "Review and test" },
    { id: "implement", name: "Implement change" }
  ];
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
  pullRequestsQueue: "pullrequests.queue",
  pullRequestsGet: "pullrequests.get",
  pullRequestsInspect: "pullrequests.inspect",
  pullRequestsLaunch: "pullrequests.launch",
  pullRequestsLink: "pullrequests.link",
  pullRequestsUnlink: "pullrequests.unlink",
  pullRequestsCreate: "pullrequests.create",
  reviewsAction: "reviews.action",
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
      snapshots.set(
        taskId,
        pullRequests.map((pullRequest) => ({
          providerId: "bitbucket",
          reviewKey: pullRequest.key,
          title: pullRequest.title,
          url: pullRequest.url,
          repositoryId: pullRequest.repositoryId,
          state: pullRequest.state,
          statusBadge: pullRequest.statusLabel ? { label: pullRequest.statusLabel, tone: pullRequest.statusTone } : void 0
        }))
      );
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
    error: null
  });
  React.useEffect(() => {
    let active = true;
    const controller = new AbortController();
    if (!enabled) {
      setState({ data: null, loading: false, error: null });
      return () => {
        active = false;
        controller.abort();
      };
    }
    setState((previous) => ({ ...previous, loading: true, error: null }));
    void host.api.invokeAction(key, requestBody(JSON.parse(serializedInput)), {
      signal: controller.signal
    }).then((data) => {
      if (active) setState({ data, loading: false, error: null });
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
    bitbucket: "M5 4h14l-1.6 15H6.6L5 4Zm4 4 1.2 7h3.6L15 8H9Z",
    filter: "M4 6h16M7 12h10m-7 6h4",
    plus: "M12 5v14M5 12h14",
    link: "M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1",
    refresh: "M20 11a8 8 0 1 0 2 5.2M20 4v7h-7",
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
    h2("path", { d: paths[name] ?? paths.bitbucket })
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
      { className: "bb-card-actions" },
      connection.loading ? h2(ui.Spinner, { "aria-label": "Checking Bitbucket connection" }) : null,
      connection.error ? h2("p", { className: "bb-error", role: "alert" }, connection.error) : null,
      message ? h2("p", { className: "bb-message", role: "status" }, message) : null,
      h2(ui.Button, { type: "button", variant: "outline", className: "min-h-11", disabled: saving, onClick: saveConnection }, "Check connection"),
      h2(ui.Button, { type: "button", variant: "outline", className: "min-h-11", disabled: saving || !scopedWorkspaceId, onClick: openDisconnectConfirmation }, "Disconnect Bitbucket"),
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
function QueueList({
  host,
  pullRequests,
  selectedKey,
  onSelect
}) {
  const { jsx: h2 } = host;
  return h2(
    "ul",
    { className: "bb-queue", "data-testid": "bitbucket-pr-queue" },
    ...pullRequests.map(
      (pullRequest) => h2(
        "li",
        { key: pullRequest.key },
        h2(
          "button",
          {
            type: "button",
            className: `bb-queue-row ${selectedKey === pullRequest.key ? "is-selected" : ""}`,
            "aria-current": selectedKey === pullRequest.key ? "page" : void 0,
            onClick: () => onSelect(pullRequest)
          },
          h2("span", { className: "bb-queue-title" }, `#${pullRequest.number} ${pullRequest.title}`),
          h2("span", { className: "bb-queue-meta" }, `${pullRequest.repositoryName} \xB7 ${pullRequest.author ?? "Unknown"}`),
          h2("span", { className: "bb-queue-status" }, Badge(host, pullRequest.statusLabel ?? pullRequest.state, pullRequest.statusTone))
        )
      )
    )
  );
}
function RepositoryBrowser({ host, workspaceId, onChoose }) {
  const { jsx: h2, ui } = host;
  const query = usePluginQuery(host, action.repositoriesList, workspaceId ? { workspaceId } : void 0, Boolean(workspaceId));
  const repositories = normalizeRepositories(query.data);
  return h2(
    ui.Card,
    { className: "bb-repositories", "data-testid": "bitbucket-repository-browser" },
    h2(ui.CardHeader, null, h2(ui.CardTitle, null, "Repositories"), h2(ui.CardDescription, null, "Browse connected Bitbucket repositories or filter the pull-request queue.")),
    h2(
      ui.CardContent,
      { className: "bb-card-actions" },
      query.error ? h2("p", { className: "bb-error", role: "alert" }, query.error) : null,
      query.loading ? h2(ui.Spinner, { "aria-label": "Loading Bitbucket repositories" }) : null,
      !query.loading && !repositories.length ? h2("p", { className: "bb-capability-note" }, "No repositories available for this connection.") : null,
      repositories.length ? h2(
        "ul",
        { className: "bb-repository-list" },
        ...repositories.map(
          (repository) => h2(
            "li",
            { key: repository.repositoryId },
            h2(
              ui.Button,
              { type: "button", variant: "ghost", className: "min-h-11", onClick: () => onChoose(repository.repositoryName) },
              h2("span", null, `${repository.ownerOrProject}/${repository.repositoryName}`),
              repository.defaultBranch ? h2("small", null, repository.defaultBranch) : null
            )
          )
        )
      ) : null
    )
  );
}
function PullRequestActions({ host, pullRequest, workspaceId, taskId, onChanged }) {
  const { jsx: h2, ui, React } = host;
  const [working, setWorking] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [comment, setComment] = React.useState("");
  const request = useAbortableAction(host);
  const invoke = async (key, resourceInput) => {
    if (!workspaceId) return;
    setWorking(key);
    setError(null);
    try {
      await request.invoke(key, resourceInput);
      onChanged();
      if (key === action.reviewsAction) setComment("");
    } catch (reason) {
      if (!isAbortError(reason)) setError(errorMessage(reason));
    } finally {
      setWorking(null);
    }
  };
  const runTaskAction = (key) => {
    if (!workspaceId) return;
    return invoke(key, key === action.pullRequestsLink ? { workspaceId, taskId, body: { review_key: pullRequest.key, pull_request_id: pullRequest.id } } : workspacePullRequestAction(workspaceId, pullRequest.key, pullRequest.id));
  };
  const runReviewAction = (kind, nextComment) => {
    if (!workspaceId) return;
    return invoke(
      action.reviewsAction,
      workspaceReviewAction(workspaceId, pullRequest.key, pullRequest.id, kind, { comment: nextComment })
    );
  };
  const can = (capability) => pullRequest.capabilities.includes(capability);
  const isMobile = host.useResponsiveBreakpoint().isMobile;
  const stopWaiting = () => h2(ui.Button, { type: "button", variant: "outline", className: "min-h-11", onClick: request.cancel }, "Stop waiting");
  const secondaryActions = h2(
    "div",
    { className: "bb-secondary-actions" },
    isMobile && working ? stopWaiting() : null,
    taskId && can("link") ? h2(ui.Button, { type: "button", variant: "outline", className: "min-h-11", disabled: Boolean(working), onClick: () => void runTaskAction(action.pullRequestsLink) }, "Link to task") : null,
    can("approve") ? h2(ui.Button, { type: "button", variant: "outline", className: "min-h-11", disabled: Boolean(working), onClick: () => void runReviewAction("approve") }, "Approve") : null,
    can("approve") ? h2(ui.Button, { type: "button", variant: "ghost", className: "min-h-11", disabled: Boolean(working), onClick: () => void runReviewAction("unapprove") }, "Remove approval") : null,
    can("merge") ? h2(ui.Button, { type: "button", variant: "outline", className: "min-h-11", disabled: Boolean(working), onClick: () => void runReviewAction("merge") }, "Merge") : null,
    can("decline") ? h2(ui.Button, { type: "button", variant: "ghost", className: "min-h-11", disabled: Boolean(working), onClick: () => void runReviewAction("decline") }, "Decline") : null
  );
  return h2(
    "div",
    { className: "bb-review-actions" },
    error ? h2("p", { className: "bb-error", role: "alert" }, error) : null,
    working ? stopWaiting() : null,
    can("launch_task") ? h2(ui.Button, { type: "button", className: "min-h-11", disabled: Boolean(working), onClick: () => void runTaskAction(action.pullRequestsLaunch) }, working === action.pullRequestsLaunch ? "Launching\u2026" : "Launch task") : null,
    isMobile ? h2(ui.Drawer, null, h2(ui.DrawerTrigger, { asChild: true }, h2(ui.Button, { type: "button", variant: "outline", className: "min-h-11" }, "Review actions")), h2(ui.DrawerContent, { className: "bb-actions-drawer" }, h2(ui.DrawerHeader, null, h2(ui.DrawerTitle, null, "Pull request actions"), h2(ui.DrawerDescription, null, "Actions available for this Bitbucket pull request.")), h2("div", { className: "bb-drawer-scroll" }, secondaryActions))) : secondaryActions,
    can("comments") ? h2("form", { className: "bb-review-comment", onSubmit: (event) => {
      event.preventDefault();
      if (comment.trim()) void runReviewAction("add_comment", comment);
    } }, h2(ui.Label, { htmlFor: `bitbucket-comment-${pullRequest.id}` }, "Add review comment"), h2(ui.Textarea, { id: `bitbucket-comment-${pullRequest.id}`, className: "min-h-11", value: comment, onChange: (event) => setComment(event.target.value) }), h2(ui.Button, { type: "submit", variant: "outline", className: "min-h-11", disabled: Boolean(working) || !comment.trim() }, "Comment")) : null,
    !pullRequest.capabilities.length ? h2("p", { className: "bb-capability-note" }, "This Bitbucket server did not report available review actions.") : null
  );
}
function ThreadReply({ host, workspaceId, pullRequest, threadId, onChanged }) {
  const { jsx: h2, ui, React } = host;
  const [comment, setComment] = React.useState("");
  const [error, setError] = React.useState(null);
  const [working, setWorking] = React.useState(false);
  const request = useAbortableAction(host);
  if (!workspaceId) return null;
  const submit = async () => {
    if (!comment.trim()) return;
    setWorking(true);
    setError(null);
    try {
      await request.invoke(action.reviewsAction, workspaceReviewAction(
        workspaceId,
        pullRequest.key,
        pullRequest.id,
        "reply",
        { comment, parentCommentId: threadId }
      ));
      setComment("");
      onChanged();
    } catch (reason) {
      if (!isAbortError(reason)) setError(errorMessage(reason));
    } finally {
      setWorking(false);
    }
  };
  return h2("form", { className: "bb-thread-reply", onSubmit: (event) => {
    event.preventDefault();
    void submit();
  } }, error ? h2("p", { className: "bb-error", role: "alert" }, error) : null, h2(ui.Label, { htmlFor: `bitbucket-reply-${threadId}` }, "Reply"), h2(ui.Textarea, { id: `bitbucket-reply-${threadId}`, className: "min-h-11", value: comment, onChange: (event) => setComment(event.target.value) }), h2(ui.Button, { type: "submit", variant: "outline", className: "min-h-11", disabled: working || !comment.trim() }, working ? "Replying\u2026" : "Reply"), working ? h2(ui.Button, { type: "button", variant: "ghost", className: "min-h-11", onClick: request.cancel }, "Stop waiting") : null);
}
function ReviewDetailPanel({ host, workspaceId: scopedWorkspaceId, taskId, reviewKey, onBack }) {
  const { jsx: h2, ui, React } = host;
  const review = usePluginQuery(
    host,
    taskId ? action.pullRequestsGet : action.pullRequestsInspect,
    taskId ? { taskId, body: { review_key: reviewKey, include: ["files", "commits", "participants", "threads", "status"] } } : scopedWorkspaceId ? { workspaceId: scopedWorkspaceId, body: { review_key: reviewKey, include: ["files", "commits", "participants", "threads", "status"] } } : void 0,
    Boolean((taskId || scopedWorkspaceId) && reviewKey)
  );
  const [tab, setTab] = React.useState("files");
  const detail = normalizeReviewDetail(review.data);
  if (review.loading && !detail) return h2("div", { className: "bb-detail-loading" }, h2(ui.Spinner, { "aria-label": "Loading pull request" }));
  if (review.error) return EmptyState(host, "Could not load pull request", review.error, "Retry", review.refresh);
  if (!detail) return EmptyState(host, "Select a pull request", "Choose a Bitbucket pull request from the queue to inspect its review.");
  return h2(
    "section",
    { className: "bb-review-detail", "data-testid": "bitbucket-review-detail" },
    onBack ? h2(ui.Button, { type: "button", variant: "ghost", className: "bb-back min-h-11", onClick: onBack, "aria-label": "Back to pull request queue" }, icon(h2, "back"), "Queue") : null,
    h2("header", { className: "bb-detail-header" }, h2("div", null, h2("p", { className: "bb-eyebrow" }, `${detail.repositoryName} \xB7 #${detail.number}`), h2("h1", null, detail.title), detail.description ? h2("p", null, detail.description) : null), Badge(host, detail.statusLabel ?? detail.state, detail.statusTone)),
    h2("p", { className: "bb-branches" }, `${detail.sourceBranch ?? "source"} \u2192 ${detail.destinationBranch ?? "destination"}`),
    h2(PullRequestActions, { host, pullRequest: detail, workspaceId: scopedWorkspaceId, taskId, onChanged: review.refresh }),
    h2(
      ui.Tabs,
      { value: tab, onValueChange: setTab, className: "bb-review-tabs" },
      h2(ui.TabsList, { className: "bb-tabs-list min-h-11", "aria-label": "Pull request detail" }, h2(ui.TabsTrigger, { value: "files", className: "min-h-11" }, `Files (${detail.files.length})`), h2(ui.TabsTrigger, { value: "commits", className: "min-h-11" }, `Commits (${detail.commits.length})`), h2(ui.TabsTrigger, { value: "people", className: "min-h-11" }, `People (${detail.participants.length})`), h2(ui.TabsTrigger, { value: "threads", className: "min-h-11" }, `Threads (${detail.threads.length})`), h2(ui.TabsTrigger, { value: "builds", className: "min-h-11" }, `Builds (${detail.statuses.length})`)),
      h2(
        ui.TabsContent,
        { value: "files" },
        h2(
          "ul",
          { className: "bb-detail-list" },
          ...detail.files.map(
            (file) => h2(
              "li",
              { key: file.path },
              h2("strong", null, file.path),
              h2("span", null, `${file.status}${file.additions !== void 0 ? ` \xB7 +${file.additions}` : ""}${file.deletions !== void 0 ? ` / -${file.deletions}` : ""}`),
              file.patch ? h2("pre", { className: "bb-patch" }, file.patch) : null
            )
          )
        )
      ),
      h2(
        ui.TabsContent,
        { value: "commits" },
        h2(
          "ul",
          { className: "bb-detail-list" },
          ...detail.commits.map(
            (commit) => h2("li", { key: commit.id }, h2("strong", null, commit.message), h2("span", null, `${commit.id.slice(0, 8)}${commit.author ? ` \xB7 ${commit.author}` : ""}`))
          )
        )
      ),
      h2(
        ui.TabsContent,
        { value: "people" },
        h2(
          "ul",
          { className: "bb-detail-list" },
          ...detail.participants.map(
            (person) => h2("li", { key: person.name }, h2("strong", null, person.name), h2("span", null, `${person.role ?? "participant"}${person.approved ? " \xB7 approved" : ""}`))
          )
        )
      ),
      h2(
        ui.TabsContent,
        { value: "threads" },
        h2(
          "ul",
          { className: "bb-detail-list" },
          ...detail.threads.map(
            (thread) => h2(
              "li",
              { key: thread.id },
              thread.file ? h2("span", null, thread.file) : null,
              ...thread.comments.map(
                (comment) => h2(
                  "article",
                  { key: comment.id, className: "bb-thread-comment" },
                  h2("strong", null, comment.author),
                  h2("p", null, comment.body)
                )
              ),
              Badge(host, thread.resolved ? "Resolved" : "Open", thread.resolved ? "success" : "warning"),
              detail.capabilities.includes("thread_replies") ? h2(ThreadReply, {
                host,
                workspaceId: scopedWorkspaceId,
                pullRequest: detail,
                threadId: thread.id,
                onChanged: review.refresh
              }) : null
            )
          )
        )
      ),
      h2(
        ui.TabsContent,
        { value: "builds" },
        h2(
          "ul",
          { className: "bb-detail-list" },
          ...detail.statuses.map(
            (status) => h2(
              "li",
              { key: status.key },
              h2("strong", null, status.name),
              status.target ? h2("span", null, status.target) : null,
              Badge(host, status.state, statusTone(status.state)),
              status.url ? h2("a", { href: status.url, target: "_blank", rel: "noreferrer" }, "Open build") : null
            )
          )
        )
      )
    )
  );
}
function LaunchPresets({ host, workspaceId: scopedWorkspaceId, pullRequest }) {
  const { jsx: h2, ui, React } = host;
  const presets = launchPresets();
  const [preset, setPreset] = React.useState("default");
  const [message, setMessage] = React.useState(null);
  const launch = async () => {
    if (!scopedWorkspaceId || !pullRequest || !preset) return;
    try {
      await host.api.invokeAction(action.pullRequestsLaunch, { workspaceId: scopedWorkspaceId, body: { review_key: pullRequest.key, preset } });
      setMessage("Task launch requested.");
    } catch (error) {
      setMessage(errorMessage(error));
    }
  };
  return h2(
    ui.Card,
    { className: "bb-launch" },
    h2(ui.CardHeader, null, h2(ui.CardTitle, null, "Launch preset"), h2(ui.CardDescription, null, "Choose how Kandev should start work from this pull request.")),
    h2(
      ui.CardContent,
      { className: "bb-card-actions" },
      h2(
        ui.Select,
        { value: preset, onValueChange: setPreset },
        h2(ui.SelectTrigger, { className: "min-h-11" }, h2(ui.SelectValue, { placeholder: "Launch preset" })),
        h2(ui.SelectContent, null, ...presets.map((candidate) => h2(ui.SelectItem, { value: candidate.id, key: candidate.id }, candidate.name)))
      ),
      h2(ui.Button, { type: "button", className: "min-h-11", disabled: !pullRequest || !preset, onClick: () => void launch() }, "Launch task"),
      message ? h2("p", { role: "status", className: "bb-message" }, message) : null
    )
  );
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
function Watches({ host, workspaceId: scopedWorkspaceId, filter }) {
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
      h2(ui.Button, { type: "button", variant: "outline", className: "min-h-11", disabled: Boolean(working), onClick: () => void invoke(action.watchesUpdate, { enabled: true, filter }) }, icon(h2, "watch"), "Add current filter watch")
    )
  );
}
function QueueFilters({ host, mobile, search, setSearch, state, setState }) {
  const { jsx: h2, ui } = host;
  const controls = h2(
    "div",
    { className: "bb-filters" },
    h2(ui.Label, { htmlFor: "bitbucket-search" }, "Search pull requests"),
    h2(ui.Input, { id: "bitbucket-search", className: "min-h-11", value: search, onChange: (event) => setSearch(event.target.value), placeholder: "Title, author, or repository" }),
    h2(ui.Label, { htmlFor: "bitbucket-state" }, "State"),
    h2(ui.Select, { value: state, onValueChange: setState }, h2(ui.SelectTrigger, { id: "bitbucket-state", className: "min-h-11" }, h2(ui.SelectValue, null)), h2(ui.SelectContent, null, h2(ui.SelectItem, { value: "open" }, "Open"), h2(ui.SelectItem, { value: "all" }, "All"), h2(ui.SelectItem, { value: "merged" }, "Merged"), h2(ui.SelectItem, { value: "declined" }, "Declined")))
  );
  if (!mobile) return controls;
  return h2(
    ui.Drawer,
    null,
    h2(ui.DrawerTrigger, { asChild: true }, h2(ui.Button, { type: "button", variant: "outline", className: "min-h-11", "aria-label": "Filter pull requests" }, icon(h2, "filter"), "Filters")),
    h2(
      ui.DrawerContent,
      { className: "bb-filter-drawer" },
      h2(ui.DrawerHeader, null, h2(ui.DrawerTitle, null, "Queue filters"), h2(ui.DrawerDescription, null, "Narrow Bitbucket pull requests without leaving the queue.")),
      h2("div", { className: "bb-drawer-scroll" }, controls),
      h2(ui.DrawerFooter, { className: "bb-safe-drawer-footer" }, h2(ui.DrawerClose, { asChild: true }, h2(ui.Button, { type: "button", className: "min-h-11" }, "Done")))
    )
  );
}
function BitbucketPage({ host }) {
  const { jsx: h2, ui, React } = host;
  const responsive = host.useResponsiveBreakpoint();
  const activeWorkspaceId = useActiveWorkspaceId(host);
  const [search, setSearch] = React.useState("");
  const [state, setState] = React.useState("open");
  const [selectedKey, setSelectedKey] = React.useState(null);
  const queue = usePluginQuery(
    host,
    action.pullRequestsQueue,
    activeWorkspaceId ? { workspaceId: activeWorkspaceId, body: { view: "queue", query: search, state } } : void 0,
    Boolean(activeWorkspaceId)
  );
  const pullRequests = normalizePullRequests(queue.data);
  const watchFilter = currentWatchFilter(search, state);
  const selected = pullRequests.find((pullRequest) => pullRequest.key === selectedKey) ?? null;
  const select = (pullRequest) => setSelectedKey(pullRequest.key);
  const noWorkspace = !activeWorkspaceId;
  const desktop = !responsive.isMobile;
  const queueContent = queue.loading && pullRequests.length === 0 ? h2("div", { className: "bb-loading" }, h2(ui.Spinner, { "aria-label": "Loading Bitbucket pull request queue" })) : queue.error ? EmptyState(host, "Queue unavailable", queue.error, "Retry", queue.refresh) : pullRequests.length === 0 ? EmptyState(host, "No pull requests", "Adjust filters or connect a Bitbucket workspace.") : h2(QueueList, { host, pullRequests, selectedKey, onSelect: select });
  return h2(
    "main",
    { className: `bb-workbench ${desktop ? "bb-desktop" : "bb-mobile"}`, "data-testid": "bitbucket-workbench" },
    h2("header", { className: "bb-toolbar" }, h2("div", { className: "bb-toolbar-title" }, icon(h2, "bitbucket"), h2("div", null, h2("h1", null, "Bitbucket"), h2("p", null, "Pull request queue and native reviews"))), h2("div", { className: "bb-toolbar-actions" }, h2(QueueFilters, { host, mobile: responsive.isMobile, search, setSearch, state, setState }), h2(ui.Button, { type: "button", variant: "ghost", className: "min-h-11", onClick: queue.refresh, "aria-label": "Refresh pull request queue" }, icon(h2, "refresh"), "Refresh"))),
    noWorkspace ? EmptyState(host, "Choose a workspace", "Open Bitbucket from a workspace to connect and browse pull requests.") : desktop ? h2("div", { className: "bb-desktop-panes" }, h2("aside", { className: "bb-pane bb-queue-pane" }, h2(ConnectionHealth, { host, workspaceId: activeWorkspaceId }), h2(RepositoryBrowser, { host, workspaceId: activeWorkspaceId, onChoose: setSearch }), queueContent, h2(LaunchPresets, { host, workspaceId: activeWorkspaceId, pullRequest: selected }), h2(Watches, { host, workspaceId: activeWorkspaceId, filter: watchFilter })), h2("section", { className: "bb-pane bb-detail-pane" }, selected ? h2(ReviewDetailPanel, { host, workspaceId: activeWorkspaceId, reviewKey: selected.key }) : EmptyState(host, "Select a pull request", "The detail pane shows files, commits, participants, threads, and available actions."))) : h2("div", { className: "bb-mobile-focus" }, selected ? h2(ReviewDetailPanel, { host, workspaceId: activeWorkspaceId, reviewKey: selected.key, onBack: () => setSelectedKey(null) }) : h2("div", { className: "bb-mobile-list" }, h2(ConnectionHealth, { host, workspaceId: activeWorkspaceId }), h2(RepositoryBrowser, { host, workspaceId: activeWorkspaceId, onChoose: setSearch }), queueContent, h2(LaunchPresets, { host, workspaceId: activeWorkspaceId, pullRequest: null }), h2(Watches, { host, workspaceId: activeWorkspaceId, filter: watchFilter })))
  );
}
function makeLinkPullRequestModal(host, context) {
  return function LinkPullRequestModal() {
    const { jsx: h2, ui, React } = host;
    const [reference, setReference] = React.useState("");
    const [result, setResult] = React.useState(null);
    const run = async () => {
      const body = linkPullRequestBody(reference);
      if (!body) {
        setResult("Enter a Bitbucket pull request key or URL.");
        return;
      }
      try {
        await host.api.invokeAction(action.pullRequestsLink, { workspaceId: context.workspaceId, taskId: context.taskId, body });
        setResult("Pull request linked.");
      } catch (error) {
        setResult(errorMessage(error));
      }
    };
    return h2("form", { className: "bb-task-modal", onSubmit: (event) => {
      event.preventDefault();
      void run();
    } }, h2(ui.Label, { htmlFor: "bitbucket-review-reference" }, "Pull request key or Bitbucket URL"), h2(ui.Input, { id: "bitbucket-review-reference", className: "min-h-11", value: reference, onChange: (event) => setReference(event.target.value), placeholder: "workspace/repository#42" }), h2("p", { className: "bb-capability-note" }, "Paste a key or Cloud/Data Center pull request URL."), result ? h2("p", { role: "status" }, result) : null, h2(ui.Button, { type: "submit", className: "min-h-11", disabled: !reference.trim() }, "Link pull request"));
  };
}
function taskContextValue(context, key) {
  const source = record2(context);
  const task = record2(source.task);
  return text(task[key]) || text(source[key]);
}
function makeUnlinkPullRequestModal(host, context) {
  return function UnlinkPullRequestModal() {
    const { jsx: h2, ui, React } = host;
    const linked = usePluginQuery(host, action.pullRequestsGet, { workspaceId: context.workspaceId, taskId: context.taskId }, true);
    const pullRequests = normalizePullRequests(linked.data);
    const [reviewKey, setReviewKey] = React.useState("");
    const [result, setResult] = React.useState(null);
    React.useEffect(() => {
      if (!reviewKey && pullRequests[0]) setReviewKey(pullRequests[0].key);
    }, [pullRequests, reviewKey]);
    const run = async () => {
      if (!reviewKey) return;
      try {
        await host.api.invokeAction(action.pullRequestsUnlink, { workspaceId: context.workspaceId, taskId: context.taskId, body: { review_key: reviewKey } });
        setResult("Pull request unlinked.");
        linked.refresh();
      } catch (error) {
        setResult(errorMessage(error));
      }
    };
    if (linked.loading) return h2("p", { className: "bb-capability-note", role: "status" }, "Loading linked pull requests\u2026");
    if (linked.error) return h2("p", { className: "bb-error", role: "alert" }, linked.error);
    if (!pullRequests.length) return h2("p", { className: "bb-capability-note", role: "status" }, "No Bitbucket pull requests linked to this task.");
    return h2(
      "form",
      { className: "bb-task-modal", onSubmit: (event) => {
        event.preventDefault();
        void run();
      } },
      h2(ui.Label, { htmlFor: "bitbucket-linked-review" }, "Linked pull request"),
      h2(
        ui.Select,
        { value: reviewKey, onValueChange: setReviewKey },
        h2(ui.SelectTrigger, { id: "bitbucket-linked-review", className: "min-h-11" }, h2(ui.SelectValue, { placeholder: "Choose linked pull request" })),
        h2(ui.SelectContent, null, ...pullRequests.map((pullRequest) => h2(ui.SelectItem, { key: pullRequest.key, value: pullRequest.key }, `${pullRequest.repositoryName} \xB7 #${pullRequest.number} \xB7 ${pullRequest.title}`)))
      ),
      result ? h2("p", { role: "status" }, result) : null,
      h2(ui.Button, { type: "submit", className: "min-h-11", disabled: !reviewKey }, "Unlink pull request")
    );
  };
}
function makeCreatePullRequestModal(host, context) {
  return function CreatePullRequestModal() {
    const { jsx: h2, ui, React } = host;
    const [title, setTitle] = React.useState(taskContextValue(context, "title"));
    const [description, setDescription] = React.useState(taskContextValue(context, "description"));
    const [destination, setDestination] = React.useState("");
    const [closeSourceOnMerge, setCloseSourceOnMerge] = React.useState(false);
    const [result, setResult] = React.useState(null);
    const run = async () => {
      try {
        await host.api.invokeAction(action.pullRequestsCreate, {
          workspaceId: context.workspaceId,
          taskId: context.taskId,
          body: pullRequestCreateBody({ title, description, destination, closeSourceOnMerge })
        });
        setResult("Pull request created.");
      } catch (error) {
        setResult(errorMessage(error));
      }
    };
    return h2(
      "form",
      { className: "bb-task-modal", onSubmit: (event) => {
        event.preventDefault();
        void run();
      } },
      h2("p", { className: "bb-capability-note" }, "Kandev derives repository and source branch from this task's verified checkout."),
      h2("p", { className: "bb-capability-note" }, "Leave fields blank to use task title, description, and destination defaults."),
      h2(ui.Label, { htmlFor: "bitbucket-pr-title" }, "Pull request title"),
      h2(ui.Input, { id: "bitbucket-pr-title", className: "min-h-11", value: title, onChange: (event) => setTitle(event.target.value) }),
      h2(ui.Label, { htmlFor: "bitbucket-pr-description" }, "Description"),
      h2(ui.Textarea, { id: "bitbucket-pr-description", className: "min-h-11", value: description, onChange: (event) => setDescription(event.target.value) }),
      h2(ui.Label, { htmlFor: "bitbucket-pr-destination" }, "Destination branch"),
      h2(ui.Input, { id: "bitbucket-pr-destination", className: "min-h-11", value: destination, onChange: (event) => setDestination(event.target.value), placeholder: "Task base branch (default)" }),
      h2("label", { className: "bb-check" }, h2("input", { type: "checkbox", checked: closeSourceOnMerge, onChange: (event) => setCloseSourceOnMerge(event.target.checked) }), "Close source branch after merge"),
      result ? h2("p", { role: "status", className: "bb-message" }, result) : null,
      h2(ui.Button, { type: "submit", className: "min-h-11" }, "Create pull request")
    );
  };
}
function taskActionPresentation(context) {
  return context.presentation === "mobile" ? "drawer" : "dialog";
}
function registerNativeIntegrations(registry, host) {
  registry.registerRepositoryProvider({
    id: "bitbucket",
    label: "Bitbucket",
    icon: "puzzle",
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
    }
  });
  registry.registerTaskAction({
    id: "link-pull-request",
    label: "Link Bitbucket Pull Request",
    icon: "link",
    placement: "link",
    async run(context) {
      host.openModal({ title: "Link Bitbucket pull request", size: "md", presentation: taskActionPresentation(context), content: makeLinkPullRequestModal(host, context) });
    }
  });
  registry.registerTaskAction({
    id: "open-pull-request-review",
    label: "Open Bitbucket Review",
    icon: "bitbucket",
    placement: "action",
    async run() {
      host.navigate("/bitbucket");
    }
  });
  registry.registerTaskAction({
    id: "unlink-pull-request",
    label: "Unlink Bitbucket Pull Request",
    icon: "link",
    placement: "action",
    async run(context) {
      host.openModal({ title: "Unlink Bitbucket pull request", size: "sm", presentation: taskActionPresentation(context), content: makeUnlinkPullRequestModal(host, context) });
    }
  });
  registry.registerTaskAction({
    id: "create-pull-request",
    label: "Create Bitbucket Pull Request",
    icon: "plus",
    placement: "action",
    visible(context) {
      return taskSupportsBitbucketRepository(context.repositories);
    },
    async run(context) {
      host.openModal({ title: "Create Bitbucket pull request", size: "md", presentation: taskActionPresentation(context), content: makeCreatePullRequestModal(host, context) });
    }
  });
  registry.registerReviewProvider({
    id: "bitbucket",
    label: "Bitbucket",
    icon: "puzzle",
    changeRequestNoun: "pull request",
    order: 30,
    getSnapshot: (taskId) => reviewStore.get(taskId),
    subscribe: (taskId, listener) => reviewStore.subscribe(taskId, listener),
    async refresh(taskId, signal) {
      const response = await host.api.invokeAction(action.pullRequestsGet, { taskId, body: { view: "task" } }, { signal });
      if (!signal.aborted) reviewStore.set(taskId, normalizePullRequests(response));
    },
    ReviewPanel: (props = {}) => h(ReviewDetailPanel, {
      host,
      workspaceId: text(props.workspaceId) || void 0,
      taskId: text(props.taskId) || void 0,
      reviewKey: text(props.reviewKey)
    })
  });
}
function makeSettingsHealth(host) {
  return function SettingsHealth(props = {}) {
    const scopedWorkspaceId = useActiveWorkspaceId(host);
    return host.jsx(ConnectionHealth, { host, workspaceId: scopedWorkspaceId, status: record2(props.slotProps).status });
  };
}
var h = (type, props, ...children) => currentHost?.jsx(type, props, ...children);
var currentHost = null;
window.registerKandevPlugin(PLUGIN_ID, {
  initialize(registry, host) {
    currentHost = host;
    registry.registerNavItem({ id: "bitbucket", label: "Bitbucket", path: "/bitbucket", icon: "puzzle", section: "integrations" });
    registry.registerRoute("/bitbucket", () => host.jsx(BitbucketPage, { host }), { topbar: false });
    registry.registerComponent("plugin-settings", makeSettingsHealth(host));
    registerNativeIntegrations(registry, host);
  },
  destroy() {
    reviewStore.clear();
    currentHost = null;
  }
});

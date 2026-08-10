import {
  activeWorkspaceIdFromState,
  canSaveDashboardQuery,
  connectionActionBody,
  connectionIdentity,
  connectionOAuthRegistration,
  connectionSaveBody,
  connectionState,
  changeRequestDetailActions,
  changeRequestDetailModel,
  deriveOAuthCallbackURL,
  disconnectConnectionInput,
  displayPullRequestAuthor,
  errorMessage,
  integrationSettingsHref,
  linkPullRequestBody,
  normalizePullRequestAssociations,
  normalizePullRequests,
  normalizeRepositories,
  normalizeRepositoryInspection,
  normalizeReviewDetail,
  normalizeSavedQueries,
  normalizeWatches,
  oauthStartInput,
  newSavedQuery,
  pluginRepositoryInput,
  parsePullRequestListQuery,
  pullRequestListRequest,
  pullRequestScopeQuery,
  relativeTimeLabel,
  taskDialogInitialValues,
  taskFromLaunchResult,
  taskLaunchBody,
  taskLaunchPresets,
  usePluginTaskCreation,
  workspaceReviewAction,
  type ConnectionState,
  type PullRequest,
  type SavedQuery,
  type TaskLaunchPreset,
  type RepositoryInspection,
  type WatchSummary,
  validateCloudWorkspace,
  validateConnectionIdentity,
  validateOAuthRegistration,
} from "./view-models";
import {
  loadTaskPullRequestDetails,
  reviewSummaryForPullRequest,
  type PullRequestWithStatus,
  type ReviewSummaryForHost,
} from "./task-review-status";

type ElementFactory = (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => unknown;
type Component = (props?: Record<string, unknown>) => unknown;

type ResponsiveBreakpoint = { isMobile: boolean; usesDesktopWorkbench?: boolean };
type ActionInput = { workspaceId?: string; taskId?: string; repositoryId?: string; body?: unknown };
type TaskContext = {
  workspaceId: string;
  taskId: string;
  repositories: readonly unknown[];
  pathname: string;
  presentation: "desktop" | "mobile";
};

type HostReact = {
  useState<T>(value: T | (() => T)): [T, (next: T | ((previous: T) => T)) => void];
  useEffect(effect: () => void | (() => void), dependencies?: unknown[]): void;
  useMemo<T>(factory: () => T, dependencies: unknown[]): T;
  useCallback<T extends (...args: never[]) => unknown>(callback: T, dependencies: unknown[]): T;
  useRef<T>(value: T): { current: T };
};

type PluginHost = {
  React: HostReact;
  jsx: ElementFactory;
  ui: Record<string, unknown>;
  api: {
    invokeAction<T>(
      key: string,
      input?: ActionInput,
      options?: { signal?: AbortSignal },
    ): Promise<T>;
  };
  useResponsiveBreakpoint(): ResponsiveBreakpoint;
  store: { getState(): Record<string, unknown>; subscribe(listener: () => void): () => void };
  navigate(href: string, options?: { replace?: boolean }): void;
  openModal(options: {
    title: string;
    content: Component;
    size?: "sm" | "md" | "lg" | "xl";
    presentation?: "dialog" | "drawer";
  }): { close(): void };
  openTaskLinkDialog(options: {
    title: string;
    description: string;
    inputLabel: string;
    placeholder?: string;
    emptyError: string;
    failureMessage: string;
    successMessage: string;
    inputTestId?: string;
    errorTestId?: string;
    submitTestId?: string;
    onSubmit(reference: string): Promise<void>;
  }): { close(): void };
  storage: {
    get(
      scope: "workspace",
      scopeId: string,
      key: string,
    ): Promise<{ value: unknown; updatedAt: string } | undefined>;
    set(
      scope: "workspace",
      scopeId: string,
      key: string,
      value: unknown,
    ): Promise<{ updatedAt: string }>;
    subscribe(
      filter: { scope: "workspace"; scopeId: string; key: string },
      listener: () => void,
    ): () => void;
  };
};

type PluginRegistry = {
  registerRoute(path: string, component: Component, options?: Record<string, unknown>): void;
  registerNavItem(item: { id: string; label: string; path: string; icon: string; section: "integrations" }): void;
  registerComponent(slot: string, component: Component): void;
  registerIntegrationSettings(settings: {
    id: string;
    label: string;
    description: string;
    icon?: string;
    Component: Component;
  }): void;
  registerRepositoryProvider(provider: {
    id: string;
    label: string;
    icon: string;
    listRepositories(context: { workspaceId: string; signal: AbortSignal }): Promise<RepositoryInspection[]>;
    matchesURL(url: string): boolean;
    listBranches(context: { workspaceId: string; repository: RepositoryInspection; signal: AbortSignal }): Promise<unknown[]>;
    inspectURL(context: { workspaceId: string; url: string; signal: AbortSignal }): Promise<RepositoryInspection | null>;
    supportsDraft?: boolean;
    createChangeRequest?(context: {
      workspaceId: string;
      taskId: string;
      repositoryId: string;
      title: string;
      body: string;
      baseBranch?: string;
      draft: boolean;
      signal: AbortSignal;
    }): Promise<{ url: string; provider?: string; output?: string }>;
  }): void;
  registerTaskAction(action: {
    id: string;
    label: string;
    icon: string;
    placement: "link";
    visible?(context: TaskContext): boolean;
    run(context: TaskContext): Promise<void>;
  }): void;
  registerReviewProvider(provider: {
    id: string;
    label: string;
    icon: string;
    changeRequestNoun: string;
    order: number;
    getSnapshot(taskId: string): readonly ReviewSummary[];
    subscribe(taskId: string, listener: () => void): () => void;
    refresh(taskId: string, signal: AbortSignal): Promise<void>;
    getAssociationSnapshot?(workspaceId: string): readonly ReviewTaskAssociation[];
    subscribeAssociations?(workspaceId: string, listener: () => void): () => void;
    refreshAssociations?(workspaceId: string, signal: AbortSignal): Promise<void>;
    unlink?(context: {
      workspaceId: string;
      taskId: string;
      reviewKey: string;
      signal: AbortSignal;
    }): Promise<void>;
    ReviewPanel: Component;
  }): void;
};

type ReviewSummary = ReviewSummaryForHost;
type ReviewTaskAssociation = { providerId: "bitbucket"; taskId: string; reviewKey: string };

type QueryState<T> = { data: T | null; loading: boolean; error: string | null; lastFetchedAt: Date | null; refresh(): void };

const PLUGIN_ID = "kandev-plugin-bitbucket";
const action = {
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
  watchesDelete: "watches.delete",
} as const;

const reviewStore = (() => {
  const snapshots = new Map<string, ReviewSummary[]>();
  const listeners = new Map<string, Set<() => void>>();
  return {
    get(taskId: string): readonly ReviewSummary[] {
      return snapshots.get(taskId) ?? [];
    },
    set(taskId: string, pullRequests: PullRequestWithStatus[]) {
      snapshots.set(taskId, pullRequests.map((pullRequest) => reviewSummaryForPullRequest(pullRequest)));
      listeners.get(taskId)?.forEach((listener) => listener());
    },
    subscribe(taskId: string, listener: () => void): () => void {
      const taskListeners = listeners.get(taskId) ?? new Set<() => void>();
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
    },
  };
})();

const associationStore = (() => {
  const snapshots = new Map<string, ReviewTaskAssociation[]>();
  const listeners = new Map<string, Set<() => void>>();
  return {
    get(workspaceId: string): readonly ReviewTaskAssociation[] {
      return snapshots.get(workspaceId) ?? [];
    },
    set(workspaceId: string, value: unknown) {
      const associations = normalizePullRequestAssociations(value);
      snapshots.set(
        workspaceId,
        Object.entries(associations).flatMap(([reviewKey, tasks]) =>
          tasks.map((task) => ({ providerId: "bitbucket", taskId: task.taskId, reviewKey })),
        ),
      );
      listeners.get(workspaceId)?.forEach((listener) => listener());
    },
    subscribe(workspaceId: string, listener: () => void): () => void {
      const workspaceListeners = listeners.get(workspaceId) ?? new Set<() => void>();
      workspaceListeners.add(listener);
      listeners.set(workspaceId, workspaceListeners);
      return () => {
        workspaceListeners.delete(listener);
        if (workspaceListeners.size === 0) listeners.delete(workspaceId);
      };
    },
    clear() {
      snapshots.clear();
      listeners.forEach((workspaceListeners) =>
        workspaceListeners.forEach((listener) => listener()),
      );
      listeners.clear();
    },
  };
})();

async function refreshAssociationStore(
  host: PluginHost,
  workspaceId: string,
  signal: AbortSignal,
): Promise<void> {
  const response = await host.api.invokeAction<unknown>(
    action.pullRequestsAssociations,
    { workspaceId },
    { signal },
  );
  if (!signal.aborted) associationStore.set(workspaceId, response);
}

async function refreshReviewStore(
  host: PluginHost,
  taskId: string,
  signal: AbortSignal,
  workspaceId?: string,
): Promise<void> {
  const pullRequests = await loadTaskPullRequestDetails(
    (key, input, options) => host.api.invokeAction(key, input, options),
    { taskId, ...(workspaceId ? { workspaceId } : {}) },
    signal,
  );
  if (!signal.aborted) reviewStore.set(taskId, pullRequests);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function useActiveWorkspaceId(host: PluginHost): string | undefined {
  const { React } = host;
  const [activeWorkspaceId, setActiveWorkspaceId] = React.useState(() =>
    activeWorkspaceIdFromState(host.store.getState()),
  );
  React.useEffect(() => {
    const sync = () => setActiveWorkspaceId(activeWorkspaceIdFromState(host.store.getState()));
    sync();
    return host.store.subscribe(sync);
  }, [host]);
  return activeWorkspaceId;
}

const SAVED_QUERIES_KEY = "dashboard-saved-queries";

function useSavedQueries(host: PluginHost, workspaceId?: string) {
  const { React } = host;
  const [queries, setQueries] = React.useState<SavedQuery[]>([]);
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
      () => void sync(),
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [host, workspaceId]);
  const persist = async (next: SavedQuery[]) => {
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
    async save(input: Pick<SavedQuery, "label" | "query" | "repositoryId" | "state">) {
      const created = newSavedQuery(
        input,
        `saved-${globalThis.crypto.randomUUID()}`,
        new Date().toISOString(),
      );
      await persist([...queries, created]);
      return created;
    },
    remove(id: string) {
      void persist(queries.filter((query) => query.id !== id));
    },
  };
}

function requestBody(input?: ActionInput): ActionInput | undefined {
  if (!input) return undefined;
  return JSON.parse(JSON.stringify(input)) as ActionInput;
}

function usePluginQuery<T>(
  host: PluginHost,
  key: string,
  input: ActionInput | undefined,
  enabled = true,
): QueryState<T> {
  const { React } = host;
  const serializedInput = JSON.stringify(input ?? {});
  const [reload, setReload] = React.useState(0);
  const [state, setState] = React.useState<{ data: T | null; loading: boolean; error: string | null; lastFetchedAt: Date | null }>({
    data: null,
    loading: enabled,
    error: null,
    lastFetchedAt: null,
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
    void host.api
      .invokeAction<T>(key, requestBody(JSON.parse(serializedInput) as ActionInput), {
        signal: controller.signal,
      })
      .then((data) => {
        if (active) setState({ data, loading: false, error: null, lastFetchedAt: new Date() });
      })
      .catch((error) => {
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

function useAbortableAction(host: PluginHost) {
  const { React } = host;
  const activeController = React.useRef<AbortController | null>(null);
  React.useEffect(
    () => () => {
      activeController.current?.abort();
    },
    [],
  );
  const invoke = async (key: string, input: ActionInput): Promise<unknown> => {
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
    },
  };
}

function isAbortError(reason: unknown): boolean {
  return record(reason).name === "AbortError";
}

function icon(h: ElementFactory, name: string) {
  const paths: Record<string, string> = {
    watch: "M3 12s3.2-5 9-5 9 5 9 5-3.2 5-9 5-9-5-9-5Zm9 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
    back: "m15 18-6-6 6-6",
  };
  return h(
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
      "aria-hidden": true,
    },
    h("path", { d: paths[name] ?? paths.back }),
  );
}

function pullRequestStateIcon(host: PluginHost, pullRequest: PullRequest) {
  const normalized = pullRequest.state.toLowerCase();
  const merged = normalized === "merged";
  const closed = normalized === "declined" || normalized === "closed";
  return host.jsx(
    host.ui.IntegrationIcon,
    {
      name: merged ? "merged" : closed ? "pull-request-closed" : "pull-request",
      className: `h-4 w-4 ${merged ? "text-purple-600 dark:text-purple-400" : closed ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"}`,
    },
  );
}

function Badge(host: PluginHost, label: string, tone = "neutral") {
  return host.jsx(host.ui.Badge, { className: `bb-badge bb-badge-${tone}` }, label);
}

function EmptyState(host: PluginHost, title: string, detail: string, actionLabel?: string, onAction?: () => void) {
  const { jsx: h, ui } = host;
  return h(
    "section",
    { className: "bb-empty", role: "status" },
    h("h2", null, title),
    h("p", null, detail),
    actionLabel && onAction
      ? h(ui.Button, { type: "button", className: "min-h-11", onClick: onAction }, actionLabel)
      : null,
  );
}

function DisconnectConfirmation({
  host,
  workspaceId,
  onSuccess,
  onCancel,
}: {
  host: PluginHost;
  workspaceId: string;
  onSuccess(): void;
  onCancel(): void;
}) {
  const { jsx: h, ui, React } = host;
  const [disconnecting, setDisconnecting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
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
  return h(
    "section",
    { className: "bb-disconnect-confirm" },
    h("p", null, "Disconnect Bitbucket connection?"),
    h("p", { className: "bb-capability-note" }, "Stored Bitbucket credentials and connection settings for this workspace will be removed."),
    error ? h("p", { className: "bb-error", role: "alert" }, error) : null,
    h(
      "div",
      { className: "bb-card-actions" },
      h(ui.Button, { type: "button", variant: "outline", className: "min-h-11", disabled: disconnecting, onClick: onCancel }, "Cancel"),
      h(ui.Button, { type: "button", variant: "destructive", className: "min-h-11", disabled: disconnecting, onClick: () => void disconnect() }, disconnecting ? "Disconnecting…" : "Disconnect Bitbucket"),
    ),
  );
}

function ConnectionHealth({ host, workspaceId: scopedWorkspaceId }: { host: PluginHost; workspaceId?: string }) {
  const { jsx: h, ui, React } = host;
  const responsive = host.useResponsiveBreakpoint();
  const connection = usePluginQuery<Record<string, unknown>>(
    host,
    action.connectionGet,
    scopedWorkspaceId ? { workspaceId: scopedWorkspaceId } : undefined,
    Boolean(scopedWorkspaceId),
  );
  const [saving, setSaving] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [product, setProduct] = React.useState("cloud");
  const [baseUrl, setBaseUrl] = React.useState("");
  const [cloudWorkspace, setCloudWorkspace] = React.useState("");
  const [authMethod, setAuthMethod] = React.useState("api_token");
  const [token, setToken] = React.useState("");
  const details = record(connection.data);
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
  const label: Record<ConnectionState, string> = {
    unconfigured: "Not configured",
    checking: "Checking connection",
    connected: "Connected",
    auth_required: "Authentication required",
    unavailable: "Unavailable",
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
          probe: true,
        },
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
          probe: false,
        },
      });
      setOAuthClientSecret("");
      const result = await host.api.invokeAction<Record<string, unknown>>(action.oauthStart, oauthStartInput(scopedWorkspaceId));
      const href = text(record(result).url) || text(record(result).authorization_url);
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
    let modal: { close(): void } | undefined;
    modal = host.openModal({
      title: "Disconnect Bitbucket",
      size: "sm",
      content: () => h(DisconnectConfirmation, { host, workspaceId: scopedWorkspaceId, onSuccess: () => { completeDisconnect(); modal?.close(); }, onCancel: () => modal?.close() }),
    });
  };
  return h(
    ui.Card,
    { className: "bb-connection", "data-testid": "bitbucket-connection-health" },
    h(
      ui.CardHeader,
      null,
      h("div", { className: "bb-title-row" }, h(ui.CardTitle, null, "Connection"), Badge(host, label[state], state === "connected" ? "success" : state === "auth_required" ? "warning" : "neutral")),
      h(ui.CardDescription, null, text(details.product, "Connect Bitbucket Cloud or Data Center for this workspace.")),
    ),
    h(
      ui.CardContent,
      { className: "bb-settings-form" },
      connection.loading ? h(ui.Spinner, { "aria-label": "Checking Bitbucket connection" }) : null,
      connection.error ? h("p", { className: "bb-error", role: "alert" }, connection.error) : null,
      message ? h("p", { className: "bb-message", role: "status" }, message) : null,
      h(ui.Label, { htmlFor: "bitbucket-product" }, "Bitbucket product"),
      h(ui.Select, { value: product, onValueChange: (next: string) => { setProduct(next); setAuthMethod(next === "cloud" ? "api_token" : "user_pat"); setCloudWorkspace(""); setIdentity(""); setToken(""); setOAuthClientId(""); setOAuthClientSecret(""); } }, h(ui.SelectTrigger, { id: "bitbucket-product", className: "min-h-11" }, h(ui.SelectValue, null)), h(ui.SelectContent, null, h(ui.SelectItem, { value: "cloud" }, "Bitbucket Cloud"), h(ui.SelectItem, { value: "data_center" }, "Bitbucket Data Center"))),
      product === "cloud"
        ? h("div", { className: "bb-field" }, h(ui.Label, { htmlFor: "bitbucket-cloud-workspace" }, "Bitbucket workspace"), h(ui.Input, { id: "bitbucket-cloud-workspace", "data-testid": "bitbucket-cloud-workspace", className: "min-h-11", autoComplete: "organization", value: cloudWorkspace, onChange: (event: { target: { value: string } }) => setCloudWorkspace(event.target.value), placeholder: "workspace-slug", "aria-describedby": "bitbucket-cloud-workspace-help" }), h("p", { id: "bitbucket-cloud-workspace-help", className: "bb-capability-note" }, "Workspace slug or ID from bitbucket.org/workspace; required to list repositories."))
        : null,
      product === "data_center"
        ? h("div", { className: "bb-field" }, h(ui.Label, { htmlFor: "bitbucket-base-url" }, "Data Center URL"), h(ui.Input, { id: "bitbucket-base-url", className: "min-h-11", value: baseUrl, onChange: (event: { target: { value: string } }) => setBaseUrl(event.target.value), placeholder: "https://bitbucket.example.com/bitbucket" }))
        : null,
      h(ui.Label, { htmlFor: "bitbucket-auth-method" }, "Authentication"),
      h(ui.Select, { value: authMethod, onValueChange: (next: string) => { setAuthMethod(next); if (next === "oauth") setToken(""); if (next !== "oauth") { setOAuthClientId(""); setOAuthClientSecret(""); } } }, h(ui.SelectTrigger, { id: "bitbucket-auth-method", className: "min-h-11" }, h(ui.SelectValue, null)), h(ui.SelectContent, null, product === "cloud" ? [h(ui.SelectItem, { value: "api_token" }, "API token"), h(ui.SelectItem, { value: "oauth" }, "OAuth 2.0")] : [h(ui.SelectItem, { value: "user_pat" }, "Personal access token"), h(ui.SelectItem, { value: "project_token" }, "Project access token"), h(ui.SelectItem, { value: "repository_token" }, "Repository access token"), h(ui.SelectItem, { value: "oauth" }, "OAuth 2.0")])),
      authMethod !== "oauth"
        ? h("div", { className: "bb-field" }, h(ui.Label, { htmlFor: "bitbucket-token" }, "Access token"), h(ui.Input, { id: "bitbucket-token", type: "password", className: "min-h-11", autoComplete: "off", value: token, onChange: (event: { target: { value: string } }) => setToken(event.target.value), placeholder: "Stored only by Bitbucket secret handling" }))
        : null,
      identityField
        ? h("div", { className: "bb-field" }, h(ui.Label, { htmlFor: "bitbucket-connection-identity" }, identityField.label), h(ui.Input, { id: "bitbucket-connection-identity", "data-testid": "bitbucket-connection-identity", type: identityField.inputType, className: "min-h-11", autoComplete: identityField.inputType === "email" ? "email" : "username", value: identity, onChange: (event: { target: { value: string } }) => setIdentity(event.target.value), "aria-describedby": "bitbucket-connection-identity-help" }), h("p", { id: "bitbucket-connection-identity-help", className: "bb-capability-note" }, identityField.help))
        : null,
      authMethod === "oauth"
        ? h("section", { className: "bb-oauth-registration", "aria-label": "OAuth client registration" }, oauthRegistration.configured ? h("p", { className: "bb-capability-note", role: "status" }, "OAuth app registration is configured. Enter both values only to replace it.") : null, h("div", { className: "bb-field" }, h(ui.Label, { htmlFor: "bitbucket-oauth-client-id" }, oauthRegistration.configured ? "OAuth client ID (optional to replace)" : "OAuth client ID"), h(ui.Input, { id: "bitbucket-oauth-client-id", "data-testid": "bitbucket-oauth-client-id", className: "min-h-11", autoComplete: "off", value: oauthClientId, onChange: (event: { target: { value: string } }) => setOAuthClientId(event.target.value) })), h("div", { className: "bb-field" }, h(ui.Label, { htmlFor: "bitbucket-oauth-client-secret" }, oauthRegistration.configured ? "OAuth client secret (optional to replace)" : "OAuth client secret"), h(ui.Input, { id: "bitbucket-oauth-client-secret", "data-testid": "bitbucket-oauth-client-secret", type: "password", className: "min-h-11", autoComplete: "off", value: oauthClientSecret, onChange: (event: { target: { value: string } }) => setOAuthClientSecret(event.target.value), "aria-describedby": "bitbucket-oauth-client-secret-help" }), h("p", { id: "bitbucket-oauth-client-secret-help", className: "bb-capability-note" }, "Stored only by Bitbucket secret handling. Existing secrets are never displayed.")), h("div", { className: "bb-field" }, h(ui.Label, { htmlFor: "bitbucket-oauth-callback-url" }, "OAuth callback URL"), h(ui.Input, { id: "bitbucket-oauth-callback-url", "data-testid": "bitbucket-oauth-callback-url", type: "url", className: "min-h-11", readOnly: true, value: oauthCallbackUrl, "aria-describedby": "bitbucket-oauth-callback-url-help" }), h("p", { id: "bitbucket-oauth-callback-url-help", className: "bb-capability-note" }, "Copy this Kandev callback URL into your OAuth app. It is derived from this Kandev origin.")))
        : null,
      authMethod === "oauth"
        ? h(ui.Button, { type: "button", className: "min-h-11", disabled: saving || !oauthReady, onClick: startOauth }, "Connect with OAuth")
        : null,
      h(ui.Separator, null),
      h(
        "div",
        { className: "bb-settings-actions" },
        h(ui.Button, { type: "button", variant: "outline", className: "min-h-11", disabled: saving, onClick: saveConnection }, "Check connection"),
        h(ui.Button, { type: "button", variant: "destructive", className: "bb-settings-disconnect min-h-11", disabled: saving || !scopedWorkspaceId, onClick: openDisconnectConfirmation }, "Disconnect Bitbucket"),
      ),
      responsive.isMobile && scopedWorkspaceId
        ? h(
            ui.Drawer,
            { open: disconnectOpen, onOpenChange: (open: boolean) => setDisconnectOpen(open) },
            h(
              ui.DrawerContent,
              { className: "bb-disconnect-drawer" },
              h(ui.DrawerHeader, null, h(ui.DrawerTitle, null, "Disconnect Bitbucket"), h(ui.DrawerDescription, null, "Remove this workspace Bitbucket connection.")),
              h("div", { className: "bb-drawer-scroll" }, h(DisconnectConfirmation, { host, workspaceId: scopedWorkspaceId, onSuccess: completeDisconnect, onCancel: () => setDisconnectOpen(false) })),
            ),
          )
        : null,
    ),
  );
}

type TaskCreateContext = {
  workflowId: string;
  defaultStepId: string;
  steps: Array<{ id: string; title: string; events?: Record<string, unknown> }>;
  repositories: Array<Record<string, unknown>>;
};

function taskCreateContext(state: Record<string, unknown>, workspaceId?: string): TaskCreateContext | null {
  if (!workspaceId) return null;
  const workflowState = record(state.workflows);
  const workflows = Array.isArray(workflowState.items) ? workflowState.items.map(record) : [];
  const activeWorkflowId = text(workflowState.activeId);
  const workflow = workflows.find((candidate) => text(candidate.id) === activeWorkflowId && text(candidate.workspaceId) === workspaceId)
    ?? workflows.find((candidate) => text(candidate.workspaceId) === workspaceId || text(candidate.workspace_id) === workspaceId);
  const workflowId = text(workflow?.id);
  if (!workflowId) return null;
  const kanban = record(state.kanban);
  const snapshots = record(record(state.kanbanMulti).snapshots);
  const snapshot = record(snapshots[workflowId]);
  const rawSteps = text(kanban.workflowId) === workflowId && Array.isArray(kanban.steps)
    ? kanban.steps
    : Array.isArray(snapshot.steps) ? snapshot.steps : [];
  const steps = rawSteps
    .map(record)
    .sort((left, right) => Number(left.position ?? 0) - Number(right.position ?? 0))
    .map((step) => ({ id: text(step.id), title: text(step.title) || text(step.name), ...(record(step.events) ? { events: record(step.events) } : {}) }))
    .filter((step) => step.id && step.title);
  if (!steps[0]) return null;
  const repositoryState = record(state.repositories);
  const byWorkspace = record(repositoryState.itemsByWorkspaceId);
  const repositories = Array.isArray(byWorkspace[workspaceId]) ? (byWorkspace[workspaceId] as unknown[]).map(record) : [];
  return { workflowId, defaultStepId: steps[0].id, steps, repositories };
}

function matchingHostRepositoryId(repositories: Array<Record<string, unknown>>, pullRequest: PullRequest): string | undefined {
  const match = repositories.find((repository) => {
    if (text(repository.provider).toLowerCase() !== "bitbucket") return false;
    return text(repository.provider_repo_id) === pullRequest.repositoryId
      || (pullRequest.url && text(repository.remote_url) && pullRequest.url.includes(text(repository.provider_owner)) && pullRequest.url.includes(text(repository.provider_name)));
  });
  return match ? text(match.id) || undefined : undefined;
}

function DashboardPullRequestList({ host, pullRequests, loading, error, tasksByReview, onStartTask }: { host: PluginHost; pullRequests: PullRequest[]; loading: boolean; error: string | null; tasksByReview: Record<string, PullRequest["tasks"]>; onStartTask(pullRequest: PullRequest, preset: TaskLaunchPreset): void }) {
  const { jsx: h, ui } = host;
  const presets = taskLaunchPresets();
  return h(
    "div",
    { "data-testid": "bitbucket-pr-queue" },
    h(
      ui.ChangeRequestList,
      { loading, error, emptyMessage: "No pull requests match this filter.", isEmpty: pullRequests.length === 0 },
      ...pullRequests.map((pullRequest) => {
        const author = displayPullRequestAuthor(pullRequest.author);
        const opened = relativeTimeLabel(pullRequest.createdAt);
        const metadata = h(
          "span",
          { className: "bb-change-request-metadata" },
          h("span", null, `${pullRequest.repositoryId}#${pullRequest.number}`),
          author ? h("span", null, ` · by ${author}`) : null,
          opened ? h("span", null, ` · opened ${opened}`) : null,
          pullRequest.sourceBranch && pullRequest.destinationBranch ? h("span", null, ` · ${pullRequest.sourceBranch} → ${pullRequest.destinationBranch}`) : null,
          h("span", null, " · "),
          Badge(host, pullRequest.statusLabel ?? pullRequest.state, pullRequest.statusTone),
        );
        const tasks = tasksByReview[pullRequest.key] ?? pullRequest.tasks;
        return h(ui.ChangeRequestRow, {
          key: pullRequest.key,
          stateIcon: pullRequestStateIcon(host, pullRequest),
          title: pullRequest.title,
          href: pullRequest.url,
          metadata,
          taskIndicator: h(ui.TaskRowIndicator, { tasks, testIdPrefix: `bitbucket-pr-${pullRequest.number}-task` }),
          action: pullRequest.capabilities.includes("launch_task")
            ? h(ui.IntegrationStartTaskMenu, {
                presets,
                onSelect: (selected: { id: string }) => {
                  const preset = presets.find((candidate) => candidate.id === selected.id);
                  if (preset) onStartTask(pullRequest, preset);
                },
                triggerTestId: "bitbucket-start-task-trigger",
                itemTestId: "bitbucket-start-task-preset",
              })
            : null,
          testId: "bitbucket-pr-row",
          dataAttributes: { "data-pr-number": pullRequest.number },
        });
      }),
    ),
  );
}

type HostDetailActionRequest = { actionId: string; body?: string; threadId?: string };

function ReviewDetailPanel({
  host,
  workspaceId: scopedWorkspaceId,
  taskId,
  reviewKey,
  presentation,
}: {
  host: PluginHost;
  workspaceId?: string;
  taskId?: string;
  reviewKey: string;
  presentation?: "desktop" | "mobile";
}) {
  const { jsx: h, ui, React } = host;
  const review = usePluginQuery<Record<string, unknown>>(
    host,
    taskId ? action.pullRequestsGet : action.pullRequestsInspect,
    taskId
      ? {
          taskId,
          body: {
            review_key: reviewKey,
            include: ["files", "commits", "participants", "threads", "status"],
          },
        }
      : scopedWorkspaceId
        ? {
            workspaceId: scopedWorkspaceId,
            body: {
              review_key: reviewKey,
              include: ["files", "commits", "participants", "threads", "status"],
            },
          }
        : undefined,
    Boolean((taskId || scopedWorkspaceId) && reviewKey),
  );
  const detail = normalizeReviewDetail(review.data);
  const [busyActionId, setBusyActionId] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const request = useAbortableAction(host);
  const runAction = async (requestValue: HostDetailActionRequest) => {
    if (!detail || !scopedWorkspaceId || busyActionId) return;
    const kind =
      requestValue.actionId === "comment" ? "add_comment" : requestValue.actionId;
    setBusyActionId(requestValue.actionId);
    setActionError(null);
    try {
      await request.invoke(
        action.reviewsAction,
        workspaceReviewAction(scopedWorkspaceId, detail.key, detail.id, kind, {
          ...(requestValue.body ? { comment: requestValue.body } : {}),
          ...(requestValue.threadId ? { parentCommentId: requestValue.threadId } : {}),
        }),
      );
      review.refresh();
    } catch (reason) {
      if (!isAbortError(reason)) setActionError(errorMessage(reason));
    } finally {
      setBusyActionId(null);
    }
  };
  return h(ui.ChangeRequestDetail, {
    detail: detail ? changeRequestDetailModel(detail) : null,
    presentation: presentation ?? "desktop",
    loading: review.loading,
    error: review.error,
    onRefresh: review.refresh,
    onRetry: review.refresh,
    actions: detail ? changeRequestDetailActions(detail) : [],
    busyActionId,
    onAction: runAction,
    notice: actionError
      ? h("p", { className: "bb-error", role: "alert" }, actionError)
      : null,
  });
}

type PendingWatchChange = { watchId: string; kind: "reset" | "delete"; taskCount: number };

function watchPreviewTaskCount(value: unknown): number {
  const response = record(value);
  const taskIDs = response.task_ids ?? response.TaskIDs;
  return Array.isArray(taskIDs) ? taskIDs.length : 0;
}

function WatchRow({ host, watch, disabled, run, preview }: { host: PluginHost; watch: WatchSummary; disabled: boolean; run(key: string, watchId: string): void; preview(kind: "reset" | "delete", watchId: string): void }) {
  const { jsx: h, ui } = host;
  const toggleKey = watch.status === "running" ? action.watchesPause : action.watchesResume;
  return h(
    "li",
    { className: "bb-watch-row", key: watch.id },
    h("div", null, h("strong", null, watch.id), Badge(host, watch.status, watch.status === "running" ? "success" : "neutral"), watch.lastPolled ? h("span", null, `Last polled ${watch.lastPolled}`) : null),
    h("div", { className: "bb-secondary-actions" },
      h(ui.Button, { type: "button", variant: "outline", className: "min-h-11", disabled, onClick: () => run(action.watchesRun, watch.id) }, "Run now"),
      h(ui.Button, { type: "button", variant: "outline", className: "min-h-11", disabled, onClick: () => run(toggleKey, watch.id) }, watch.status === "running" ? "Pause" : "Resume"),
      h(ui.Button, { type: "button", variant: "ghost", className: "min-h-11", disabled, onClick: () => preview("reset", watch.id) }, "Reset"),
      h(ui.Button, { type: "button", variant: "destructive", className: "min-h-11", disabled, onClick: () => preview("delete", watch.id) }, "Delete"),
    ),
  );
}

function WatchConfirmation({ host, pending, disabled, confirm, cancel }: { host: PluginHost; pending: PendingWatchChange; disabled: boolean; confirm(): void; cancel(): void }) {
  const { jsx: h, ui } = host;
  return h(
    "div",
    { className: "bb-watch-confirm", role: "alert" },
    h("p", null, `${pending.kind === "delete" ? "Deleting" : "Resetting"} this watch will remove ${pending.taskCount} plugin-owned task${pending.taskCount === 1 ? "" : "s"}. Adopted and manual tasks stay untouched.`),
    h("div", { className: "bb-secondary-actions" },
      h(ui.Button, { type: "button", variant: "destructive", className: "min-h-11", disabled, onClick: confirm }, `Confirm ${pending.kind}`),
      h(ui.Button, { type: "button", variant: "outline", className: "min-h-11", disabled, onClick: cancel }, "Cancel"),
    ),
  );
}

function Watches({ host, workspaceId: scopedWorkspaceId, filter, showCreate = true }: { host: PluginHost; workspaceId?: string; filter: Record<string, unknown>; showCreate?: boolean }) {
  const { jsx: h, ui, React } = host;
  const watches = usePluginQuery<Record<string, unknown>>(host, action.watchesGet, scopedWorkspaceId ? { workspaceId: scopedWorkspaceId } : undefined, Boolean(scopedWorkspaceId));
  const [working, setWorking] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<PendingWatchChange | null>(null);
  const invoke = async (key: string, body: Record<string, unknown>) => {
    if (!scopedWorkspaceId) return null;
    setWorking(key);
    setError(null);
    try {
      const response = await host.api.invokeAction<unknown>(key, { workspaceId: scopedWorkspaceId, body });
      watches.refresh();
      return response;
    } catch (reason) {
      setError(errorMessage(reason));
      return null;
    } finally {
      setWorking(null);
    }
  };
  const run = (key: string, watchId: string) => { void invoke(key, { watch_id: watchId }); };
  const preview = async (kind: "reset" | "delete", watchId: string) => {
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
  return h(
    ui.Card,
    { className: "bb-watches" },
    h(ui.CardHeader, null, h(ui.CardTitle, null, "Watches"), h(ui.CardDescription, null, "Poll saved pull-request criteria and create only plugin-owned tasks.")),
    h(ui.CardContent, { className: "bb-card-actions" },
      watches.error ? h("p", { className: "bb-error", role: "alert" }, watches.error) : null,
      error ? h("p", { className: "bb-error", role: "alert" }, error) : null,
      watchItems.length ? h("ul", { className: "bb-watch-list" }, ...watchItems.map((watch) => h(WatchRow, { host, watch, disabled: Boolean(working), run, preview: (kind: "reset" | "delete", watchId: string) => void preview(kind, watchId) }))) : h("p", null, "No saved watches."),
      pending ? h(WatchConfirmation, { host, pending, disabled: Boolean(working), confirm: () => void confirm(), cancel: () => setPending(null) }) : null,
      showCreate ? h(ui.Button, { type: "button", variant: "outline", className: "min-h-11", disabled: Boolean(working), onClick: () => void invoke(action.watchesUpdate, { enabled: true, filter }) }, icon(h, "watch"), "Add current filter watch") : null,
    ),
  );
}

function repositoryFilter(host: PluginHost, repositories: RepositoryInspection[], repository: string, setRepository: (value: string) => void) {
  const { jsx: h, ui } = host;
  return h(
    ui.Select,
    { value: repository || "__all__", onValueChange: (value: string) => setRepository(value === "__all__" ? "" : value) },
    h(ui.SelectTrigger, { id: "bitbucket-repository-filter", className: "bb-repository-filter", "aria-label": "Repository" }, h(ui.SelectValue, { placeholder: "All repositories" })),
    h(ui.SelectContent, null, h(ui.SelectItem, { value: "__all__" }, "All repositories"), ...repositories.map((candidate) => h(ui.SelectItem, { key: candidate.repositoryId, value: candidate.repositoryId }, `${candidate.ownerOrProject}/${candidate.repositoryName}`))),
  );
}

type DashboardScopeSelection = {
  kind: "pull_requests";
  source: "preset" | "saved";
  id: string;
};

type DashboardScopeProps = {
  host: PluginHost;
  selection: DashboardScopeSelection;
  savedQueries: SavedQuery[];
  onSelect(selection: DashboardScopeSelection): void;
  onDeleteSaved(id: string): void;
  canSaveCurrent: boolean;
  onSaveCurrent(): void;
};

function StateScopeBar({
  host,
  selection,
  savedQueries,
  onSelect,
  onDeleteSaved,
  canSaveCurrent,
  onSaveCurrent,
}: DashboardScopeProps) {
  const { jsx: h, ui } = host;
  const presets = [
    { value: "open", label: "Open", iconName: "pull-request", group: "inbox" },
    { value: "all", label: "All", iconName: "filter", group: "inbox" },
    { value: "merged", label: "Merged", iconName: "merged", group: "created" },
    { value: "declined", label: "Declined", iconName: "pull-request-closed", group: "created" },
  ];
  return h(ui.IntegrationScopeBar, {
    testId: "bitbucket-scope-bar",
    savedMenuTestId: "bitbucket-saved-filters",
    kinds: [{ value: "pull_requests", label: "Pull requests" }],
    selected: selection,
    onSelect,
    presetsByKind: () => presets,
    savedPresets: savedQueries.map((query) => ({
      id: query.id,
      kind: "pull_requests",
      label: query.label,
    })),
    onDeleteSaved,
    canSaveCurrent,
    onSaveCurrent,
  });
}

function MobileFilters({ host, repositories, repository, setRepository, ...scope }: {
  host: PluginHost;
  repositories: RepositoryInspection[];
  repository: string;
  setRepository(value: string): void;
} & Omit<DashboardScopeProps, "host">) {
  const { jsx: h, ui, React } = host;
  const [open, setOpen] = React.useState(false);
  const mobileScope = {
    ...scope,
    onSelect(selection: DashboardScopeSelection) {
      scope.onSelect(selection);
      setOpen(false);
    },
    onSaveCurrent() {
      setOpen(false);
      scope.onSaveCurrent();
    },
  };
  return h(ui.Sheet, { open, onOpenChange: setOpen },
    h(ui.SheetTrigger, { asChild: true }, h(ui.Button, { type: "button", variant: "outline", className: "min-h-11", "aria-label": "Open Bitbucket filters" }, h(ui.IntegrationIcon, { name: "filter", className: "h-4 w-4" }), "Filters")),
    h(ui.SheetContent, { side: "left", className: "bb-filter-sheet" },
      h(ui.SheetHeader, null, h(ui.SheetTitle, null, "Bitbucket filters"), h(ui.SheetDescription, null, "Narrow pull requests by repository and state.")),
      h("div", { className: "bb-mobile-filter-fields" },
        h(StateScopeBar, { host, ...mobileScope }),
        h(ui.Label, { htmlFor: "bitbucket-repository-filter" }, "Repository"),
        repositoryFilter(host, repositories, repository, setRepository),
      ),
    ),
  );
}

function useHostStoreState(host: PluginHost): Record<string, unknown> {
  const { React } = host;
  const [state, setState] = React.useState(() => host.store.getState());
  React.useEffect(() => host.store.subscribe(() => setState(host.store.getState())), [host]);
  return state;
}

function ConnectionNotice({ host, connection, workspaceId }: { host: PluginHost; connection: QueryState<Record<string, unknown>>; workspaceId?: string }) {
  const { jsx: h, ui } = host;
  if (connection.loading) return h("div", { className: "bb-connection-loading" }, h(ui.Spinner, { "aria-label": "Checking Bitbucket connection" }));
  const state = connectionState(record(connection.data));
  if (state === "connected") return null;
  const checking = state === "checking";
  const message = connection.error ?? (checking ? "Kandev is verifying the saved connection." : "Connect Bitbucket for this workspace to load pull requests.");
  return h(ui.Alert, { className: "bb-connection-notice" }, h(ui.AlertTitle, null, checking ? "Checking Bitbucket connection" : "Bitbucket needs attention"), h(ui.AlertDescription, { className: "bb-notice-content" }, h("span", null, message), checking ? null : h(ui.Button, { type: "button", variant: "outline", className: "min-h-11", onClick: () => host.navigate(integrationSettingsHref(workspaceId)) }, "Configure Bitbucket")));
}

function BitbucketPage({ host }: { host: PluginHost }) {
  const { jsx: h, ui, React } = host;
  const responsive = host.useResponsiveBreakpoint();
  const activeWorkspaceId = useActiveWorkspaceId(host);
  const hostState = useHostStoreState(host);
  const initialQuery = pullRequestScopeQuery("open");
  const [searchDraft, setSearchDraft] = React.useState(initialQuery);
  const [search, setSearch] = React.useState(initialQuery);
  const [state, setState] = React.useState("open");
  const [repository, setRepository] = React.useState("");
  const [scopeSelection, setScopeSelection] = React.useState<DashboardScopeSelection>({
    kind: "pull_requests",
    source: "preset",
    id: "open",
  });
  const [saveDialogOpen, setSaveDialogOpen] = React.useState(false);
  const savedQueries = useSavedQueries(host, activeWorkspaceId);
  const [launch, setLaunch] = React.useState<{
    pullRequest: PullRequest;
    preset: TaskLaunchPreset;
    launchId: string;
  } | null>(null);
  const pluginCreatedTaskIDs = React.useRef<Set<string>>(new Set());
  const connection = usePluginQuery<Record<string, unknown>>(
    host,
    action.connectionGet,
    activeWorkspaceId ? { workspaceId: activeWorkspaceId } : undefined,
    Boolean(activeWorkspaceId),
  );
  const connected = connectionState(record(connection.data)) === "connected";
  const repositoriesQuery = usePluginQuery<unknown>(host, action.repositoriesList, activeWorkspaceId ? { workspaceId: activeWorkspaceId } : undefined, Boolean(activeWorkspaceId && connected));
  const repositories = normalizeRepositories(repositoriesQuery.data);
  const selectedRepository = repositories.find((candidate) => candidate.repositoryId === repository) ?? null;
  const queueRequest = pullRequestListRequest(selectedRepository, search, state);
  const queue = usePluginQuery<Record<string, unknown>>(
    host,
    queueRequest.actionKey,
    activeWorkspaceId ? { workspaceId: activeWorkspaceId, body: queueRequest.body } : undefined,
    Boolean(activeWorkspaceId && connected),
  );
  const pullRequests = normalizePullRequests(queue.data);
  const associations = usePluginQuery<unknown>(
    host,
    action.pullRequestsAssociations,
    activeWorkspaceId ? { workspaceId: activeWorkspaceId, body: { review_keys: pullRequests.map((pullRequest) => pullRequest.key) } } : undefined,
    Boolean(activeWorkspaceId && connected && pullRequests.length),
  );
  const tasksByReview = normalizePullRequestAssociations(associations.data);
  const createContext = taskCreateContext(hostState, activeWorkspaceId);
  const noWorkspace = !activeWorkspaceId;
  const commitSearch = () => {
    const committed = searchDraft.trim();
    setSearch(committed);
    setState(parsePullRequestListQuery(committed, state).state);
  };
  const selectScopeState = (nextState: string) => {
    const query = pullRequestScopeQuery(nextState);
    setState(nextState);
    setSearchDraft(query);
    setSearch(query);
    setScopeSelection({ kind: "pull_requests", source: "preset", id: nextState });
  };
  const selectDashboardScope = (selection: DashboardScopeSelection) => {
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
  const deleteSavedQuery = (id: string) => {
    savedQueries.remove(id);
    if (scopeSelection.source === "saved" && scopeSelection.id === id) selectScopeState("open");
  };
  const saveCurrentQuery = async (label: string, defaultRepositoryId: string) => {
    const query = searchDraft.trim();
    const parsed = parsePullRequestListQuery(query, state);
    const created = await savedQueries.save({
      label,
      query,
      repositoryId: defaultRepositoryId,
      state: parsed.state,
    });
    setSearch(query);
    setState(parsed.state);
    setScopeSelection({ kind: "pull_requests", source: "saved", id: created.id });
    setRepository(defaultRepositoryId);
  };
  const canSaveCurrent = canSaveDashboardQuery(searchDraft, repository);
  const scopeProps: Omit<DashboardScopeProps, "host"> = {
    selection: scopeSelection,
    savedQueries: savedQueries.queries,
    onSelect: selectDashboardScope,
    onDeleteSaved: deleteSavedQuery,
    canSaveCurrent,
    onSaveCurrent: () => {
      if (canSaveCurrent) setSaveDialogOpen(true);
    },
  };
  const finishTaskCreation = async (taskValue: unknown) => {
    const taskId = text(record(taskValue).id);
    if (!activeWorkspaceId || !launch || !taskId) return;
    const linkedByLaunch = pluginCreatedTaskIDs.current.delete(taskId);
    try {
      if (!linkedByLaunch) {
        await host.api.invokeAction(action.pullRequestsLink, {
          workspaceId: activeWorkspaceId,
          taskId,
          body: { review_key: launch.pullRequest.key, pull_request_id: launch.pullRequest.id },
        });
      }
      associations.refresh();
    } catch {
      // Task creation succeeded; the task menu can retry linking if Bitbucket rejects it.
    } finally {
      setLaunch(null);
      host.navigate(`/tasks/${encodeURIComponent(taskId)}`);
    }
  };
  const selectedHostRepositoryId = launch && createContext
    ? matchingHostRepositoryId(createContext.repositories, launch.pullRequest)
    : undefined;
  const launchRemoteRepository = launch
    ? repositories.find((candidate) => candidate.repositoryId === launch.pullRequest.repositoryId)
    : undefined;
  const createBitbucketTask = async (payload: Record<string, unknown>) => {
    if (!activeWorkspaceId || !launch) throw new Error("Bitbucket task launch is unavailable.");
    const result = await host.api.invokeAction<Record<string, unknown>>(action.tasksLaunch, {
      workspaceId: activeWorkspaceId,
      body: taskLaunchBody(launch.pullRequest, payload, launch.launchId),
    });
    const task = taskFromLaunchResult(result);
    const taskId = text(task.id);
    if (task.bitbucketLinked === true) pluginCreatedTaskIDs.current.add(taskId);
    associations.refresh();
    return task;
  };
  const taskDialog = launch && createContext
    ? h(ui.TaskCreateDialog, {
        open: true,
        onOpenChange: (open: boolean) => { if (!open) setLaunch(null); },
        mode: "create",
        workspaceId: activeWorkspaceId ?? null,
        workflowId: createContext.workflowId,
        defaultStepId: createContext.defaultStepId,
        steps: createContext.steps,
        initialValues: taskDialogInitialValues(
          launch.pullRequest,
          launch.preset,
          selectedHostRepositoryId,
          launchRemoteRepository,
        ),
        createTask: usePluginTaskCreation(selectedHostRepositoryId)
          ? createBitbucketTask
          : undefined,
        onSuccess: (task: unknown) => void finishTaskCreation(task),
      })
    : null;
  const filter = responsive.isMobile
    ? h(MobileFilters, { host, repositories, repository, setRepository, ...scopeProps })
    : repositoryFilter(host, repositories, repository, setRepository);
  const workbenchBody = !connected
    ? null
    : [
        responsive.isMobile ? null : h(StateScopeBar, { host, ...scopeProps }),
        h(ui.IntegrationListToolbar, {
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
          queryPlaceholder: 'Custom query — press Enter. e.g. "state:open fix login"',
          titleTestId: "bitbucket-list-toolbar",
          queryTestId: "bitbucket-list-query",
          refreshTestId: "bitbucket-list-refresh",
        }),
        h("section", { className: "bb-results", "data-testid": "bitbucket-results", "aria-label": "Pull request results" },
          h(DashboardPullRequestList, {
            host,
            pullRequests,
            loading: queue.loading,
            error: queue.error,
            tasksByReview,
            onStartTask: (pullRequest: PullRequest, preset: TaskLaunchPreset) => setLaunch({
              pullRequest,
              preset,
              launchId: globalThis.crypto.randomUUID(),
            }),
          }),
        ),
        taskDialog,
        h(ui.IntegrationSaveQueryDialog, {
          open: saveDialogOpen,
          onOpenChange: setSaveDialogOpen,
          description: "Save this Bitbucket pull-request search for the current workspace.",
          suggestedLabel: searchDraft.trim() || (repository ? "Repository pull requests" : "Saved query"),
          query: searchDraft,
          repositoryId: repository,
          repositoryOptions: repositories.map((candidate) => ({
            value: candidate.repositoryId,
            label: `${candidate.ownerOrProject}/${candidate.repositoryName}`,
          })),
          onSave: saveCurrentQuery,
        }),
      ];
  return h(
    "main",
    { className: `bb-workbench ${responsive.isMobile ? "bb-mobile" : "bb-desktop"}`, "data-testid": "bitbucket-workbench" },
    noWorkspace
      ? EmptyState(host, "Choose a workspace", "Open Bitbucket from a workspace to connect and browse pull requests.")
      : [h(ConnectionNotice, { host, connection, workspaceId: activeWorkspaceId }), workbenchBody],
  );
}

function registerNativeIntegrations(registry: PluginRegistry, host: PluginHost) {
  registry.registerRepositoryProvider({
    id: "bitbucket",
    label: "Bitbucket",
    icon: "bitbucket",
    async listRepositories({ workspaceId: scopedWorkspaceId, signal }) {
      const response = await host.api.invokeAction<unknown>(action.repositoriesList, { workspaceId: scopedWorkspaceId }, { signal });
      if (signal.aborted) return [];
      return normalizeRepositories(response);
    },
    matchesURL(url) {
      return /(?:^git@bitbucket\.org:|^https?:\/\/[^/]*bitbucket[^/]*\/|\/scm\/)/i.test(url);
    },
    async listBranches({ workspaceId: scopedWorkspaceId, repository, signal }) {
      const response = await host.api.invokeAction<Record<string, unknown>>(action.repositoriesBranches, { workspaceId: scopedWorkspaceId, body: { repository: pluginRepositoryInput(repository) } }, { signal });
      if (signal.aborted) return [];
      const branches = record(response).branches;
      return Array.isArray(branches) ? branches : [];
    },
    async inspectURL({ workspaceId: scopedWorkspaceId, url, signal }) {
      const response = await host.api.invokeAction<unknown>(action.repositoriesInspect, { workspaceId: scopedWorkspaceId, body: { url } }, { signal });
      return signal.aborted ? null : normalizeRepositoryInspection(response);
    },
    supportsDraft: false,
    async createChangeRequest({
      workspaceId,
      taskId,
      repositoryId,
      title,
      body,
      baseBranch,
      signal,
    }) {
      const response = await host.api.invokeAction<Record<string, unknown>>(
        action.pullRequestsCreate,
        {
          workspaceId,
          taskId,
          repositoryId,
          body: {
            title,
            description: body,
            ...(baseBranch ? { destination: baseBranch } : {}),
          },
        },
        { signal },
      );
      void Promise.all([
        refreshReviewStore(host, taskId, new AbortController().signal, workspaceId),
        refreshAssociationStore(host, workspaceId, new AbortController().signal),
      ]).catch(() => undefined);
      return {
        url: text(response.url),
        provider: "bitbucket",
      };
    },
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
            body,
          });
          void refreshReviewStore(
            host,
            context.taskId,
            new AbortController().signal,
            context.workspaceId,
          ).catch(() => undefined);
          void refreshAssociationStore(
            host,
            context.workspaceId,
            new AbortController().signal,
          ).catch(() => undefined);
        },
      });
    },
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
    subscribeAssociations: (workspaceId, listener) =>
      associationStore.subscribe(workspaceId, listener),
    async refreshAssociations(workspaceId, signal) {
      await refreshAssociationStore(host, workspaceId, signal);
    },
    async unlink({ workspaceId, taskId, reviewKey, signal }) {
      await host.api.invokeAction(
        action.pullRequestsUnlink,
        { workspaceId, taskId, body: { review_key: reviewKey } },
        { signal },
      );
    },
    ReviewPanel: (props = {}) =>
      h(ReviewDetailPanel, {
        host,
        workspaceId: text(props.workspaceId) || undefined,
        taskId: text(props.taskId) || undefined,
        reviewKey: text(props.reviewKey),
        presentation: text(props.presentation) === "mobile" ? "mobile" : "desktop",
      }),
  });
}

function makeIntegrationSettings(host: PluginHost): Component {
  return function IntegrationSettings(props = {}) {
    const activeWorkspaceId = useActiveWorkspaceId(host);
    const scopedWorkspaceId = text(props.workspaceId) || activeWorkspaceId;
    return host.jsx("div", { className: "bb-plugin-settings" }, host.jsx(ConnectionHealth, { host, workspaceId: scopedWorkspaceId }), host.jsx(Watches, { host, workspaceId: scopedWorkspaceId, filter: {}, showCreate: false }));
  };
}

function makeTopbarActions(host: PluginHost): Component {
  return function TopbarActions() {
    const activeWorkspaceId = useActiveWorkspaceId(host);
    return host.jsx(host.ui.Button, { type: "button", variant: "ghost", size: "sm", className: "bb-topbar-settings", "aria-label": "Open Bitbucket settings", onClick: () => host.navigate(integrationSettingsHref(activeWorkspaceId)) }, "Settings");
  };
}

const h = (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => currentHost?.jsx(type, props, ...children);
let currentHost: PluginHost | null = null;

declare global {
  interface Window {
    registerKandevPlugin(id: string, lifecycle: { initialize(registry: PluginRegistry, host: PluginHost): void; destroy?(): void }): void;
  }
}

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
      Component: makeIntegrationSettings(host),
    });
    registerNativeIntegrations(registry, host);
  },
  destroy() {
    reviewStore.clear();
    associationStore.clear();
    currentHost = null;
  },
});

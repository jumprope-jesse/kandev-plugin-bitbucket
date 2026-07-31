import {
  activeWorkspaceIdFromState,
  connectionActionBody,
  connectionIdentity,
  connectionOAuthRegistration,
  connectionSaveBody,
  connectionState,
  currentWatchFilter,
  deriveOAuthCallbackURL,
  disconnectConnectionInput,
  errorMessage,
  linkPullRequestBody,
  launchPresets,
  normalizePullRequests,
  normalizeRepositories,
  normalizeRepositoryInspection,
  normalizeReviewDetail,
  normalizeWatches,
  oauthStartInput,
  pluginRepositoryInput,
  pullRequestCreateBody,
  statusTone,
  taskSupportsBitbucketRepository,
  workspacePullRequestAction,
  workspaceReviewAction,
  type ConnectionState,
  type PullRequest,
  type RepositoryInspection,
  type ReviewDetail,
  type WatchSummary,
  validateCloudWorkspace,
  validateConnectionIdentity,
  validateOAuthRegistration,
} from "./view-models";

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
};

type PluginRegistry = {
  registerRoute(path: string, component: Component, options?: Record<string, unknown>): void;
  registerNavItem(item: { id: string; label: string; path: string; icon: string; section: "integrations" }): void;
  registerComponent(slot: string, component: Component): void;
  registerRepositoryProvider(provider: {
    id: string;
    label: string;
    icon: string;
    listRepositories(context: { workspaceId: string; signal: AbortSignal }): Promise<RepositoryInspection[]>;
    matchesURL(url: string): boolean;
    listBranches(context: { workspaceId: string; repository: RepositoryInspection; signal: AbortSignal }): Promise<unknown[]>;
    inspectURL(context: { workspaceId: string; url: string; signal: AbortSignal }): Promise<RepositoryInspection | null>;
  }): void;
  registerTaskAction(action: {
    id: string;
    label: string;
    icon: string;
    placement: "link" | "action";
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
    ReviewPanel: Component;
  }): void;
};

type ReviewSummary = {
  providerId: "bitbucket";
  reviewKey: string;
  title: string;
  url: string;
  repositoryId: string;
  state: string;
  statusBadge?: { label: string; tone?: string };
};

type QueryState<T> = { data: T | null; loading: boolean; error: string | null; refresh(): void };

const PLUGIN_ID = "kandev-plugin-bitbucket";
const action = {
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
  watchesDelete: "watches.delete",
} as const;

const reviewStore = (() => {
  const snapshots = new Map<string, ReviewSummary[]>();
  const listeners = new Map<string, Set<() => void>>();
  return {
    get(taskId: string): readonly ReviewSummary[] {
      return snapshots.get(taskId) ?? [];
    },
    set(taskId: string, pullRequests: PullRequest[]) {
      snapshots.set(
        taskId,
        pullRequests.map((pullRequest) => ({
          providerId: "bitbucket",
          reviewKey: pullRequest.key,
          title: pullRequest.title,
          url: pullRequest.url,
          repositoryId: pullRequest.repositoryId,
          state: pullRequest.state,
          statusBadge: pullRequest.statusLabel
            ? { label: pullRequest.statusLabel, tone: pullRequest.statusTone }
            : undefined,
        })),
      );
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
  const [state, setState] = React.useState<{ data: T | null; loading: boolean; error: string | null }>({
    data: null,
    loading: enabled,
    error: null,
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
    void host.api
      .invokeAction<T>(key, requestBody(JSON.parse(serializedInput) as ActionInput), {
        signal: controller.signal,
      })
      .then((data) => {
        if (active) setState({ data, loading: false, error: null });
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
    bitbucket: "M5 4h14l-1.6 15H6.6L5 4Zm4 4 1.2 7h3.6L15 8H9Z",
    filter: "M4 6h16M7 12h10m-7 6h4",
    plus: "M12 5v14M5 12h14",
    link: "M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1",
    refresh: "M20 11a8 8 0 1 0 2 5.2M20 4v7h-7",
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
    h("path", { d: paths[name] ?? paths.bitbucket }),
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
      { className: "bb-card-actions" },
      connection.loading ? h(ui.Spinner, { "aria-label": "Checking Bitbucket connection" }) : null,
      connection.error ? h("p", { className: "bb-error", role: "alert" }, connection.error) : null,
      message ? h("p", { className: "bb-message", role: "status" }, message) : null,
      h(ui.Button, { type: "button", variant: "outline", className: "min-h-11", disabled: saving, onClick: saveConnection }, "Check connection"),
      h(ui.Button, { type: "button", variant: "outline", className: "min-h-11", disabled: saving || !scopedWorkspaceId, onClick: openDisconnectConfirmation }, "Disconnect Bitbucket"),
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

function QueueList({
  host,
  pullRequests,
  selectedKey,
  onSelect,
}: {
  host: PluginHost;
  pullRequests: PullRequest[];
  selectedKey: string | null;
  onSelect(pullRequest: PullRequest): void;
}) {
  const { jsx: h } = host;
  return h(
    "ul",
    { className: "bb-queue", "data-testid": "bitbucket-pr-queue" },
    ...pullRequests.map((pullRequest) =>
      h(
        "li",
        { key: pullRequest.key },
        h(
          "button",
          {
            type: "button",
            className: `bb-queue-row ${selectedKey === pullRequest.key ? "is-selected" : ""}`,
            "aria-current": selectedKey === pullRequest.key ? "page" : undefined,
            onClick: () => onSelect(pullRequest),
          },
          h("span", { className: "bb-queue-title" }, `#${pullRequest.number} ${pullRequest.title}`),
          h("span", { className: "bb-queue-meta" }, `${pullRequest.repositoryName} · ${pullRequest.author ?? "Unknown"}`),
          h("span", { className: "bb-queue-status" }, Badge(host, pullRequest.statusLabel ?? pullRequest.state, pullRequest.statusTone)),
        ),
      ),
    ),
  );
}

function RepositoryBrowser({ host, workspaceId, onChoose }: { host: PluginHost; workspaceId?: string; onChoose(repositoryName: string): void }) {
  const { jsx: h, ui } = host;
  const query = usePluginQuery<unknown>(host, action.repositoriesList, workspaceId ? { workspaceId } : undefined, Boolean(workspaceId));
  const repositories = normalizeRepositories(query.data);
  return h(
    ui.Card,
    { className: "bb-repositories", "data-testid": "bitbucket-repository-browser" },
    h(ui.CardHeader, null, h(ui.CardTitle, null, "Repositories"), h(ui.CardDescription, null, "Browse connected Bitbucket repositories or filter the pull-request queue.")),
    h(ui.CardContent, { className: "bb-card-actions" },
      query.error ? h("p", { className: "bb-error", role: "alert" }, query.error) : null,
      query.loading ? h(ui.Spinner, { "aria-label": "Loading Bitbucket repositories" }) : null,
      !query.loading && !repositories.length ? h("p", { className: "bb-capability-note" }, "No repositories available for this connection.") : null,
      repositories.length
        ? h(
            "ul",
            { className: "bb-repository-list" },
            ...repositories.map((repository) =>
              h(
                "li",
                { key: repository.repositoryId },
                h(
                  ui.Button,
                  { type: "button", variant: "ghost", className: "min-h-11", onClick: () => onChoose(repository.repositoryName) },
                  h("span", null, `${repository.ownerOrProject}/${repository.repositoryName}`),
                  repository.defaultBranch ? h("small", null, repository.defaultBranch) : null,
                ),
              ),
            ),
          )
        : null,
    ),
  );
}

function PullRequestActions({ host, pullRequest, workspaceId, taskId, onChanged }: { host: PluginHost; pullRequest: PullRequest; workspaceId?: string; taskId?: string; onChanged(): void }) {
  const { jsx: h, ui, React } = host;
  const [working, setWorking] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [comment, setComment] = React.useState("");
  const request = useAbortableAction(host);
  const invoke = async (key: string, resourceInput: ActionInput) => {
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
  const runTaskAction = (key: string) => {
    if (!workspaceId) return;
    return invoke(key, key === action.pullRequestsLink
      ? { workspaceId, taskId, body: { review_key: pullRequest.key, pull_request_id: pullRequest.id } }
      : workspacePullRequestAction(workspaceId, pullRequest.key, pullRequest.id));
  };
  const runReviewAction = (kind: string, nextComment?: string) => {
    if (!workspaceId) return;
    return invoke(
      action.reviewsAction,
      workspaceReviewAction(workspaceId, pullRequest.key, pullRequest.id, kind, { comment: nextComment }),
    );
  };
  const can = (capability: string) => pullRequest.capabilities.includes(capability);
  const isMobile = host.useResponsiveBreakpoint().isMobile;
  const stopWaiting = () =>
    h(ui.Button, { type: "button", variant: "outline", className: "min-h-11", onClick: request.cancel }, "Stop waiting");
  const secondaryActions = h(
    "div",
    { className: "bb-secondary-actions" },
    isMobile && working ? stopWaiting() : null,
    taskId && can("link")
      ? h(ui.Button, { type: "button", variant: "outline", className: "min-h-11", disabled: Boolean(working), onClick: () => void runTaskAction(action.pullRequestsLink) }, "Link to task")
      : null,
    can("approve")
      ? h(ui.Button, { type: "button", variant: "outline", className: "min-h-11", disabled: Boolean(working), onClick: () => void runReviewAction("approve") }, "Approve")
      : null,
    can("approve")
      ? h(ui.Button, { type: "button", variant: "ghost", className: "min-h-11", disabled: Boolean(working), onClick: () => void runReviewAction("unapprove") }, "Remove approval")
      : null,
    can("merge")
      ? h(ui.Button, { type: "button", variant: "outline", className: "min-h-11", disabled: Boolean(working), onClick: () => void runReviewAction("merge") }, "Merge")
      : null,
    can("decline")
      ? h(ui.Button, { type: "button", variant: "ghost", className: "min-h-11", disabled: Boolean(working), onClick: () => void runReviewAction("decline") }, "Decline")
      : null,
  );
  return h(
    "div",
    { className: "bb-review-actions" },
    error ? h("p", { className: "bb-error", role: "alert" }, error) : null,
    working ? stopWaiting() : null,
    can("launch_task")
      ? h(ui.Button, { type: "button", className: "min-h-11", disabled: Boolean(working), onClick: () => void runTaskAction(action.pullRequestsLaunch) }, working === action.pullRequestsLaunch ? "Launching…" : "Launch task")
      : null,
    isMobile
      ? h(ui.Drawer, null, h(ui.DrawerTrigger, { asChild: true }, h(ui.Button, { type: "button", variant: "outline", className: "min-h-11" }, "Review actions")), h(ui.DrawerContent, { className: "bb-actions-drawer" }, h(ui.DrawerHeader, null, h(ui.DrawerTitle, null, "Pull request actions"), h(ui.DrawerDescription, null, "Actions available for this Bitbucket pull request.")), h("div", { className: "bb-drawer-scroll" }, secondaryActions)))
      : secondaryActions,
    can("comments")
      ? h("form", { className: "bb-review-comment", onSubmit: (event: { preventDefault(): void }) => { event.preventDefault(); if (comment.trim()) void runReviewAction("add_comment", comment); } }, h(ui.Label, { htmlFor: `bitbucket-comment-${pullRequest.id}` }, "Add review comment"), h(ui.Textarea, { id: `bitbucket-comment-${pullRequest.id}`, className: "min-h-11", value: comment, onChange: (event: { target: { value: string } }) => setComment(event.target.value) }), h(ui.Button, { type: "submit", variant: "outline", className: "min-h-11", disabled: Boolean(working) || !comment.trim() }, "Comment"))
      : null,
    !pullRequest.capabilities.length ? h("p", { className: "bb-capability-note" }, "This Bitbucket server did not report available review actions.") : null,
  );
}

function ThreadReply({ host, workspaceId, pullRequest, threadId, onChanged }: { host: PluginHost; workspaceId?: string; pullRequest: PullRequest; threadId: string; onChanged(): void }) {
  const { jsx: h, ui, React } = host;
  const [comment, setComment] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
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
        { comment, parentCommentId: threadId },
      ));
      setComment("");
      onChanged();
    } catch (reason) {
      if (!isAbortError(reason)) setError(errorMessage(reason));
    } finally {
      setWorking(false);
    }
  };
  return h("form", { className: "bb-thread-reply", onSubmit: (event: { preventDefault(): void }) => { event.preventDefault(); void submit(); } }, error ? h("p", { className: "bb-error", role: "alert" }, error) : null, h(ui.Label, { htmlFor: `bitbucket-reply-${threadId}` }, "Reply"), h(ui.Textarea, { id: `bitbucket-reply-${threadId}`, className: "min-h-11", value: comment, onChange: (event: { target: { value: string } }) => setComment(event.target.value) }), h(ui.Button, { type: "submit", variant: "outline", className: "min-h-11", disabled: working || !comment.trim() }, working ? "Replying…" : "Reply"), working ? h(ui.Button, { type: "button", variant: "ghost", className: "min-h-11", onClick: request.cancel }, "Stop waiting") : null);
}

function ReviewDetailPanel({ host, workspaceId: scopedWorkspaceId, taskId, reviewKey, onBack }: { host: PluginHost; workspaceId?: string; taskId?: string; reviewKey: string; onBack?: () => void }) {
  const { jsx: h, ui, React } = host;
  const review = usePluginQuery<Record<string, unknown>>(
    host,
    taskId ? action.pullRequestsGet : action.pullRequestsInspect,
    taskId
      ? { taskId, body: { review_key: reviewKey, include: ["files", "commits", "participants", "threads", "status"] } }
      : scopedWorkspaceId
        ? { workspaceId: scopedWorkspaceId, body: { review_key: reviewKey, include: ["files", "commits", "participants", "threads", "status"] } }
        : undefined,
    Boolean((taskId || scopedWorkspaceId) && reviewKey),
  );
  const [tab, setTab] = React.useState("files");
  const detail = normalizeReviewDetail(review.data);
  if (review.loading && !detail) return h("div", { className: "bb-detail-loading" }, h(ui.Spinner, { "aria-label": "Loading pull request" }));
  if (review.error) return EmptyState(host, "Could not load pull request", review.error, "Retry", review.refresh);
  if (!detail) return EmptyState(host, "Select a pull request", "Choose a Bitbucket pull request from the queue to inspect its review.");
  return h(
    "section",
    { className: "bb-review-detail", "data-testid": "bitbucket-review-detail" },
    onBack
      ? h(ui.Button, { type: "button", variant: "ghost", className: "bb-back min-h-11", onClick: onBack, "aria-label": "Back to pull request queue" }, icon(h, "back"), "Queue")
      : null,
    h("header", { className: "bb-detail-header" }, h("div", null, h("p", { className: "bb-eyebrow" }, `${detail.repositoryName} · #${detail.number}`), h("h1", null, detail.title), detail.description ? h("p", null, detail.description) : null), Badge(host, detail.statusLabel ?? detail.state, detail.statusTone)),
    h("p", { className: "bb-branches" }, `${detail.sourceBranch ?? "source"} → ${detail.destinationBranch ?? "destination"}`),
    h(PullRequestActions, { host, pullRequest: detail, workspaceId: scopedWorkspaceId, taskId, onChanged: review.refresh }),
    h(
      ui.Tabs,
      { value: tab, onValueChange: setTab, className: "bb-review-tabs" },
      h(ui.TabsList, { className: "bb-tabs-list min-h-11", "aria-label": "Pull request detail" }, h(ui.TabsTrigger, { value: "files", className: "min-h-11" }, `Files (${detail.files.length})`), h(ui.TabsTrigger, { value: "commits", className: "min-h-11" }, `Commits (${detail.commits.length})`), h(ui.TabsTrigger, { value: "people", className: "min-h-11" }, `People (${detail.participants.length})`), h(ui.TabsTrigger, { value: "threads", className: "min-h-11" }, `Threads (${detail.threads.length})`), h(ui.TabsTrigger, { value: "builds", className: "min-h-11" }, `Builds (${detail.statuses.length})`)),
      h(
        ui.TabsContent,
        { value: "files" },
        h(
          "ul",
          { className: "bb-detail-list" },
          ...detail.files.map((file) =>
            h(
              "li",
              { key: file.path },
              h("strong", null, file.path),
              h("span", null, `${file.status}${file.additions !== undefined ? ` · +${file.additions}` : ""}${file.deletions !== undefined ? ` / -${file.deletions}` : ""}`),
              file.patch ? h("pre", { className: "bb-patch" }, file.patch) : null,
            ),
          ),
        ),
      ),
      h(
        ui.TabsContent,
        { value: "commits" },
        h(
          "ul",
          { className: "bb-detail-list" },
          ...detail.commits.map((commit) =>
            h("li", { key: commit.id }, h("strong", null, commit.message), h("span", null, `${commit.id.slice(0, 8)}${commit.author ? ` · ${commit.author}` : ""}`)),
          ),
        ),
      ),
      h(
        ui.TabsContent,
        { value: "people" },
        h(
          "ul",
          { className: "bb-detail-list" },
          ...detail.participants.map((person) =>
            h("li", { key: person.name }, h("strong", null, person.name), h("span", null, `${person.role ?? "participant"}${person.approved ? " · approved" : ""}`)),
          ),
        ),
      ),
      h(
        ui.TabsContent,
        { value: "threads" },
        h(
          "ul",
          { className: "bb-detail-list" },
          ...detail.threads.map((thread) =>
            h(
              "li",
              { key: thread.id },
              thread.file ? h("span", null, thread.file) : null,
              ...thread.comments.map((comment) =>
                h(
                  "article",
                  { key: comment.id, className: "bb-thread-comment" },
                  h("strong", null, comment.author),
                  h("p", null, comment.body),
                ),
              ),
              Badge(host, thread.resolved ? "Resolved" : "Open", thread.resolved ? "success" : "warning"),
              detail.capabilities.includes("thread_replies")
                ? h(ThreadReply, {
                    host,
                    workspaceId: scopedWorkspaceId,
                    pullRequest: detail,
                    threadId: thread.id,
                    onChanged: review.refresh,
                  })
                : null,
            ),
          ),
        ),
      ),
      h(
        ui.TabsContent,
        { value: "builds" },
        h(
          "ul",
          { className: "bb-detail-list" },
          ...detail.statuses.map((status) =>
            h(
              "li",
              { key: status.key },
              h("strong", null, status.name),
              status.target ? h("span", null, status.target) : null,
              Badge(host, status.state, statusTone(status.state)),
              status.url
                ? h("a", { href: status.url, target: "_blank", rel: "noreferrer" }, "Open build")
                : null,
            ),
          ),
        ),
      ),
    ),
  );
}

function LaunchPresets({ host, workspaceId: scopedWorkspaceId, pullRequest }: { host: PluginHost; workspaceId?: string; pullRequest: PullRequest | null }) {
  const { jsx: h, ui, React } = host;
  const presets = launchPresets();
  const [preset, setPreset] = React.useState("default");
  const [message, setMessage] = React.useState<string | null>(null);
  const launch = async () => {
    if (!scopedWorkspaceId || !pullRequest || !preset) return;
    try {
      await host.api.invokeAction(action.pullRequestsLaunch, { workspaceId: scopedWorkspaceId, body: { review_key: pullRequest.key, preset } });
      setMessage("Task launch requested.");
    } catch (error) {
      setMessage(errorMessage(error));
    }
  };
  return h(
    ui.Card,
    { className: "bb-launch" },
    h(ui.CardHeader, null, h(ui.CardTitle, null, "Launch preset"), h(ui.CardDescription, null, "Choose how Kandev should start work from this pull request.")),
    h(
      ui.CardContent,
      { className: "bb-card-actions" },
      h(
        ui.Select,
        { value: preset, onValueChange: setPreset },
        h(ui.SelectTrigger, { className: "min-h-11" }, h(ui.SelectValue, { placeholder: "Launch preset" })),
        h(ui.SelectContent, null, ...presets.map((candidate) => h(ui.SelectItem, { value: candidate.id, key: candidate.id }, candidate.name))),
      ),
      h(ui.Button, { type: "button", className: "min-h-11", disabled: !pullRequest || !preset, onClick: () => void launch() }, "Launch task"),
      message ? h("p", { role: "status", className: "bb-message" }, message) : null,
    ),
  );
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

function Watches({ host, workspaceId: scopedWorkspaceId, filter }: { host: PluginHost; workspaceId?: string; filter: Record<string, unknown> }) {
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
      h(ui.Button, { type: "button", variant: "outline", className: "min-h-11", disabled: Boolean(working), onClick: () => void invoke(action.watchesUpdate, { enabled: true, filter }) }, icon(h, "watch"), "Add current filter watch"),
    ),
  );
}

function QueueFilters({ host, mobile, search, setSearch, state, setState }: { host: PluginHost; mobile: boolean; search: string; setSearch(value: string): void; state: string; setState(value: string): void }) {
  const { jsx: h, ui } = host;
  const controls = h(
    "div",
    { className: "bb-filters" },
    h(ui.Label, { htmlFor: "bitbucket-search" }, "Search pull requests"),
    h(ui.Input, { id: "bitbucket-search", className: "min-h-11", value: search, onChange: (event: { target: { value: string } }) => setSearch(event.target.value), placeholder: "Title, author, or repository" }),
    h(ui.Label, { htmlFor: "bitbucket-state" }, "State"),
    h(ui.Select, { value: state, onValueChange: setState }, h(ui.SelectTrigger, { id: "bitbucket-state", className: "min-h-11" }, h(ui.SelectValue, null)), h(ui.SelectContent, null, h(ui.SelectItem, { value: "open" }, "Open"), h(ui.SelectItem, { value: "all" }, "All"), h(ui.SelectItem, { value: "merged" }, "Merged"), h(ui.SelectItem, { value: "declined" }, "Declined"))),
  );
  if (!mobile) return controls;
  return h(
    ui.Drawer,
    null,
    h(ui.DrawerTrigger, { asChild: true }, h(ui.Button, { type: "button", variant: "outline", className: "min-h-11", "aria-label": "Filter pull requests" }, icon(h, "filter"), "Filters")),
    h(
      ui.DrawerContent,
      { className: "bb-filter-drawer" },
      h(ui.DrawerHeader, null, h(ui.DrawerTitle, null, "Queue filters"), h(ui.DrawerDescription, null, "Narrow Bitbucket pull requests without leaving the queue.")),
      h("div", { className: "bb-drawer-scroll" }, controls),
      h(ui.DrawerFooter, { className: "bb-safe-drawer-footer" }, h(ui.DrawerClose, { asChild: true }, h(ui.Button, { type: "button", className: "min-h-11" }, "Done"))),
    ),
  );
}

function BitbucketPage({ host }: { host: PluginHost }) {
  const { jsx: h, ui, React } = host;
  const responsive = host.useResponsiveBreakpoint();
  const activeWorkspaceId = useActiveWorkspaceId(host);
  const [search, setSearch] = React.useState("");
  const [state, setState] = React.useState("open");
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null);
  const queue = usePluginQuery<Record<string, unknown>>(
    host,
    action.pullRequestsQueue,
    activeWorkspaceId ? { workspaceId: activeWorkspaceId, body: { view: "queue", query: search, state } } : undefined,
    Boolean(activeWorkspaceId),
  );
  const pullRequests = normalizePullRequests(queue.data);
  const watchFilter = currentWatchFilter(search, state);
  const selected = pullRequests.find((pullRequest) => pullRequest.key === selectedKey) ?? null;
  const select = (pullRequest: PullRequest) => setSelectedKey(pullRequest.key);
  const noWorkspace = !activeWorkspaceId;
  const desktop = !responsive.isMobile;
  const queueContent = queue.loading && pullRequests.length === 0
    ? h("div", { className: "bb-loading" }, h(ui.Spinner, { "aria-label": "Loading Bitbucket pull request queue" }))
    : queue.error
      ? EmptyState(host, "Queue unavailable", queue.error, "Retry", queue.refresh)
      : pullRequests.length === 0
        ? EmptyState(host, "No pull requests", "Adjust filters or connect a Bitbucket workspace.")
        : h(QueueList, { host, pullRequests, selectedKey, onSelect: select });
  return h(
    "main",
    { className: `bb-workbench ${desktop ? "bb-desktop" : "bb-mobile"}`, "data-testid": "bitbucket-workbench" },
    h("header", { className: "bb-toolbar" }, h("div", { className: "bb-toolbar-title" }, icon(h, "bitbucket"), h("div", null, h("h1", null, "Bitbucket"), h("p", null, "Pull request queue and native reviews"))), h("div", { className: "bb-toolbar-actions" }, h(QueueFilters, { host, mobile: responsive.isMobile, search, setSearch, state, setState }), h(ui.Button, { type: "button", variant: "ghost", className: "min-h-11", onClick: queue.refresh, "aria-label": "Refresh pull request queue" }, icon(h, "refresh"), "Refresh"))),
    noWorkspace
      ? EmptyState(host, "Choose a workspace", "Open Bitbucket from a workspace to connect and browse pull requests.")
      : desktop
        ? h("div", { className: "bb-desktop-panes" }, h("aside", { className: "bb-pane bb-queue-pane" }, h(ConnectionHealth, { host, workspaceId: activeWorkspaceId }), h(RepositoryBrowser, { host, workspaceId: activeWorkspaceId, onChoose: setSearch }), queueContent, h(LaunchPresets, { host, workspaceId: activeWorkspaceId, pullRequest: selected }), h(Watches, { host, workspaceId: activeWorkspaceId, filter: watchFilter })), h("section", { className: "bb-pane bb-detail-pane" }, selected ? h(ReviewDetailPanel, { host, workspaceId: activeWorkspaceId, reviewKey: selected.key }) : EmptyState(host, "Select a pull request", "The detail pane shows files, commits, participants, threads, and available actions.")))
        : h("div", { className: "bb-mobile-focus" }, selected ? h(ReviewDetailPanel, { host, workspaceId: activeWorkspaceId, reviewKey: selected.key, onBack: () => setSelectedKey(null) }) : h("div", { className: "bb-mobile-list" }, h(ConnectionHealth, { host, workspaceId: activeWorkspaceId }), h(RepositoryBrowser, { host, workspaceId: activeWorkspaceId, onChoose: setSearch }), queueContent, h(LaunchPresets, { host, workspaceId: activeWorkspaceId, pullRequest: null }), h(Watches, { host, workspaceId: activeWorkspaceId, filter: watchFilter }))),
  );
}

function makeLinkPullRequestModal(host: PluginHost, context: TaskContext): Component {
  return function LinkPullRequestModal() {
    const { jsx: h, ui, React } = host;
    const [reference, setReference] = React.useState("");
    const [result, setResult] = React.useState<string | null>(null);
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
    return h("form", { className: "bb-task-modal", onSubmit: (event: { preventDefault(): void }) => { event.preventDefault(); void run(); } }, h(ui.Label, { htmlFor: "bitbucket-review-reference" }, "Pull request key or Bitbucket URL"), h(ui.Input, { id: "bitbucket-review-reference", className: "min-h-11", value: reference, onChange: (event: { target: { value: string } }) => setReference(event.target.value), placeholder: "workspace/repository#42" }), h("p", { className: "bb-capability-note" }, "Paste a key or Cloud/Data Center pull request URL."), result ? h("p", { role: "status" }, result) : null, h(ui.Button, { type: "submit", className: "min-h-11", disabled: !reference.trim() }, "Link pull request"));
  };
}

function taskContextValue(context: TaskContext, key: string): string {
  const source = record(context);
  const task = record(source.task);
  return text(task[key]) || text(source[key]);
}

function makeUnlinkPullRequestModal(host: PluginHost, context: TaskContext): Component {
  return function UnlinkPullRequestModal() {
    const { jsx: h, ui, React } = host;
    const linked = usePluginQuery<unknown>(host, action.pullRequestsGet, { workspaceId: context.workspaceId, taskId: context.taskId }, true);
    const pullRequests = normalizePullRequests(linked.data);
    const [reviewKey, setReviewKey] = React.useState("");
    const [result, setResult] = React.useState<string | null>(null);
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
    if (linked.loading) return h("p", { className: "bb-capability-note", role: "status" }, "Loading linked pull requests…");
    if (linked.error) return h("p", { className: "bb-error", role: "alert" }, linked.error);
    if (!pullRequests.length) return h("p", { className: "bb-capability-note", role: "status" }, "No Bitbucket pull requests linked to this task.");
    return h(
      "form",
      { className: "bb-task-modal", onSubmit: (event: { preventDefault(): void }) => { event.preventDefault(); void run(); } },
      h(ui.Label, { htmlFor: "bitbucket-linked-review" }, "Linked pull request"),
      h(
        ui.Select,
        { value: reviewKey, onValueChange: setReviewKey },
        h(ui.SelectTrigger, { id: "bitbucket-linked-review", className: "min-h-11" }, h(ui.SelectValue, { placeholder: "Choose linked pull request" })),
        h(ui.SelectContent, null, ...pullRequests.map((pullRequest) => h(ui.SelectItem, { key: pullRequest.key, value: pullRequest.key }, `${pullRequest.repositoryName} · #${pullRequest.number} · ${pullRequest.title}`))),
      ),
      result ? h("p", { role: "status" }, result) : null,
      h(ui.Button, { type: "submit", className: "min-h-11", disabled: !reviewKey }, "Unlink pull request"),
    );
  };
}

function makeCreatePullRequestModal(host: PluginHost, context: TaskContext): Component {
  return function CreatePullRequestModal() {
    const { jsx: h, ui, React } = host;
    const [title, setTitle] = React.useState(taskContextValue(context, "title"));
    const [description, setDescription] = React.useState(taskContextValue(context, "description"));
    const [destination, setDestination] = React.useState("");
    const [closeSourceOnMerge, setCloseSourceOnMerge] = React.useState(false);
    const [result, setResult] = React.useState<string | null>(null);
    const run = async () => {
      try {
        await host.api.invokeAction(action.pullRequestsCreate, {
          workspaceId: context.workspaceId,
          taskId: context.taskId,
          body: pullRequestCreateBody({ title, description, destination, closeSourceOnMerge }),
        });
        setResult("Pull request created.");
      } catch (error) {
        setResult(errorMessage(error));
      }
    };
    return h(
      "form",
      { className: "bb-task-modal", onSubmit: (event: { preventDefault(): void }) => { event.preventDefault(); void run(); } },
      h("p", { className: "bb-capability-note" }, "Kandev derives repository and source branch from this task's verified checkout."),
      h("p", { className: "bb-capability-note" }, "Leave fields blank to use task title, description, and destination defaults."),
      h(ui.Label, { htmlFor: "bitbucket-pr-title" }, "Pull request title"),
      h(ui.Input, { id: "bitbucket-pr-title", className: "min-h-11", value: title, onChange: (event: { target: { value: string } }) => setTitle(event.target.value) }),
      h(ui.Label, { htmlFor: "bitbucket-pr-description" }, "Description"),
      h(ui.Textarea, { id: "bitbucket-pr-description", className: "min-h-11", value: description, onChange: (event: { target: { value: string } }) => setDescription(event.target.value) }),
      h(ui.Label, { htmlFor: "bitbucket-pr-destination" }, "Destination branch"),
      h(ui.Input, { id: "bitbucket-pr-destination", className: "min-h-11", value: destination, onChange: (event: { target: { value: string } }) => setDestination(event.target.value), placeholder: "Task base branch (default)" }),
      h("label", { className: "bb-check" }, h("input", { type: "checkbox", checked: closeSourceOnMerge, onChange: (event: { target: { checked: boolean } }) => setCloseSourceOnMerge(event.target.checked) }), "Close source branch after merge"),
      result ? h("p", { role: "status", className: "bb-message" }, result) : null,
      h(ui.Button, { type: "submit", className: "min-h-11" }, "Create pull request"),
    );
  };
}

function taskActionPresentation(context: TaskContext): "dialog" | "drawer" {
  return context.presentation === "mobile" ? "drawer" : "dialog";
}

function registerNativeIntegrations(registry: PluginRegistry, host: PluginHost) {
  registry.registerRepositoryProvider({
    id: "bitbucket",
    label: "Bitbucket",
    icon: "puzzle",
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
  });
  registry.registerTaskAction({
    id: "link-pull-request",
    label: "Link Bitbucket Pull Request",
    icon: "link",
    placement: "link",
    async run(context) {
      host.openModal({ title: "Link Bitbucket pull request", size: "md", presentation: taskActionPresentation(context), content: makeLinkPullRequestModal(host, context) });
    },
  });
  registry.registerTaskAction({
    id: "open-pull-request-review",
    label: "Open Bitbucket Review",
    icon: "bitbucket",
    placement: "action",
    async run() {
      host.navigate("/bitbucket");
    },
  });
  registry.registerTaskAction({
    id: "unlink-pull-request",
    label: "Unlink Bitbucket Pull Request",
    icon: "link",
    placement: "action",
    async run(context) {
      host.openModal({ title: "Unlink Bitbucket pull request", size: "sm", presentation: taskActionPresentation(context), content: makeUnlinkPullRequestModal(host, context) });
    },
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
    },
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
      const response = await host.api.invokeAction<unknown>(action.pullRequestsGet, { taskId, body: { view: "task" } }, { signal });
      if (!signal.aborted) reviewStore.set(taskId, normalizePullRequests(response));
    },
    ReviewPanel: (props = {}) =>
      h(ReviewDetailPanel, {
        host,
        workspaceId: text(props.workspaceId) || undefined,
        taskId: text(props.taskId) || undefined,
        reviewKey: text(props.reviewKey),
      }),
  });
}

function makeSettingsHealth(host: PluginHost): Component {
  return function SettingsHealth(props = {}) {
    const scopedWorkspaceId = useActiveWorkspaceId(host);
    return host.jsx(ConnectionHealth, { host, workspaceId: scopedWorkspaceId, status: record(props.slotProps).status });
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
    registry.registerNavItem({ id: "bitbucket", label: "Bitbucket", path: "/bitbucket", icon: "puzzle", section: "integrations" });
    registry.registerRoute("/bitbucket", () => host.jsx(BitbucketPage, { host }), { topbar: false });
    registry.registerComponent("plugin-settings", makeSettingsHealth(host));
    registerNativeIntegrations(registry, host);
  },
  destroy() {
    reviewStore.clear();
    currentHost = null;
  },
});

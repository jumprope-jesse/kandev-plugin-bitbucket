import {
  activeWorkspaceIdFromState,
  errorMessage,
  normalizeSavedQueries,
  newSavedQuery,
  type PullRequest,
  type SavedQuery,
} from "./view-models";
import {
  type ActionInput,
  type ElementFactory,
  type PluginHost,
  type QueryState,
} from "./host-contract";

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

export function useActiveWorkspaceId(host: PluginHost): string | undefined {
  const { React } = host;
  const [activeWorkspaceId, setActiveWorkspaceId] = React.useState(() =>
    activeWorkspaceIdFromState(host.store.getState()),
  );
  React.useEffect(() => {
    const sync = () =>
      setActiveWorkspaceId(activeWorkspaceIdFromState(host.store.getState()));
    sync();
    return host.store.subscribe(sync);
  }, [host]);
  return activeWorkspaceId;
}

const SAVED_QUERIES_KEY = "dashboard-saved-queries";

export function useSavedQueries(host: PluginHost, workspaceId?: string) {
  const { React } = host;
  const [queries, setQueries] = React.useState<SavedQuery[]>([]);
  const load = async () => {
    if (!workspaceId) {
      setQueries([]);
      return;
    }
    const entry = await host.storage.get(
      "workspace",
      workspaceId,
      SAVED_QUERIES_KEY,
    );
    setQueries(normalizeSavedQueries(entry?.value));
  };
  React.useEffect(() => {
    if (!workspaceId) {
      setQueries([]);
      return;
    }
    let active = true;
    const sync = async () => {
      const entry = await host.storage.get(
        "workspace",
        workspaceId,
        SAVED_QUERIES_KEY,
      );
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
      await host.storage.set(
        "workspace",
        workspaceId,
        SAVED_QUERIES_KEY,
        normalized,
      );
    } catch (error) {
      await load();
      throw error;
    }
  };
  return {
    queries,
    async save(
      input: Pick<SavedQuery, "label" | "query" | "repositoryId" | "state">,
    ) {
      const created = newSavedQuery(
        input,
        `saved-${host.utils.generateUUID()}`,
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

export function requestBody(input?: ActionInput): ActionInput | undefined {
  if (!input) return undefined;
  return JSON.parse(JSON.stringify(input)) as ActionInput;
}

export function usePluginQuery<T>(
  host: PluginHost,
  key: string,
  input: ActionInput | undefined,
  enabled = true,
): QueryState<T> {
  const { React } = host;
  const serializedInput = JSON.stringify(input ?? {});
  const [reload, setReload] = React.useState(0);
  const [state, setState] = React.useState<{
    data: T | null;
    loading: boolean;
    error: string | null;
    lastFetchedAt: Date | null;
  }>({
    data: null,
    loading: enabled,
    error: null,
    lastFetchedAt: null,
  });
  React.useEffect(() => {
    let active = true;
    const controller = new AbortController();
    if (!enabled) {
      setState({
        data: null,
        loading: false,
        error: null,
        lastFetchedAt: null,
      });
      return () => {
        active = false;
        controller.abort();
      };
    }
    setState((previous) => ({ ...previous, loading: true, error: null }));
    void host.api
      .invokeAction<T>(
        key,
        requestBody(JSON.parse(serializedInput) as ActionInput),
        {
          signal: controller.signal,
        },
      )
      .then((data) => {
        if (active)
          setState({
            data,
            loading: false,
            error: null,
            lastFetchedAt: new Date(),
          });
      })
      .catch((error) => {
        if (active)
          setState((previous) => ({
            ...previous,
            loading: false,
            error: errorMessage(error),
          }));
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [enabled, host.api, key, reload, serializedInput]);
  const refresh = React.useCallback(() => setReload((value) => value + 1), []);
  return { ...state, refresh };
}

export async function collectPluginActionPages(
  api: PluginHost["api"],
  key: string,
  input: ActionInput | undefined,
  itemKey: string,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const items: unknown[] = [];
  const seenCursors = new Set<string>();
  let cursor = "";
  let lastPage: Record<string, unknown> = {};
  for (let page = 0; page < 1000; page += 1) {
    const body = { ...record(input?.body), cursor };
    const response = await api.invokeAction<unknown>(
      key,
      requestBody({ ...input, body }),
      { signal },
    );
    if (signal.aborted) throw new DOMException("Request aborted", "AbortError");
    lastPage = record(response);
    const pageItems = lastPage[itemKey];
    if (Array.isArray(pageItems)) items.push(...pageItems);
    const nextCursor = text(lastPage.next_cursor);
    if (!nextCursor) return { ...lastPage, [itemKey]: items, next_cursor: "" };
    if (seenCursors.has(nextCursor))
      throw new Error(`${key} pagination did not advance`);
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  throw new Error(`${key} pagination limit exceeded`);
}

export function usePagedPluginQuery(
  host: PluginHost,
  key: string,
  input: ActionInput | undefined,
  itemKey: string,
  enabled = true,
): QueryState<Record<string, unknown>> {
  const { React } = host;
  const serializedInput = JSON.stringify(input ?? {});
  const [reload, setReload] = React.useState(0);
  const [state, setState] = React.useState<{
    data: Record<string, unknown> | null;
    loading: boolean;
    error: string | null;
    lastFetchedAt: Date | null;
  }>({ data: null, loading: enabled, error: null, lastFetchedAt: null });
  React.useEffect(() => {
    let active = true;
    const controller = new AbortController();
    if (!enabled) {
      setState({
        data: null,
        loading: false,
        error: null,
        lastFetchedAt: null,
      });
      return () => {
        active = false;
        controller.abort();
      };
    }
    setState((previous) => ({ ...previous, loading: true, error: null }));
    void collectPluginActionPages(
      host.api,
      key,
      JSON.parse(serializedInput) as ActionInput,
      itemKey,
      controller.signal,
    )
      .then((data) => {
        if (active)
          setState({
            data,
            loading: false,
            error: null,
            lastFetchedAt: new Date(),
          });
      })
      .catch((error) => {
        if (active)
          setState((previous) => ({
            ...previous,
            loading: false,
            error: errorMessage(error),
          }));
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [enabled, host.api, itemKey, key, reload, serializedInput]);
  const refresh = React.useCallback(() => setReload((value) => value + 1), []);
  return { ...state, refresh };
}

export function useAbortableAction(host: PluginHost) {
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
      const result = await host.api.invokeAction(key, input, {
        signal: controller.signal,
      });
      if (controller.signal.aborted)
        throw new DOMException("Request aborted", "AbortError");
      return result;
    } finally {
      if (activeController.current === controller)
        activeController.current = null;
    }
  };
  return {
    invoke,
    cancel() {
      activeController.current?.abort();
    },
  };
}

export function isAbortError(reason: unknown): boolean {
  return record(reason).name === "AbortError";
}

export function icon(h: ElementFactory, name: string) {
  const paths: Record<string, string> = {
    watch:
      "M3 12s3.2-5 9-5 9 5 9 5-3.2 5-9 5-9-5-9-5Zm9 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
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

export function pullRequestStateIcon(
  host: PluginHost,
  pullRequest: PullRequest,
) {
  const normalized = pullRequest.state.toLowerCase();
  const merged = normalized === "merged";
  const closed = normalized === "declined" || normalized === "closed";
  return host.jsx(host.ui.IntegrationIcon, {
    name: merged ? "merged" : closed ? "pull-request-closed" : "pull-request",
    className: `h-4 w-4 ${merged ? "text-purple-600 dark:text-purple-400" : closed ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"}`,
  });
}

export function Badge(host: PluginHost, label: string, tone = "neutral") {
  return host.jsx(
    host.ui.Badge,
    { className: `bb-badge bb-badge-${tone}` },
    label,
  );
}

export function EmptyState(
  host: PluginHost,
  title: string,
  detail: string,
  actionLabel?: string,
  onAction?: () => void,
) {
  const { jsx: h, ui } = host;
  return h(
    "section",
    { className: "bb-empty", role: "status" },
    h("h2", null, title),
    h("p", null, detail),
    actionLabel && onAction
      ? h(
          ui.Button,
          { type: "button", className: "min-h-11", onClick: onAction },
          actionLabel,
        )
      : null,
  );
}

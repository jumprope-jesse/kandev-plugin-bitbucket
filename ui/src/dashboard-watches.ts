import {
  errorMessage,
  normalizeWatches,
  type WatchSummary,
} from "./view-models";
import { type PluginHost } from "./host-contract";
import {
  Badge,
  icon,
  isAbortError,
  record,
  useAbortableOperation,
  usePluginQuery,
} from "./ui-runtime";
import { action } from "./actions";
import { usePluginTranslation } from "./i18n";

export type PendingWatchChange = {
  watchId: string;
  kind: "reset" | "delete";
  taskCount: number;
};

export function watchPreviewTaskCount(value: unknown): number {
  const response = record(value);
  const taskIDs = response.task_ids ?? response.TaskIDs;
  return Array.isArray(taskIDs) ? taskIDs.length : 0;
}

export function WatchRow({
  host,
  watch,
  disabled,
  run,
  preview,
}: {
  host: PluginHost;
  watch: WatchSummary;
  disabled: boolean;
  run(key: string, watchId: string): void;
  preview(kind: "reset" | "delete", watchId: string): void;
}) {
  const { jsx: h, ui } = host;
  const { t } = usePluginTranslation(host);
  const toggleKey =
    watch.status === "running" ? action.watchesPause : action.watchesResume;
  return h(
    "li",
    { className: "bb-watch-row", key: watch.id },
    h(
      "div",
      null,
      h("strong", null, watch.id),
      Badge(
        host,
        t(watch.status === "running" ? "running" : "paused"),
        watch.status === "running" ? "success" : "neutral",
      ),
      watch.lastPolled
        ? h(
            "span",
            null,
            t("lastPolled", {
              values: {
                value: host.utils.formatRelativeTime(watch.lastPolled),
              },
            }),
          )
        : null,
    ),
    h(
      "div",
      { className: "bb-secondary-actions" },
      h(
        ui.Button,
        {
          type: "button",
          variant: "outline",
          className: "min-h-11",
          disabled,
          onClick: () => run(action.watchesRun, watch.id),
        },
        t("runNow"),
      ),
      h(
        ui.Button,
        {
          type: "button",
          variant: "outline",
          className: "min-h-11",
          disabled,
          onClick: () => run(toggleKey, watch.id),
        },
        watch.status === "running" ? t("pause") : t("resume"),
      ),
      h(
        ui.Button,
        {
          type: "button",
          variant: "ghost",
          className: "min-h-11",
          disabled,
          onClick: () => preview("reset", watch.id),
        },
        t("reset"),
      ),
      h(
        ui.Button,
        {
          type: "button",
          variant: "destructive",
          className: "min-h-11",
          disabled,
          onClick: () => preview("delete", watch.id),
        },
        t("delete"),
      ),
    ),
  );
}

export function WatchConfirmation({
  host,
  pending,
  disabled,
  confirm,
  cancel,
}: {
  host: PluginHost;
  pending: PendingWatchChange;
  disabled: boolean;
  confirm(): void;
  cancel(): void;
}) {
  const { jsx: h, ui } = host;
  const { t } = usePluginTranslation(host);
  const warningKey =
    pending.kind === "delete" ? "watchDeleteWarning" : "watchResetWarning";
  return h(
    "div",
    { className: "bb-watch-confirm", role: "alert" },
    h("p", null, t(warningKey, { count: pending.taskCount })),
    h(
      "div",
      { className: "bb-secondary-actions" },
      h(
        ui.Button,
        {
          type: "button",
          variant: "destructive",
          className: "min-h-11",
          disabled,
          onClick: confirm,
        },
        t(pending.kind === "delete" ? "confirmDelete" : "confirmReset"),
      ),
      h(
        ui.Button,
        {
          type: "button",
          variant: "outline",
          className: "min-h-11",
          disabled,
          onClick: cancel,
        },
        t("cancel"),
      ),
    ),
  );
}

export function Watches({
  host,
  workspaceId: scopedWorkspaceId,
  filter,
  showCreate = true,
}: {
  host: PluginHost;
  workspaceId?: string;
  filter: Record<string, unknown>;
  showCreate?: boolean;
}) {
  const { jsx: h, ui, React } = host;
  const { t } = usePluginTranslation(host);
  const watches = usePluginQuery<Record<string, unknown>>(
    host,
    action.watchesGet,
    scopedWorkspaceId ? { workspaceId: scopedWorkspaceId } : undefined,
    Boolean(scopedWorkspaceId),
  );
  const [working, setWorking] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<PendingWatchChange | null>(null);
  const mutation = useAbortableOperation(host);
  React.useEffect(() => {
    mutation.cancel();
    setWorking(null);
    setError(null);
    setPending(null);
  }, [scopedWorkspaceId]);
  const invoke = async (key: string, body: Record<string, unknown>) => {
    if (!scopedWorkspaceId) return null;
    setWorking(key);
    setError(null);
    const request = mutation.begin();
    try {
      const response = await host.api.invokeAction<unknown>(
        key,
        { workspaceId: scopedWorkspaceId, body },
        { signal: request.signal },
      );
      if (!request.isCurrent()) return null;
      watches.refresh();
      return response;
    } catch (reason) {
      if (request.isCurrent() && !isAbortError(reason))
        setError(errorMessage(reason, t));
      return null;
    } finally {
      if (request.finish()) setWorking(null);
    }
  };
  const run = (key: string, watchId: string) => {
    void invoke(key, { watch_id: watchId });
  };
  const preview = async (kind: "reset" | "delete", watchId: string) => {
    const key =
      kind === "reset"
        ? action.watchesPreviewReset
        : action.watchesPreviewDelete;
    const response = await invoke(key, { watch_id: watchId });
    if (response)
      setPending({ watchId, kind, taskCount: watchPreviewTaskCount(response) });
  };
  const confirm = async () => {
    if (!pending) return;
    const key =
      pending.kind === "reset" ? action.watchesReset : action.watchesDelete;
    const response = await invoke(key, { watch_id: pending.watchId });
    if (response) setPending(null);
  };
  const watchItems = normalizeWatches(watches.data);
  return h(
    ui.Card,
    { className: "bb-watches" },
    h(
      ui.CardHeader,
      null,
      h(ui.CardTitle, null, t("watches")),
      h(ui.CardDescription, null, t("watchesDescription")),
    ),
    h(
      ui.CardContent,
      { className: "bb-card-actions" },
      watches.error
        ? h("p", { className: "bb-error", role: "alert" }, watches.error)
        : null,
      error ? h("p", { className: "bb-error", role: "alert" }, error) : null,
      watchItems.length
        ? h(
            "ul",
            { className: "bb-watch-list" },
            ...watchItems.map((watch) =>
              h(WatchRow, {
                host,
                watch,
                disabled: Boolean(working),
                run,
                preview: (kind: "reset" | "delete", watchId: string) =>
                  void preview(kind, watchId),
              }),
            ),
          )
        : h("p", null, t("noSavedWatches")),
      pending
        ? h(WatchConfirmation, {
            host,
            pending,
            disabled: Boolean(working),
            confirm: () => void confirm(),
            cancel: () => setPending(null),
          })
        : null,
      showCreate
        ? h(
            ui.Button,
            {
              type: "button",
              variant: "outline",
              className: "min-h-11",
              disabled: Boolean(working),
              onClick: () =>
                void invoke(action.watchesUpdate, { enabled: true, filter }),
            },
            icon(h, "watch"),
            t("addFilterWatch"),
          )
        : null,
    ),
  );
}

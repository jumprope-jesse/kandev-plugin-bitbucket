import {
  canSaveDashboardQuery,
  connectionState,
  normalizePullRequestAssociations,
  normalizePullRequests,
  normalizeRepositories,
  parsePullRequestListQuery,
  pullRequestListRequest,
  pullRequestLookupBody,
  pullRequestScopeQuery,
  taskDialogInitialValues,
  taskFromLaunchResult,
  taskLaunchBody,
  usePluginTaskCreation,
  type PullRequest,
  type TaskLaunchPreset,
} from "./view-models";
import { type PluginHost } from "./host-contract";
import {
  record,
  text,
  useActiveWorkspaceId,
  useSavedQueries,
  usePluginQuery,
  usePagedPluginQuery,
  useTaskCreationContext,
  useAbortableOperation,
  isAbortError,
  EmptyState,
} from "./ui-runtime";
import {
  DashboardPullRequestList,
  repositoryFilter,
  StateScopeBar,
  MobileFilters,
  ConnectionNotice,
  type DashboardScopeSelection,
  type DashboardScopeProps,
} from "./dashboard-components";
import { action } from "./actions";
import { usePluginTranslation } from "./i18n";

export function BitbucketPage({ host }: { host: PluginHost }) {
  const { jsx: h, ui, React } = host;
  const { t } = usePluginTranslation(host);
  const responsive = host.useResponsiveBreakpoint();
  const activeWorkspaceId = useActiveWorkspaceId(host);
  const initialQuery = pullRequestScopeQuery("open");
  const [searchDraft, setSearchDraft] = React.useState(initialQuery);
  const [search, setSearch] = React.useState(initialQuery);
  const [state, setState] = React.useState("open");
  const [repository, setRepository] = React.useState("");
  const [scopeSelection, setScopeSelection] =
    React.useState<DashboardScopeSelection>({
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
  const taskLaunchMutation = useAbortableOperation(host);
  const taskLinkMutation = useAbortableOperation(host);
  React.useEffect(() => {
    taskLaunchMutation.cancel();
    taskLinkMutation.cancel();
    setLaunch(null);
  }, [activeWorkspaceId]);
  const connection = usePluginQuery<Record<string, unknown>>(
    host,
    action.connectionGet,
    activeWorkspaceId ? { workspaceId: activeWorkspaceId } : undefined,
    Boolean(activeWorkspaceId),
  );
  const connected = connectionState(record(connection.data)) === "connected";
  const repositoriesQuery = usePagedPluginQuery(
    host,
    action.repositoriesList,
    activeWorkspaceId
      ? { workspaceId: activeWorkspaceId, body: { limit: 100 } }
      : undefined,
    "repositories",
    Boolean(activeWorkspaceId && connected),
  );
  const repositories = normalizeRepositories(repositoriesQuery.data);
  const selectedRepository =
    repositories.find((candidate) => candidate.repositoryId === repository) ??
    null;
  const queueScopeKey = JSON.stringify([
    activeWorkspaceId ?? "",
    selectedRepository?.repositoryId ?? "",
    search,
    state,
  ]);
  const [queuePagination, setQueuePagination] = React.useState<{
    scopeKey: string;
    page: number;
    cursors: string[];
  }>(() => ({ scopeKey: queueScopeKey, page: 1, cursors: [""] }));
  const activeQueuePagination =
    queuePagination.scopeKey === queueScopeKey
      ? queuePagination
      : { scopeKey: queueScopeKey, page: 1, cursors: [""] };
  const queueCursor =
    activeQueuePagination.cursors[activeQueuePagination.page - 1] ?? "";
  const queueRequest = pullRequestListRequest(
    selectedRepository,
    search,
    state,
    queueCursor,
    25,
  );
  const queue = usePluginQuery<Record<string, unknown>>(
    host,
    queueRequest.actionKey,
    activeWorkspaceId
      ? { workspaceId: activeWorkspaceId, body: queueRequest.body }
      : undefined,
    Boolean(activeWorkspaceId && connected),
  );
  const pullRequests = normalizePullRequests(queue.data, t);
  const nextQueueCursor = text(record(queue.data).next_cursor);
  const associations = usePluginQuery<unknown>(
    host,
    action.pullRequestsAssociations,
    activeWorkspaceId
      ? {
          workspaceId: activeWorkspaceId,
          body: {
            review_keys: pullRequests.map((pullRequest) => pullRequest.key),
          },
        }
      : undefined,
    Boolean(activeWorkspaceId && connected && pullRequests.length),
  );
  const tasksByReview = normalizePullRequestAssociations(associations.data, t);
  const createContext = useTaskCreationContext(host, activeWorkspaceId);
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
    setScopeSelection({
      kind: "pull_requests",
      source: "preset",
      id: nextState,
    });
  };
  const selectDashboardScope = (selection: DashboardScopeSelection) => {
    if (selection.source === "preset") {
      selectScopeState(selection.id);
      return;
    }
    const saved = savedQueries.queries.find(
      (query) => query.id === selection.id,
    );
    if (!saved) return;
    setScopeSelection(selection);
    setSearchDraft(saved.query);
    setSearch(saved.query);
    setState(saved.state);
    setRepository(saved.repositoryId);
  };
  const deleteSavedQuery = (id: string) => {
    savedQueries.remove(id);
    if (scopeSelection.source === "saved" && scopeSelection.id === id)
      selectScopeState("open");
  };
  const saveCurrentQuery = async (
    label: string,
    defaultRepositoryId: string,
  ) => {
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
    setScopeSelection({
      kind: "pull_requests",
      source: "saved",
      id: created.id,
    });
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
    const request = taskLinkMutation.begin();
    try {
      if (!linkedByLaunch) {
        await host.api.invokeAction(
          action.pullRequestsLink,
          {
            workspaceId: activeWorkspaceId,
            taskId,
            body: pullRequestLookupBody(launch.pullRequest, t),
          },
          { signal: request.signal },
        );
      }
      if (request.isCurrent()) associations.refresh();
    } catch (reason) {
      if (isAbortError(reason) || !request.isCurrent()) return;
      // Task creation succeeded; the task menu can retry linking if Bitbucket rejects it.
    } finally {
      if (request.finish()) {
        setLaunch(null);
        host.navigate(`/tasks/${encodeURIComponent(taskId)}`);
      }
    }
  };
  const selectedHostRepositoryId =
    launch && activeWorkspaceId && launch.pullRequest.providerScope
      ? host.context.resolveRepositoryId({
          workspaceId: activeWorkspaceId,
          providerId: "bitbucket",
          providerScope: launch.pullRequest.providerScope,
          providerRepositoryId: launch.pullRequest.repositoryId,
        })
      : undefined;
  const launchRemoteRepository = launch
    ? repositories.find(
        (candidate) =>
          candidate.repositoryId === launch.pullRequest.repositoryId,
      )
    : undefined;
  const createBitbucketTask = async (payload: Record<string, unknown>) => {
    if (!activeWorkspaceId || !launch)
      throw new Error(t("taskLaunchUnavailable"));
    const request = taskLaunchMutation.begin();
    try {
      const result = await host.api.invokeAction<Record<string, unknown>>(
        action.tasksLaunch,
        {
          workspaceId: activeWorkspaceId,
          body: taskLaunchBody(
            launch.pullRequest,
            payload,
            launch.launchId,
            t,
          ),
        },
        { signal: request.signal },
      );
      if (!request.isCurrent())
        throw new DOMException("Task launch aborted", "AbortError");
      const task = taskFromLaunchResult(result, t);
      const taskId = text(task.id);
      if (task.bitbucketLinked === true)
        pluginCreatedTaskIDs.current.add(taskId);
      associations.refresh();
      return task;
    } finally {
      request.finish();
    }
  };
  const taskDialog =
    launch && createContext
      ? h(ui.TaskCreateDialog, {
          open: true,
          onOpenChange: (open: boolean) => {
            if (!open) {
              taskLaunchMutation.cancel();
              taskLinkMutation.cancel();
              setLaunch(null);
            }
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
            launchRemoteRepository,
          ),
          createTask: usePluginTaskCreation(selectedHostRepositoryId)
            ? createBitbucketTask
            : undefined,
          onSuccess: (task: unknown) => void finishTaskCreation(task),
        })
      : null;
  const filter = responsive.isMobile
    ? h(MobileFilters, {
        host,
        repositories,
        repository,
        setRepository,
        ...scopeProps,
      })
    : repositoryFilter(host, repositories, repository, setRepository);
  const workbenchBody = !connected
    ? null
    : [
        responsive.isMobile ? null : h(StateScopeBar, { host, ...scopeProps }),
        h(ui.IntegrationListToolbar, {
          title: t("pullRequests"),
          count: pullRequests.length,
          loading: queue.loading,
          lastFetchedAt: queue.lastFetchedAt,
          customQuery: searchDraft,
          committedQuery: search,
          onCustomQueryChange: setSearchDraft,
          onCommitCustomQuery: commitSearch,
          onRefresh: queue.refresh,
          filter,
          queryPlaceholder: t("customQueryPlaceholder"),
          titleTestId: "bitbucket-list-toolbar",
          queryTestId: "bitbucket-list-query",
          refreshTestId: "bitbucket-list-refresh",
        }),
        h(
          "section",
          {
            className: "bb-results",
            "data-testid": "bitbucket-results",
            "aria-label": t("pullRequestResults"),
          },
          h(DashboardPullRequestList, {
            host,
            pullRequests,
            loading: queue.loading,
            error: queue.error,
            tasksByReview,
            onStartTask: (pullRequest: PullRequest, preset: TaskLaunchPreset) =>
              setLaunch({
                pullRequest,
                preset,
                launchId: host.utils.generateUUID(),
              }),
          }),
        ),
        h(ui.IntegrationCursorPagination, {
          page: activeQueuePagination.page,
          itemCount: pullRequests.length,
          hasPrevious: activeQueuePagination.page > 1,
          hasNext: Boolean(nextQueueCursor),
          loading: queue.loading,
          onPrevious: () => {
            if (activeQueuePagination.page <= 1) return;
            setQueuePagination({
              ...activeQueuePagination,
              page: activeQueuePagination.page - 1,
            });
          },
          onNext: () => {
            if (!nextQueueCursor) return;
            const cursors = activeQueuePagination.cursors.slice(
              0,
              activeQueuePagination.page,
            );
            cursors.push(nextQueueCursor);
            setQueuePagination({
              scopeKey: queueScopeKey,
              page: activeQueuePagination.page + 1,
              cursors,
            });
          },
          testId: "bitbucket-results-pagination",
        }),
        taskDialog,
        h(ui.IntegrationSaveQueryDialog, {
          open: saveDialogOpen,
          onOpenChange: setSaveDialogOpen,
          description: t("saveQueryDescription"),
          suggestedLabel:
            searchDraft.trim() ||
            (repository ? t("repositoryPullRequests") : t("savedQuery")),
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
    {
      className: `bb-workbench ${responsive.isMobile ? "bb-mobile" : "bb-desktop"}`,
      "data-testid": "bitbucket-workbench",
    },
    noWorkspace
      ? EmptyState(host, t("chooseWorkspace"), t("chooseWorkspaceDescription"))
      : [
          h(ConnectionNotice, {
            host,
            connection,
            workspaceId: activeWorkspaceId,
          }),
          workbenchBody,
        ],
  );
}

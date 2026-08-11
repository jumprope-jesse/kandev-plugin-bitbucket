import {
  canSaveDashboardQuery,
  connectionState,
  matchingHostRepositoryId,
  normalizePullRequestAssociations,
  normalizePullRequests,
  normalizeRepositories,
  parsePullRequestListQuery,
  pullRequestListRequest,
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
  EmptyState,
} from "./ui-runtime";
import {
  taskCreateContext,
  DashboardPullRequestList,
  repositoryFilter,
  StateScopeBar,
  MobileFilters,
  useHostStoreState,
  ConnectionNotice,
  type DashboardScopeSelection,
  type DashboardScopeProps,
} from "./dashboard-components";
import { action } from "./actions";

export function BitbucketPage({ host }: { host: PluginHost }) {
  const { jsx: h, ui, React } = host;
  const responsive = host.useResponsiveBreakpoint();
  const activeWorkspaceId = useActiveWorkspaceId(host);
  const hostState = useHostStoreState(host);
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
  const connection = usePluginQuery<Record<string, unknown>>(
    host,
    action.connectionGet,
    activeWorkspaceId ? { workspaceId: activeWorkspaceId } : undefined,
    Boolean(activeWorkspaceId),
  );
  const connected = connectionState(record(connection.data)) === "connected";
  const repositoriesQuery = usePluginQuery<unknown>(
    host,
    action.repositoriesList,
    activeWorkspaceId ? { workspaceId: activeWorkspaceId } : undefined,
    Boolean(activeWorkspaceId && connected),
  );
  const repositories = normalizeRepositories(repositoriesQuery.data);
  const selectedRepository =
    repositories.find((candidate) => candidate.repositoryId === repository) ??
    null;
  const queueRequest = pullRequestListRequest(
    selectedRepository,
    search,
    state,
  );
  const queue = usePluginQuery<Record<string, unknown>>(
    host,
    queueRequest.actionKey,
    activeWorkspaceId
      ? { workspaceId: activeWorkspaceId, body: queueRequest.body }
      : undefined,
    Boolean(activeWorkspaceId && connected),
  );
  const pullRequests = normalizePullRequests(queue.data);
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
    try {
      if (!linkedByLaunch) {
        await host.api.invokeAction(action.pullRequestsLink, {
          workspaceId: activeWorkspaceId,
          taskId,
          body: {
            review_key: launch.pullRequest.key,
            pull_request_id: launch.pullRequest.id,
          },
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
  const selectedHostRepositoryId =
    launch && createContext
      ? matchingHostRepositoryId(createContext.repositories, launch.pullRequest)
      : undefined;
  const launchRemoteRepository = launch
    ? repositories.find(
        (candidate) =>
          candidate.repositoryId === launch.pullRequest.repositoryId,
      )
    : undefined;
  const createBitbucketTask = async (payload: Record<string, unknown>) => {
    if (!activeWorkspaceId || !launch)
      throw new Error("Bitbucket task launch is unavailable.");
    const result = await host.api.invokeAction<Record<string, unknown>>(
      action.tasksLaunch,
      {
        workspaceId: activeWorkspaceId,
        body: taskLaunchBody(launch.pullRequest, payload, launch.launchId),
      },
    );
    const task = taskFromLaunchResult(result);
    const taskId = text(task.id);
    if (task.bitbucketLinked === true) pluginCreatedTaskIDs.current.add(taskId);
    associations.refresh();
    return task;
  };
  const taskDialog =
    launch && createContext
      ? h(ui.TaskCreateDialog, {
          open: true,
          onOpenChange: (open: boolean) => {
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
          queryPlaceholder:
            'Custom query — press Enter. e.g. "state:open fix login"',
          titleTestId: "bitbucket-list-toolbar",
          queryTestId: "bitbucket-list-query",
          refreshTestId: "bitbucket-list-refresh",
        }),
        h(
          "section",
          {
            className: "bb-results",
            "data-testid": "bitbucket-results",
            "aria-label": "Pull request results",
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
        taskDialog,
        h(ui.IntegrationSaveQueryDialog, {
          open: saveDialogOpen,
          onOpenChange: setSaveDialogOpen,
          description:
            "Save this Bitbucket pull-request search for the current workspace.",
          suggestedLabel:
            searchDraft.trim() ||
            (repository ? "Repository pull requests" : "Saved query"),
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
      ? EmptyState(
          host,
          "Choose a workspace",
          "Open Bitbucket from a workspace to connect and browse pull requests.",
        )
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

import {
  connectionState,
  integrationSettingsHref,
  type RepositoryInspection,
  type SavedQuery,
} from "./view-models";
import { type PluginHost, type QueryState } from "./host-contract";
import { record } from "./ui-runtime";

export function repositoryFilter(
  host: PluginHost,
  repositories: RepositoryInspection[],
  repository: string,
  setRepository: (value: string) => void,
) {
  const { jsx: h, ui } = host;
  return h(ui.IntegrationRepositoryFilter, {
    value: repository,
    onValueChange: setRepository,
    options: repositories.map((candidate) => {
      const label = `${candidate.ownerOrProject}/${candidate.repositoryName}`;
      return { value: candidate.repositoryId, label, keywords: [label] };
    }),
    ariaLabel: "Filter Bitbucket pull requests by repository",
    allLabel: "All repositories",
    searchPlaceholder: "Filter repositories...",
    emptyMessage: "No repositories found.",
    triggerClassName:
      "min-h-11 w-full border border-input bg-background px-2 py-1.5 text-xs/relaxed hover:bg-secondary/50 md:h-8 md:min-h-0 md:w-[220px]",
    className: "md:min-w-[360px]",
    testId: "bitbucket-repository-filter",
    dropdownTestId: "bitbucket-repository-filter-dropdown",
  });
}

export type DashboardScopeSelection = {
  kind: "pull_requests";
  source: "preset" | "saved";
  id: string;
};

export type DashboardScopeProps = {
  host: PluginHost;
  selection: DashboardScopeSelection;
  savedQueries: SavedQuery[];
  onSelect(selection: DashboardScopeSelection): void;
  onDeleteSaved(id: string): void;
  canSaveCurrent: boolean;
  onSaveCurrent(): void;
};

export function StateScopeBar({
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
    {
      value: "declined",
      label: "Declined",
      iconName: "pull-request-closed",
      group: "created",
    },
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

export function MobileFilters({
  host,
  repositories,
  repository,
  setRepository,
  ...scope
}: {
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
  return h(
    ui.Sheet,
    { open, onOpenChange: setOpen },
    h(
      ui.SheetTrigger,
      { asChild: true },
      h(
        ui.Button,
        {
          type: "button",
          variant: "outline",
          className: "min-h-11",
          "aria-label": "Open Bitbucket filters",
        },
        h(ui.IntegrationIcon, { name: "filter", className: "h-4 w-4" }),
        "Filters",
      ),
    ),
    h(
      ui.SheetContent,
      { side: "left", className: "bb-filter-sheet" },
      h(
        ui.SheetHeader,
        null,
        h(ui.SheetTitle, null, "Bitbucket filters"),
        h(
          ui.SheetDescription,
          null,
          "Narrow pull requests by repository and state.",
        ),
      ),
      h(
        "div",
        { className: "bb-mobile-filter-fields" },
        h(StateScopeBar, { host, ...mobileScope }),
        h(ui.Label, { htmlFor: "bitbucket-repository-filter" }, "Repository"),
        repositoryFilter(host, repositories, repository, setRepository),
      ),
    ),
  );
}

export function useHostStoreState(host: PluginHost): Record<string, unknown> {
  const { React } = host;
  const [state, setState] = React.useState(() => host.store.getState());
  React.useEffect(
    () => host.store.subscribe(() => setState(host.store.getState())),
    [host],
  );
  return state;
}

export function ConnectionNotice({
  host,
  connection,
  workspaceId,
}: {
  host: PluginHost;
  connection: QueryState<Record<string, unknown>>;
  workspaceId?: string;
}) {
  const { jsx: h, ui } = host;
  if (connection.loading)
    return h(
      "div",
      { className: "bb-connection-loading" },
      h(ui.Spinner, { "aria-label": "Checking Bitbucket connection" }),
    );
  const state = connectionState(record(connection.data));
  if (state === "connected") return null;
  const checking = state === "checking";
  const message =
    connection.error ??
    (checking
      ? "Kandev is verifying the saved connection."
      : "Connect Bitbucket for this workspace to load pull requests.");
  return h(
    ui.Alert,
    { className: "bb-connection-notice" },
    h(
      ui.AlertTitle,
      null,
      checking ? "Checking Bitbucket connection" : "Bitbucket needs attention",
    ),
    h(
      ui.AlertDescription,
      { className: "bb-notice-content" },
      h("span", null, message),
      checking
        ? null
        : h(
            ui.Button,
            {
              type: "button",
              variant: "outline",
              className: "min-h-11",
              onClick: () =>
                host.navigate(integrationSettingsHref(workspaceId)),
            },
            "Configure Bitbucket",
          ),
    ),
  );
}

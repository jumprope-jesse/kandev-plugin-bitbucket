import {
  displayPullRequestAuthor,
  pullRequestAssociationIdentity,
  relativeTimeLabel,
  taskLaunchPresets,
  type PullRequest,
  type TaskLaunchPreset,
} from "./view-models";
import { type PluginHost } from "./host-contract";
import { record, text, pullRequestStateIcon, Badge } from "./ui-runtime";
import { action } from "./actions";

export type TaskCreateContext = {
  workflowId: string;
  defaultStepId: string;
  steps: Array<{ id: string; title: string; events?: Record<string, unknown> }>;
  repositories: Array<Record<string, unknown>>;
};

export function taskCreateContext(
  state: Record<string, unknown>,
  workspaceId?: string,
): TaskCreateContext | null {
  if (!workspaceId) return null;
  const workflowState = record(state.workflows);
  const workflows = Array.isArray(workflowState.items)
    ? workflowState.items.map(record)
    : [];
  const activeWorkflowId = text(workflowState.activeId);
  const workflow =
    workflows.find(
      (candidate) =>
        text(candidate.id) === activeWorkflowId &&
        text(candidate.workspaceId) === workspaceId,
    ) ??
    workflows.find(
      (candidate) =>
        text(candidate.workspaceId) === workspaceId ||
        text(candidate.workspace_id) === workspaceId,
    );
  const workflowId = text(workflow?.id);
  if (!workflowId) return null;
  const kanban = record(state.kanban);
  const snapshots = record(record(state.kanbanMulti).snapshots);
  const snapshot = record(snapshots[workflowId]);
  const rawSteps =
    text(kanban.workflowId) === workflowId && Array.isArray(kanban.steps)
      ? kanban.steps
      : Array.isArray(snapshot.steps)
        ? snapshot.steps
        : [];
  const steps = rawSteps
    .map(record)
    .sort(
      (left, right) => Number(left.position ?? 0) - Number(right.position ?? 0),
    )
    .map((step) => ({
      id: text(step.id),
      title: text(step.title) || text(step.name),
      ...(record(step.events) ? { events: record(step.events) } : {}),
    }))
    .filter((step) => step.id && step.title);
  if (!steps[0]) return null;
  const repositoryState = record(state.repositories);
  const byWorkspace = record(repositoryState.itemsByWorkspaceId);
  const repositories = Array.isArray(byWorkspace[workspaceId])
    ? (byWorkspace[workspaceId] as unknown[]).map(record)
    : [];
  return { workflowId, defaultStepId: steps[0].id, steps, repositories };
}

export function DashboardPullRequestList({
  host,
  pullRequests,
  loading,
  error,
  tasksByReview,
  onStartTask,
}: {
  host: PluginHost;
  pullRequests: PullRequest[];
  loading: boolean;
  error: string | null;
  tasksByReview: Record<string, PullRequest["tasks"]>;
  onStartTask(pullRequest: PullRequest, preset: TaskLaunchPreset): void;
}) {
  const { jsx: h, ui } = host;
  const presets = taskLaunchPresets();
  return h(
    "div",
    { "data-testid": "bitbucket-pr-queue" },
    h(
      ui.ChangeRequestList,
      {
        loading,
        error,
        emptyMessage: "No pull requests match this filter.",
        isEmpty: pullRequests.length === 0,
      },
      ...pullRequests.map((pullRequest) => {
        const author = displayPullRequestAuthor(pullRequest.author);
        const opened = relativeTimeLabel(pullRequest.createdAt);
        const metadata = h(
          "span",
          { className: "bb-change-request-metadata" },
          h("span", null, pullRequest.key),
          author ? h("span", null, ` · by ${author}`) : null,
          opened ? h("span", null, ` · opened ${opened}`) : null,
          pullRequest.sourceBranch && pullRequest.destinationBranch
            ? h(
                "span",
                null,
                ` · ${pullRequest.sourceBranch} → ${pullRequest.destinationBranch}`,
              )
            : null,
          h("span", null, " · "),
          Badge(
            host,
            pullRequest.statusLabel ?? pullRequest.state,
            pullRequest.statusTone,
          ),
        );
        const identity = pullRequestAssociationIdentity(
          pullRequest.repositoryId,
          pullRequest.number,
        );
        const tasks =
          tasksByReview[pullRequest.key] ??
          (identity ? tasksByReview[identity] : undefined) ??
          pullRequest.tasks;
        return h(ui.ChangeRequestRow, {
          key: pullRequest.key,
          stateIcon: pullRequestStateIcon(host, pullRequest),
          title: pullRequest.title,
          href: pullRequest.url,
          metadata,
          taskIndicator: h(ui.TaskRowIndicator, {
            tasks,
            testIdPrefix: `bitbucket-pr-${pullRequest.number}-task`,
          }),
          action: pullRequest.capabilities.includes("launch_task")
            ? h(ui.IntegrationStartTaskMenu, {
                presets,
                onSelect: (selected: { id: string }) => {
                  const preset = presets.find(
                    (candidate) => candidate.id === selected.id,
                  );
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

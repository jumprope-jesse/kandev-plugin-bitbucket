import {
  displayPullRequestAuthor,
  pullRequestAssociationIdentity,
  taskLaunchPresets,
  type PullRequest,
  type TaskLaunchPreset,
} from "./view-models";
import { type PluginHost } from "./host-contract";
import { record, text, pullRequestStateIcon, Badge } from "./ui-runtime";
import { action } from "./actions";

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
        const opened = pullRequest.createdAt
          ? host.utils.formatRelativeTime(pullRequest.createdAt)
          : undefined;
        const metadata = h(
          "span",
          { className: "bb-change-request-metadata" },
          h("span", null, pullRequest.key),
          author ? h("span", null, ` · by ${author}`) : null,
          opened ? h("span", null, ` · opened ${opened}`) : null,
          pullRequest.sourceBranch && pullRequest.destinationBranch
            ? h("span", null, ` · ${pullRequest.sourceBranch} → ${pullRequest.destinationBranch}`)
            : null,
          h("span", null, " · "),
          Badge(host, pullRequest.statusLabel ?? pullRequest.state, pullRequest.statusTone),
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

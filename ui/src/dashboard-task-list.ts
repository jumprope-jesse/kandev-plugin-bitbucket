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
import { usePluginTranslation } from "./i18n";

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
  const { t } = usePluginTranslation(host);
  const presets = taskLaunchPresets(t);
  return h(
    "div",
    { "data-testid": "bitbucket-pr-queue" },
    h(
      ui.ChangeRequestList,
      {
        loading,
        error,
        emptyMessage: t("noMatchingPullRequests"),
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
          author
            ? h("span", null, ` · ${t("byAuthor", { values: { author } })}`)
            : null,
          opened
            ? h(
                "span",
                null,
                ` · ${t("openedAgo", { values: { value: opened } })}`,
              )
            : null,
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
        const tasks = tasksForPullRequest(tasksByReview, pullRequest);
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

export function tasksForPullRequest(
  tasksByReview: Record<string, PullRequest["tasks"]>,
  pullRequest: PullRequest,
): PullRequest["tasks"] {
  const identity = pullRequestAssociationIdentity(
    pullRequest.providerScope ?? connectionScopeFromURL(pullRequest.url),
    pullRequest.repositoryId,
    pullRequest.number,
  );
  if (identity) {
    return tasksByReview[identity] ?? pullRequest.tasks;
  }
  return tasksByReview[pullRequest.key] ?? pullRequest.tasks;
}

function connectionScopeFromURL(rawURL: string): string | undefined {
  try {
    return new URL(rawURL).origin;
  } catch {
    return undefined;
  }
}

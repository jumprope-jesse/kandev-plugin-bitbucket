import { action } from "./actions";
import type { PluginHost, ReviewSummary, ReviewTaskAssociation } from "./host-contract";
import {
  loadTaskPullRequestDetails,
  reviewSummaryForPullRequest,
  type PullRequestWithStatus,
} from "./task-review-status";
import { normalizePullRequestAssociations } from "./view-models";

export const reviewStore = (() => {
  const snapshots = new Map<string, ReviewSummary[]>();
  const listeners = new Map<string, Set<() => void>>();
  const refreshes = new Map<string, number>();
  let epoch = 0;
  return {
    get(taskId: string): readonly ReviewSummary[] {
      return snapshots.get(taskId) ?? [];
    },
    set(taskId: string, pullRequests: PullRequestWithStatus[]) {
      snapshots.set(
        taskId,
        pullRequests.map((pullRequest) => reviewSummaryForPullRequest(pullRequest)),
      );
      listeners.get(taskId)?.forEach((listener) => listener());
    },
    beginRefresh(taskId: string) {
      const version = (refreshes.get(taskId) ?? 0) + 1;
      refreshes.set(taskId, version);
      return { epoch, version };
    },
    isCurrentRefresh(taskId: string, token: { epoch: number; version: number }) {
      return token.epoch === epoch && refreshes.get(taskId) === token.version;
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
      epoch += 1;
      refreshes.clear();
      snapshots.clear();
      listeners.forEach((taskListeners) => taskListeners.forEach((listener) => listener()));
      listeners.clear();
    },
  };
})();

export const associationStore = (() => {
  const snapshots = new Map<string, ReviewTaskAssociation[]>();
  const listeners = new Map<string, Set<() => void>>();
  const refreshes = new Map<string, number>();
  let epoch = 0;
  return {
    get(workspaceId: string): readonly ReviewTaskAssociation[] {
      return snapshots.get(workspaceId) ?? [];
    },
    set(workspaceId: string, value: unknown) {
      const associations = normalizePullRequestAssociations(value);
      snapshots.set(
        workspaceId,
        Object.entries(associations).flatMap(([reviewKey, tasks]) =>
          reviewKey.startsWith("repository:")
            ? []
            : tasks.map((task) => ({
                providerId: "bitbucket",
                taskId: task.taskId,
                reviewKey,
                ...(task.repositoryId && task.changeRequestNumber
                  ? {
                      repositoryId: task.repositoryId,
                      changeRequestNumber: task.changeRequestNumber,
                    }
                  : {}),
              })),
        ),
      );
      listeners.get(workspaceId)?.forEach((listener) => listener());
    },
    beginRefresh(workspaceId: string) {
      const version = (refreshes.get(workspaceId) ?? 0) + 1;
      refreshes.set(workspaceId, version);
      return { epoch, version };
    },
    isCurrentRefresh(workspaceId: string, token: { epoch: number; version: number }) {
      return token.epoch === epoch && refreshes.get(workspaceId) === token.version;
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
      epoch += 1;
      refreshes.clear();
      snapshots.clear();
      listeners.forEach((workspaceListeners) =>
        workspaceListeners.forEach((listener) => listener()),
      );
      listeners.clear();
    },
  };
})();

export async function refreshAssociationStore(
  host: PluginHost,
  workspaceId: string,
  signal: AbortSignal,
): Promise<void> {
  const refresh = associationStore.beginRefresh(workspaceId);
  const response = await host.api.invokeAction<unknown>(
    action.pullRequestsAssociations,
    { workspaceId },
    { signal },
  );
  if (!signal.aborted && associationStore.isCurrentRefresh(workspaceId, refresh))
    associationStore.set(workspaceId, response);
}

export async function refreshReviewStore(
  host: PluginHost,
  taskId: string,
  signal: AbortSignal,
  workspaceId?: string,
): Promise<void> {
  const refresh = reviewStore.beginRefresh(taskId);
  const pullRequests = await loadTaskPullRequestDetails(
    (key, input, options) => host.api.invokeAction(key, input, options),
    { taskId, ...(workspaceId ? { workspaceId } : {}) },
    signal,
  );
  if (!signal.aborted && reviewStore.isCurrentRefresh(taskId, refresh))
    reviewStore.set(taskId, pullRequests);
}

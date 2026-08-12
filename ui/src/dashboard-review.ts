import {
  changeRequestDetailActions,
  changeRequestDetailModel,
  errorMessage,
  normalizeReviewDetail,
  workspaceReviewAction,
} from "./view-models";
import { type PluginHost } from "./host-contract";
import { isAbortError, useAbortableOperation, usePluginQuery } from "./ui-runtime";
import { action } from "./actions";

export type HostDetailActionRequest = {
  actionId: string;
  body?: string;
  threadId?: string;
};

export function ReviewDetailPanel({
  host,
  workspaceId: scopedWorkspaceId,
  taskId,
  reviewKey,
  presentation,
}: {
  host: PluginHost;
  workspaceId?: string;
  taskId?: string;
  reviewKey: string;
  presentation?: "desktop" | "mobile";
}) {
  const { jsx: h, ui, React } = host;
  const review = usePluginQuery<Record<string, unknown>>(
    host,
    taskId ? action.pullRequestsGet : action.pullRequestsInspect,
    taskId
      ? {
          taskId,
          body: {
            review_key: reviewKey,
            include: ["files", "participants", "threads", "status", "viewer"],
          },
        }
      : scopedWorkspaceId
        ? {
            workspaceId: scopedWorkspaceId,
            body: {
              review_key: reviewKey,
              include: ["files", "participants", "threads", "status", "viewer"],
            },
          }
        : undefined,
    Boolean((taskId || scopedWorkspaceId) && reviewKey),
  );
  const detail = normalizeReviewDetail(review.data);
  const [busyActionId, setBusyActionId] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const mutation = useAbortableOperation(host);
  const runAction = async (requestValue: HostDetailActionRequest) => {
    if (!detail || !scopedWorkspaceId || busyActionId) return;
    const kind = requestValue.actionId === "comment" ? "add_comment" : requestValue.actionId;
    setBusyActionId(requestValue.actionId);
    setActionError(null);
    const request = mutation.begin();
    try {
      await host.api.invokeAction(
        action.reviewsAction,
        workspaceReviewAction(scopedWorkspaceId, detail.key, detail.id, kind, {
          ...(requestValue.body ? { comment: requestValue.body } : {}),
          ...(requestValue.threadId ? { parentCommentId: requestValue.threadId } : {}),
        }),
        { signal: request.signal },
      );
      if (request.isCurrent()) review.refresh();
    } catch (reason) {
      if (request.isCurrent() && !isAbortError(reason)) setActionError(errorMessage(reason));
    } finally {
      if (request.finish()) setBusyActionId(null);
    }
  };
  return h(ui.ChangeRequestDetail, {
    detail: detail ? changeRequestDetailModel(detail) : null,
    presentation: presentation ?? "desktop",
    loading: review.loading,
    error: review.error,
    onRefresh: review.refresh,
    onRetry: review.refresh,
    actions: detail ? changeRequestDetailActions(detail) : [],
    busyActionId,
    onAction: runAction,
    notice: actionError ? h("p", { className: "bb-error", role: "alert" }, actionError) : null,
  });
}

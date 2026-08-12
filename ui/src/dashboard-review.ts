import {
  changeRequestDetailActions,
  changeRequestDetailModel,
  errorMessage,
  normalizeReviewDetail,
  workspaceReviewAction,
} from "./view-models";
import { type PluginHost } from "./host-contract";
import {
  isAbortError,
  useAbortableOperation,
  usePluginQuery,
} from "./ui-runtime";
import { action } from "./actions";
import { usePluginTranslation } from "./i18n";

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
  connectionScope,
  repositoryId,
  changeRequestNumber,
  presentation,
}: {
  host: PluginHost;
  workspaceId: string;
  taskId: string;
  reviewKey: string;
  connectionScope: string;
  repositoryId: string;
  changeRequestNumber: number;
  presentation?: "desktop" | "mobile";
}) {
  const { jsx: h, ui, React } = host;
  const { t } = usePluginTranslation(host);
  const review = usePluginQuery<Record<string, unknown>>(
    host,
    action.pullRequestsGet,
    {
      workspaceId: scopedWorkspaceId,
      taskId,
      body: {
        review_key: reviewKey,
        provider_scope: connectionScope,
        repository_id: repositoryId,
        number: changeRequestNumber,
        include: ["files", "participants", "threads", "status", "viewer"],
      },
    },
    Boolean(
      scopedWorkspaceId && taskId && repositoryId && changeRequestNumber > 0,
    ),
  );
  const detail = normalizeReviewDetail(review.data, t);
  const [busyActionId, setBusyActionId] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const mutation = useAbortableOperation(host);
  const runAction = async (requestValue: HostDetailActionRequest) => {
    if (!detail || busyActionId) return;
    const kind =
      requestValue.actionId === "comment"
        ? "add_comment"
        : requestValue.actionId;
    setBusyActionId(requestValue.actionId);
    setActionError(null);
    const request = mutation.begin();
    try {
      await host.api.invokeAction(
        action.reviewsAction,
        workspaceReviewAction(
          scopedWorkspaceId,
          taskId,
          {
            reviewKey: detail.key,
            connectionScope: detail.providerScope ?? connectionScope,
            repositoryId: detail.repositoryId,
            changeRequestNumber: detail.number,
          },
          detail.id,
          kind,
          {
            ...(requestValue.body ? { comment: requestValue.body } : {}),
            ...(requestValue.threadId
              ? { parentCommentId: requestValue.threadId }
              : {}),
          },
        ),
        { signal: request.signal },
      );
      if (request.isCurrent()) review.refresh();
    } catch (reason) {
      if (request.isCurrent() && !isAbortError(reason))
        setActionError(errorMessage(reason, t));
    } finally {
      if (request.finish()) setBusyActionId(null);
    }
  };
  return h(ui.ChangeRequestDetail, {
    detail: detail ? changeRequestDetailModel(detail, t) : null,
    presentation: presentation ?? "desktop",
    loading: review.loading,
    error: review.error,
    onRefresh: review.refresh,
    onRetry: review.refresh,
    actions: detail ? changeRequestDetailActions(detail, t) : [],
    busyActionId,
    onAction: runAction,
    notice: actionError
      ? h("p", { className: "bb-error", role: "alert" }, actionError)
      : null,
  });
}

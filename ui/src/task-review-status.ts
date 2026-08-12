import {
  normalizePullRequests,
  normalizeReviewDetail,
  type BuildStatus,
  type PullRequest,
  type ReviewDetail,
} from "./view-models";
import { translateEnglish, type Translate } from "./i18n";

type ActionInput = {
  workspaceId?: string;
  taskId?: string;
  body?: unknown;
};

type InvokeAction = <T>(
  key: string,
  input?: ActionInput,
  options?: { signal?: AbortSignal },
) => Promise<T>;

const STATUS_HYDRATION_CONCURRENCY = 4;

export type PullRequestWithStatus = PullRequest & {
  statuses?: BuildStatus[];
  participants?: ReviewDetail["participants"];
  threads?: ReviewDetail["threads"];
  unresolvedThreadCount?: number;
};

export type ChangeRequestStatusView = {
  number: number | string;
  state: "open" | "merged" | "closed" | "draft";
  pipelineState: "success" | "failure" | "pending" | "neutral";
  checks: Array<{
    id: string;
    label: string;
    state: "success" | "failure" | "pending" | "neutral";
    detail?: string;
    url?: string;
  }>;
  review?: {
    state: "approved" | "changes_requested" | "pending";
    approved: number;
    required?: number;
    requested?: number;
  };
  unresolvedComments?: number;
  updatedAt?: number;
};

export type ReviewSummaryForHost = {
  providerId: "bitbucket";
  reviewKey: string;
  title: string;
  url: string;
  repositoryId: string;
  connectionScope: string;
  changeRequestNumber: string | number;
  state: string;
  statusBadge?: { label: string; tone?: string };
  taskStatus: ChangeRequestStatusView;
};

export async function loadTaskPullRequestDetails(
  invokeAction: InvokeAction,
  context: { taskId: string; workspaceId?: string },
  signal: AbortSignal,
  t: Translate = translateEnglish,
): Promise<PullRequestWithStatus[]> {
  const scope = {
    ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
    taskId: context.taskId,
  };
  const linkedResponse = await invokeAction<unknown>(
    "pullrequests.get",
    { ...scope, body: { view: "task" } },
    { signal },
  );
  const linked = normalizePullRequests(linkedResponse, t);
  return mapWithConcurrency(
    linked,
    STATUS_HYDRATION_CONCURRENCY,
    signal,
    async (pullRequest) => {
      const detailResponse = await invokeAction<unknown>(
        "pullrequests.get",
        {
          ...scope,
          body: {
            review_key: pullRequest.key,
            provider_scope:
              pullRequest.providerScope ??
              pullRequestConnectionScope(pullRequest.url),
            repository_id: pullRequest.repositoryId,
            number: pullRequest.number,
            pull_request_id: pullRequest.id,
            include: ["participants", "status"],
          },
        },
        { signal },
      );
      return normalizeReviewDetail(detailResponse, t) ?? pullRequest;
    },
  );
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  signal: AbortSignal,
  map: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  let failed = false;
  let failure: unknown;
  const worker = async () => {
    while (!failed) {
      if (signal.aborted) {
        failed = true;
        failure = signal.reason ?? new DOMException("Operation aborted", "AbortError");
        return;
      }
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      try {
        results[index] = await map(values[index]!);
      } catch (reason) {
        failed = true;
        failure = reason;
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), values.length) },
      () => worker(),
    ),
  );
  if (failed) throw failure;
  return results;
}

function normalizePipelineState(
  value: string,
): "success" | "failure" | "pending" | "neutral" {
  const state = value.trim().toUpperCase();
  if (["SUCCESS", "SUCCESSFUL", "PASSED", "COMPLETED"].includes(state))
    return "success";
  if (["FAILED", "FAILURE", "ERROR", "STOPPED"].includes(state))
    return "failure";
  if (["PENDING", "INPROGRESS", "IN_PROGRESS", "RUNNING"].includes(state))
    return "pending";
  return "neutral";
}

function pullRequestState(
  value: string,
): "open" | "merged" | "closed" | "draft" {
  const state = value.trim().toUpperCase();
  if (state === "MERGED") return "merged";
  if (state === "DRAFT") return "draft";
  if (["DECLINED", "CLOSED", "SUPERSEDED"].includes(state)) return "closed";
  return "open";
}

export function changeRequestStatusView(
  pullRequest: PullRequestWithStatus,
  refreshedAt = Date.now(),
): ChangeRequestStatusView {
  const checks = (pullRequest.statuses ?? []).map((status) => ({
    id: status.key,
    label: status.name,
    state: normalizePipelineState(status.state),
    ...(status.target ? { detail: status.target } : {}),
    ...(status.url ? { url: status.url } : {}),
  }));
  const states = checks.map((row) => row.state);
  const reviewers =
    "participants" in pullRequest && Array.isArray(pullRequest.participants)
      ? pullRequest.participants.filter((participant) =>
          ["REVIEWER", "APPROVER"].includes(
            participant.role?.toUpperCase() ?? "REVIEWER",
          ),
        )
      : [];
  const approved = reviewers.filter(
    (participant) => participant.verdict === "approved" || participant.approved,
  ).length;
  const changesRequested = reviewers.filter(
    (participant) => participant.verdict === "changes_requested",
  ).length;
  const requested = reviewers.filter(
    (participant) =>
      participant.verdict !== "changes_requested" &&
      participant.verdict !== "approved" &&
      !participant.approved,
  ).length;
  const unresolvedComments =
    pullRequest.unresolvedThreadCount ??
    ("threads" in pullRequest && Array.isArray(pullRequest.threads)
      ? pullRequest.threads.filter((thread) => !thread.resolved).length
      : 0);
  const providerUpdatedAt = pullRequest.updatedAt
    ? Date.parse(pullRequest.updatedAt)
    : Number.NaN;
  const updatedAt = Number.isFinite(providerUpdatedAt)
    ? providerUpdatedAt
    : refreshedAt;
  const pipelineState = states.includes("failure")
    ? "failure"
    : states.includes("pending")
      ? "pending"
      : states.length > 0 && states.every((state) => state === "success")
        ? "success"
        : "neutral";
  return {
    number: pullRequest.number,
    state: pullRequestState(pullRequest.state),
    pipelineState,
    checks,
    ...(reviewers.length > 0
      ? {
          review: {
            state:
              changesRequested > 0
                ? ("changes_requested" as const)
                : approved > 0
                  ? ("approved" as const)
                  : ("pending" as const),
            approved,
            ...(requested > 0 ? { requested } : {}),
          },
        }
      : {}),
    ...(unresolvedComments > 0 ? { unresolvedComments } : {}),
    updatedAt,
  };
}

export function reviewSummaryForPullRequest(
  pullRequest: PullRequestWithStatus,
  refreshedAt = Date.now(),
): ReviewSummaryForHost {
  return {
    providerId: "bitbucket",
    reviewKey: pullRequest.key,
    title: pullRequest.title,
    url: pullRequest.url,
    repositoryId: pullRequest.repositoryId,
    connectionScope:
      pullRequest.providerScope ?? pullRequestConnectionScope(pullRequest.url),
    changeRequestNumber: pullRequest.number,
    state: pullRequest.state,
    ...(pullRequest.statusLabel
      ? {
          statusBadge: {
            label: pullRequest.statusLabel,
            ...(pullRequest.statusTone ? { tone: pullRequest.statusTone } : {}),
          },
        }
      : {}),
    taskStatus: changeRequestStatusView(pullRequest, refreshedAt),
  };
}

function pullRequestConnectionScope(rawURL: string): string {
  try {
    return new URL(rawURL).origin;
  } catch {
    return "bitbucket";
  }
}

import { describe, expect, it, vi } from "vitest";
import {
  changeRequestStatusView,
  loadTaskPullRequestDetails,
  reviewSummaryForPullRequest,
} from "../src/task-review-status";

describe("Bitbucket task review status", () => {
  it("hydrates every linked pull request with a lightweight status projection", async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce({
        pull_requests: [{
          id: "42",
          review_key: "acme/widgets#42",
          number: 42,
          title: "Fix CI",
          url: "https://bitbucket.org/acme/widgets/pull-requests/42",
          repository_id: "acme/widgets",
          repository_name: "widgets",
          state: "OPEN",
        }],
      })
      .mockResolvedValueOnce({
        id: "42",
        review_key: "acme/widgets#42",
        number: 42,
        title: "Fix CI",
        url: "https://bitbucket.org/acme/widgets/pull-requests/42",
        repository_id: "acme/widgets",
        repository_name: "widgets",
        state: "OPEN",
        statuses: [{ key: "pipeline", name: "Pipelines", state: "FAILED" }],
      });

    const details = await loadTaskPullRequestDetails(
      invoke,
      { taskId: "task-1", workspaceId: "workspace-1" },
      new AbortController().signal,
    );

    expect(invoke).toHaveBeenNthCalledWith(1, "pullrequests.get", {
      workspaceId: "workspace-1",
      taskId: "task-1",
      body: { view: "task" },
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(invoke).toHaveBeenNthCalledWith(2, "pullrequests.get", {
      workspaceId: "workspace-1",
      taskId: "task-1",
      body: {
        review_key: "acme/widgets#42",
        pull_request_id: "42",
        include: ["participants", "status"],
      },
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(details[0]?.statuses).toEqual([
      expect.objectContaining({ key: "pipeline", state: "FAILED" }),
    ]);
    expect(details[0]?.unresolvedThreadCount).toBeUndefined();
  });

  it("maps provider state and builds to the host-native status contract", () => {
    expect(changeRequestStatusView({
      key: "acme/widgets#42",
      id: "42",
      number: 42,
      title: "Fix CI",
      url: "https://bitbucket.org/acme/widgets/pull-requests/42",
      repositoryId: "acme/widgets",
      repositoryName: "widgets",
      state: "OPEN",
      updatedAt: "2026-08-06T10:00:00Z",
      tasks: [],
      capabilities: [],
      statuses: [
        {
          key: "pipeline",
          name: "Pipelines",
          state: "FAILED",
          target: "main",
          url: "https://bitbucket.org/acme/widgets/addon/pipelines/home#!/results/42",
        },
        { key: "security", name: "Security", state: "SUCCESSFUL" },
      ],
      participants: [
        { name: "Ada", role: "REVIEWER", approved: true },
        { name: "Grace", role: "REVIEWER", approved: false, verdict: "changes_requested" },
        { name: "Linus", role: "REVIEWER", approved: false, verdict: "pending" },
      ],
      threads: [
        { id: "10", author: "Grace", body: "Please fix CI", resolved: false, comments: [] },
        { id: "11", author: "Ada", body: "Done", resolved: true, comments: [] },
      ],
    })).toEqual({
      number: 42,
      state: "open",
      pipelineState: "failure",
      checks: [
        {
          id: "pipeline",
          label: "Pipelines",
          state: "failure",
          detail: "main",
          url: "https://bitbucket.org/acme/widgets/addon/pipelines/home#!/results/42",
        },
        { id: "security", label: "Security", state: "success" },
      ],
      review: { state: "changes_requested", approved: 1, requested: 1 },
      unresolvedComments: 1,
      updatedAt: Date.parse("2026-08-06T10:00:00Z"),
    });
  });

  it("embeds normalized pipeline status in the review-provider summary", () => {
    expect(reviewSummaryForPullRequest({
      key: "acme/widgets#42",
      id: "42",
      number: 42,
      title: "Fix CI",
      url: "https://bitbucket.org/acme/widgets/pull-requests/42",
      repositoryId: "acme/widgets",
      repositoryName: "widgets",
      state: "OPEN",
      updatedAt: "2026-08-06T10:00:00Z",
      tasks: [],
      capabilities: [],
      statuses: [{ key: "pipeline", name: "Pipelines", state: "INPROGRESS" }],
    })).toEqual({
      providerId: "bitbucket",
      reviewKey: "acme/widgets#42",
      title: "Fix CI",
      url: "https://bitbucket.org/acme/widgets/pull-requests/42",
      repositoryId: "acme/widgets",
      state: "OPEN",
      taskStatus: {
        number: 42,
        state: "open",
        pipelineState: "pending",
        checks: [{ id: "pipeline", label: "Pipelines", state: "pending" }],
        updatedAt: Date.parse("2026-08-06T10:00:00Z"),
      },
    });
  });

});

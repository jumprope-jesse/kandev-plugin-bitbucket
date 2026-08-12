import { describe, expect, it, vi } from "vitest";
import {
  changeRequestStatusView,
  loadTaskPullRequestDetails,
  reviewSummaryForPullRequest,
} from "../src/task-review-status";

describe("Bitbucket task review status", () => {
  it("hydrates every linked pull request with a lightweight status projection", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        pull_requests: [
          {
            id: "42",
            review_key: "acme/widgets#42",
            number: 42,
            title: "Fix CI",
            url: "https://bitbucket.org/acme/widgets/pull-requests/42",
            repository_id: "acme/widgets",
            repository_name: "widgets",
            state: "OPEN",
          },
        ],
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

    expect(invoke).toHaveBeenNthCalledWith(
      1,
      "pullrequests.get",
      {
        workspaceId: "workspace-1",
        taskId: "task-1",
        body: { view: "task" },
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      "pullrequests.get",
      {
        workspaceId: "workspace-1",
        taskId: "task-1",
        body: {
          review_key: "acme/widgets#42",
          provider_scope: "https://bitbucket.org",
          repository_id: "acme/widgets",
          number: 42,
          pull_request_id: "42",
          include: ["participants", "status"],
        },
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(details[0]?.statuses).toEqual([
      expect.objectContaining({ key: "pipeline", state: "FAILED" }),
    ]);
    expect(details[0]?.unresolvedThreadCount).toBeUndefined();
  });

  it("bounds concurrent status hydration while preserving linked order", async () => {
    let active = 0;
    let maximum = 0;
    const releases: Array<() => void> = [];
    const linked = Array.from({ length: 9 }, (_, index) => ({
      id: String(index + 1),
      review_key: `acme/widgets#${index + 1}`,
      number: index + 1,
      title: `Pull request ${index + 1}`,
      url: `https://bitbucket.org/acme/widgets/pull-requests/${index + 1}`,
      provider_scope: "https://bitbucket.org",
      repository_id: "repository-uuid",
      repository_name: "widgets",
      state: "OPEN",
    }));
    const invokeMock = vi.fn(async (_key: string, input?: { body?: unknown }) => {
      const body = input?.body as { view?: string; number?: number } | undefined;
      if (body?.view === "task") return { pull_requests: linked };
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      const match = linked[(body?.number ?? 1) - 1];
      return match;
    });
    const invoke = invokeMock as unknown as Parameters<
      typeof loadTaskPullRequestDetails
    >[0];

    const pending = loadTaskPullRequestDetails(
      invoke,
      { taskId: "task-1", workspaceId: "workspace-1" },
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    expect(maximum).toBe(4);
    releases.splice(0).forEach((release) => release());
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    releases.splice(0).forEach((release) => release());
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.splice(0).forEach((release) => release());

    const details = await pending;
    expect(details.map((detail) => detail.number)).toEqual(
      linked.map((detail) => detail.number),
    );
    expect(maximum).toBe(4);
  });

  it("maps provider state and builds to the host-native status contract", () => {
    expect(
      changeRequestStatusView({
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
          {
            name: "Grace",
            role: "REVIEWER",
            approved: false,
            verdict: "changes_requested",
          },
          {
            name: "Linus",
            role: "REVIEWER",
            approved: false,
            verdict: "pending",
          },
        ],
        threads: [
          {
            id: "10",
            author: "Grace",
            body: "Please fix CI",
            resolved: false,
            comments: [],
          },
          {
            id: "11",
            author: "Ada",
            body: "Done",
            resolved: true,
            comments: [],
          },
        ],
      }),
    ).toEqual({
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
    expect(
      reviewSummaryForPullRequest({
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
      }),
    ).toEqual({
      providerId: "bitbucket",
      reviewKey: "acme/widgets#42",
      title: "Fix CI",
      url: "https://bitbucket.org/acme/widgets/pull-requests/42",
      repositoryId: "acme/widgets",
      connectionScope: "https://bitbucket.org",
      changeRequestNumber: 42,
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

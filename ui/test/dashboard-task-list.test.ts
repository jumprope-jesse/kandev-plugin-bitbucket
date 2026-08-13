import { describe, expect, it } from "vitest";
import { tasksForPullRequest } from "../src/dashboard-task-list";
import type { PullRequest } from "../src/view-models";

describe("tasksForPullRequest", () => {
  it("prefers immutable identity over a reused display key", () => {
    const pullRequest = {
      key: "team/repo#42",
      providerScope: "https://bitbucket.org",
      repositoryId: "new-repository-id",
      number: 42,
      tasks: [],
    } as unknown as PullRequest;
    const tasksByReview = {
      "team/repo#42": [
        { id: "old-task", taskId: "old-task", fallbackTitle: "Old repository" },
      ],
      "connection:https://bitbucket.org\u0000repository:new-repository-id\u0000pull-request:42":
        [
          {
            id: "new-task",
            taskId: "new-task",
            fallbackTitle: "Current repository",
          },
        ],
    };

    expect(tasksForPullRequest(tasksByReview, pullRequest)).toEqual([
      {
        id: "new-task",
        taskId: "new-task",
        fallbackTitle: "Current repository",
      },
    ]);
  });

  it("does not fall back to a reused display key when immutable identity is complete", () => {
    const pullRequest = {
      key: "team/repo#42",
      providerScope: "https://bitbucket.org",
      repositoryId: "new-repository-id",
      number: 42,
      tasks: [
        {
          id: "provider-task",
          taskId: "provider-task",
          fallbackTitle: "Provider result",
        },
      ],
    } as unknown as PullRequest;

    expect(
      tasksForPullRequest(
        {
          "team/repo#42": [
            {
              id: "old-task",
              taskId: "old-task",
              fallbackTitle: "Old repository",
            },
          ],
        },
        pullRequest,
      ),
    ).toEqual([
      {
        id: "provider-task",
        taskId: "provider-task",
        fallbackTitle: "Provider result",
      },
    ]);
  });
});

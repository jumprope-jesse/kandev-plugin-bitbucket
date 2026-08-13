import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginHost } from "../src/host-contract";
import {
  associationStore,
  refreshAssociationStore,
  reviewStore,
} from "../src/review-store";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function hostWithInvocations(values: Array<Promise<unknown>>): PluginHost {
  return {
    api: {
      baseUrl: "",
      invokeAction: vi.fn(() => values.shift() ?? Promise.resolve({})),
    },
  } as unknown as PluginHost;
}

afterEach(() => {
  associationStore.clear();
  reviewStore.clear();
});

describe("review provider stores", () => {
  it("rejects an older association response that finishes after a newer refresh", async () => {
    const older = deferred<unknown>();
    const newer = deferred<unknown>();
    const host = hostWithInvocations([older.promise, newer.promise]);
    const first = refreshAssociationStore(
      host,
      "workspace-1",
      new AbortController().signal,
    );
    const second = refreshAssociationStore(
      host,
      "workspace-1",
      new AbortController().signal,
    );

    newer.resolve({
      associations: [
        {
          review_key: "team/new#2",
          provider_scope: "https://bitbucket.org",
          repository_id: "repo-new",
          number: 2,
          task_id: "task-new",
          task_title: "New",
        },
      ],
    });
    await second;
    older.resolve({
      associations: [
        {
          review_key: "team/old#1",
          provider_scope: "https://bitbucket.org",
          repository_id: "repo-old",
          number: 1,
          task_id: "task-old",
          task_title: "Old",
        },
      ],
    });
    await first;

    expect(associationStore.get("workspace-1")).toEqual([
      expect.objectContaining({ reviewKey: "team/new#2", taskId: "task-new" }),
    ]);
  });

  it("does not resurrect association state after plugin teardown clears the store", async () => {
    const response = deferred<unknown>();
    const host = hostWithInvocations([response.promise]);
    const refresh = refreshAssociationStore(
      host,
      "workspace-1",
      new AbortController().signal,
    );

    associationStore.clear();
    response.resolve({
      associations: [
        {
          review_key: "team/app#3",
          task_id: "task-late",
          task_title: "Late",
        },
      ],
    });
    await refresh;

    expect(associationStore.get("workspace-1")).toEqual([]);
  });
});

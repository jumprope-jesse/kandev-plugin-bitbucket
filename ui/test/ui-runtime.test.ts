import { describe, expect, it, vi } from "vitest";
import { collectPluginActionPages } from "../src/ui-runtime";
import type { PluginHost } from "../src/host-contract";

describe("collectPluginActionPages", () => {
  it("consumes every opaque cursor without dropping repositories after page one", async () => {
    const invokeAction = vi
      .fn()
      .mockResolvedValueOnce({
        repositories: [{ id: "repo-1" }],
        next_cursor: "page-2",
      })
      .mockResolvedValueOnce({ repositories: [{ id: "repo-26" }] });
    const api = { baseUrl: "", invokeAction } as PluginHost["api"];

    const result = await collectPluginActionPages(
      api,
      "repositories.list",
      { workspaceId: "workspace-1", body: { limit: 100 } },
      "repositories",
      new AbortController().signal,
    );

    expect(result.repositories).toEqual([{ id: "repo-1" }, { id: "repo-26" }]);
    expect(invokeAction).toHaveBeenNthCalledWith(
      1,
      "repositories.list",
      { workspaceId: "workspace-1", body: { limit: 100, cursor: "" } },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(invokeAction).toHaveBeenNthCalledWith(
      2,
      "repositories.list",
      { workspaceId: "workspace-1", body: { limit: 100, cursor: "page-2" } },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("fails a repeated provider cursor instead of looping forever", async () => {
    const api = {
      baseUrl: "",
      invokeAction: vi
        .fn()
        .mockResolvedValue({ repositories: [], next_cursor: "same" }),
    } as PluginHost["api"];

    await expect(
      collectPluginActionPages(
        api,
        "repositories.list",
        { workspaceId: "workspace-1" },
        "repositories",
        new AbortController().signal,
      ),
    ).rejects.toThrow("pagination did not advance");
  });
});

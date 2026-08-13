import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Bitbucket manifest", () => {
  it("declares authenticated UI actions and native provider registrations", async () => {
    const manifest = await readFile(new URL("../../manifest.yaml", import.meta.url), "utf8");

    expect(manifest).toContain('key: "connection.get"');
    expect(manifest).toMatch(/key: "connection\.disconnect", scope: "workspace"/);
    expect(manifest).not.toContain("resource_scope:");
    expect(manifest).toContain('key: "pullrequests.queue"');
    expect(manifest).toContain('key: "pullrequests.link"');
    expect(manifest).toContain('api_write: ["tasks"]');
    expect(manifest.match(/^  api_write: \["tasks"\]$/gm)).toHaveLength(1);
    expect(manifest).not.toContain('key: "pullrequests.launch"');
    expect(manifest).not.toContain('key: "pullrequests.update"');
    expect(manifest).toContain('repository_providers: ["bitbucket"]');
    expect(manifest).toContain('source: "bitbucket"');
  });

  it("materializes both pre-release Kandev SDKs in every packaging workflow", async () => {
    const workflows = await Promise.all(
      ["build.yml", "ci.yml", "release.yml"].map((name) =>
        readFile(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8"),
      ),
    );

    for (const workflow of workflows) {
      expect(workflow).toContain("apps/backend");
      expect(workflow).toContain("apps/packages/plugin-sdk");
    }
  });
});

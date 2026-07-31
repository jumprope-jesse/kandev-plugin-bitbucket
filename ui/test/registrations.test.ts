import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type Registration = { id: string; lifecycle: { initialize: (registry: Registry, host: Host) => void; destroy?: () => void } };

type TaskContext = { workspaceId: string; taskId: string; repositories: unknown[]; pathname: string; presentation: "desktop" | "mobile" };
type TaskAction = { id: string; placement: string; visible?: (context: TaskContext) => boolean; run: (context: TaskContext) => Promise<void> };
type OpenedModal = {
  title: string;
  content: () => unknown;
  presentation?: "dialog" | "drawer";
};
type Invocation = { key: string; options?: { signal?: AbortSignal } };

type Registry = {
  registerNavItem: (item: { path: string }) => void;
  registerRoute: (path: string, component: unknown) => void;
  registerComponent: (slot: string, component: unknown) => void;
  registerRepositoryProvider: (provider: {
    id: string;
    matchesURL: (url: string) => boolean;
    listRepositories(context: { workspaceId: string; signal: AbortSignal }): Promise<unknown[]>;
  }) => void;
  registerTaskAction: (action: TaskAction) => void;
  registerReviewProvider: (provider: { id: string }) => void;
  registerWsHandler: () => void;
};

type Host = {
  React: { useState: <T>(value: T | (() => T)) => [T, (value: T) => void]; useEffect: () => void; useMemo: <T>(factory: () => T) => T; useCallback: <T>(callback: T) => T; useRef: <T>(value: T) => { current: T } };
  jsx: (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => unknown;
  ui: Record<string, unknown>;
  api: {
    invokeAction: (
      key: string,
      input?: unknown,
      options?: { signal?: AbortSignal },
    ) => Promise<unknown>;
  };
  useResponsiveBreakpoint: () => { isMobile: boolean };
  store: { getState: () => Record<string, unknown>; subscribe: () => () => void };
  navigate: () => void;
  openModal: (options: OpenedModal) => { close: () => void };
};

const ui = new Proxy({}, { get: (_, key) => String(key) }) as Record<string, unknown>;

function modalHost(isMobile: boolean, opened: OpenedModal[], invocations: Invocation[] = []): Host {
  return {
    React: {
      useState: <T>(value: T | (() => T)) => [typeof value === "function" ? (value as () => T)() : value, () => {}],
      useEffect: () => {},
      useMemo: <T>(factory: () => T) => factory(),
      useCallback: <T>(callback: T) => callback,
      useRef: <T>(value: T) => ({ current: value }),
    },
    jsx: (type, props, ...children) => ({ type, props, children }),
    ui,
    api: { invokeAction: async (key, _input, options) => { invocations.push({ key, options }); return {}; } },
    useResponsiveBreakpoint: () => ({ isMobile }),
    store: { getState: () => ({}), subscribe: () => () => {} },
    navigate: () => {},
    openModal: (options) => {
      opened.push(options);
      return { close: () => {} };
    },
  };
}

describe("Bitbucket plugin registrations", () => {
  it("registers native repo, Link, and review surfaces", async () => {
    const source = await readFile(new URL("../bundle.js", import.meta.url), "utf8");
    const registrations: Registration[] = [];

    vm.runInNewContext(source, {
      window: {
        registerKandevPlugin(id: string, lifecycle: Registration["lifecycle"]) {
          registrations.push({ id, lifecycle });
        },
      },
    });

    const repositoryProviders: Array<{
      id: string;
      matchesURL: (url: string) => boolean;
      listRepositories(context: { workspaceId: string; signal: AbortSignal }): Promise<unknown[]>;
    }> = [];
    const taskActions: unknown[] = [];
    const reviewProviders: unknown[] = [];
    const invocations: Invocation[] = [];
    registrations[0]?.lifecycle.initialize(
      {
        registerNavItem: () => {},
        registerRoute: () => {},
        registerComponent: () => {},
        registerRepositoryProvider: (provider) => repositoryProviders.push(provider),
        registerTaskAction: (action) => taskActions.push(action),
        registerReviewProvider: (provider) => reviewProviders.push(provider),
        registerWsHandler: () => {},
      },
      modalHost(false, [], invocations),
    );

    expect(registrations[0]?.id).toBe("kandev-plugin-bitbucket");
    expect(registrations[0]?.lifecycle.destroy).toBeTypeOf("function");
    expect(source).toContain("bitbucket-connection-identity");
    expect(source).toContain("Atlassian account email");
    expect(source).toContain("Bitbucket username");
    expect(source).toContain("aria-describedby");
    expect(source).toContain("auth_identity");
    expect(source).toContain("details.auth_identity");
    expect(source).toContain("bitbucket-cloud-workspace");
    expect(source).toContain("Bitbucket workspace");
    expect(source).toContain("cloud_workspace");
    expect(source).toContain("bitbucket-oauth-client-id");
    expect(source).toContain("bitbucket-oauth-client-secret");
    expect(source).toContain("bitbucket-oauth-callback-url");
    expect(source).toContain("oauth_redirect_url");
    expect(source).toContain("oauth_registration_configured");
    expect(source).toContain("user_pat");
    expect(source).toContain("project_token");
    expect(source).toContain("repository_token");
    expect(source).toContain("readOnly: true");
    expect(source).not.toContain("bitbucket-oauth-authorization-url");
    expect(source).not.toContain("bitbucket-oauth-token-url");
    expect(source).not.toContain("oauth_authorization_url");
    expect(source).not.toContain("oauth_token_url");
    expect(source).not.toContain("http_token");
    expect(source).toContain('connectionDisconnect: "connection.disconnect"');
    expect(source).toContain("Disconnect Bitbucket");
    expect(source).toContain("Disconnect Bitbucket connection?");
    expect(source).toContain("ui.DrawerContent");
    expect(source).toMatch(/invokeAction\(action\.connectionDisconnect, disconnectConnectionInput\(/);
    expect(source).toContain("setToken(\"\")");
    expect(source).toContain("setOAuthClientSecret(\"\")");
    expect(source).toContain("setMessage(\"Bitbucket disconnected. Stored credentials cleared.\")");
    expect(source).toContain("setError(errorMessage(reason))");
    expect(source).toContain("connection.refresh()");
    expect(source).toContain("oauthStartInput(scopedWorkspaceId)");
    expect(source).toContain("disabled: saving || !oauthReady");
    expect(source).toContain("makeCreatePullRequestModal");
    expect(source).toContain("makeLinkPullRequestModal");
    expect(source).toContain("makeUnlinkPullRequestModal");
    expect(source).toContain("pullRequestCreateBody");
    expect(source).toContain("linkPullRequestBody");
    expect(source).toContain("taskSupportsBitbucketRepository(context.repositories)");
    expect(source).toContain("Linked pull request");
    expect(source).not.toContain("bitbucket-pr-source");
    expect(source).not.toContain("source: source.trim()");
    expect(source).toContain("filter: watchFilter");
    expect(source).toContain("invoke(action.watchesUpdate, { enabled: true, filter })");
    expect(source).toContain('watchesPreviewDelete: "watches.preview_delete"');
    expect(source).toContain('watchesReset: "watches.reset"');
    expect(source).toContain("setError(errorMessage(reason))");
    expect(source).toContain('className: "bb-error", role: "alert"');
    expect(source).toContain("action.pullRequestsLaunch, { workspaceId: scopedWorkspaceId, body");
    expect(source).toContain("function launchPresets()");
    expect(source).toContain('id: "default", name: "Default"');
    expect(source).not.toContain("No saved launch presets");
    expect(source).not.toContain("Workspace default");
    expect(source).toContain('reviewsAction: "reviews.action"');
    expect(source).toContain("function useAbortableAction");
    expect(source).toContain("controller.abort()");
    expect(source).toContain("signal: controller.signal");
    expect(source).toContain("Stop waiting");
    expect(source).toContain("isMobile && working");
    expect(source).not.toContain('pullRequestsUpdate: "pullrequests.update"');
    expect(source).not.toContain("repositoryId: pullRequest.repositoryId, body");
    expect(repositoryProviders).toHaveLength(1);
    expect(repositoryProviders[0]?.matchesURL("https://git.example.test/scm/ENG/widgets.git")).toBe(true);
    const controller = new AbortController();
    await repositoryProviders[0]?.listRepositories({
      workspaceId: "workspace-1",
      signal: controller.signal,
    });
    expect(invocations[0]?.options?.signal).toBe(controller.signal);
    expect(taskActions).toEqual(
      expect.arrayContaining([expect.objectContaining({ placement: "link" })]),
    );
    expect(reviewProviders).toEqual([expect.objectContaining({ id: "bitbucket" })]);
  });

  it("registers provider-aware task forms for desktop and mobile", async () => {
    const source = await readFile(new URL("../bundle.js", import.meta.url), "utf8");
    for (const presentation of ["desktop", "mobile"] as const) {
      const registrations: Registration[] = [];
      const taskActions: TaskAction[] = [];
      const opened: OpenedModal[] = [];
      vm.runInNewContext(source, { window: { registerKandevPlugin: (id: string, lifecycle: Registration["lifecycle"]) => registrations.push({ id, lifecycle }) } });
      registrations[0]?.lifecycle.initialize(
        {
          registerNavItem: () => {},
          registerRoute: () => {},
          registerComponent: () => {},
          registerRepositoryProvider: () => {},
          registerTaskAction: (action) => taskActions.push(action),
          registerReviewProvider: () => {},
          registerWsHandler: () => {},
        },
        modalHost(presentation === "mobile", opened),
      );
      const context: TaskContext = { workspaceId: "workspace-1", taskId: "task-1", repositories: [{ provider_id: "bitbucket" }], pathname: "/tasks/task-1", presentation };
      const create = taskActions.find((action) => action.id === "create-pull-request");
      const link = taskActions.find((action) => action.id === "link-pull-request");
      const unlink = taskActions.find((action) => action.id === "unlink-pull-request");

      expect(create?.visible?.({ ...context, repositories: [{ provider: "github" }] })).toBe(false);
      expect(create?.visible?.(context)).toBe(true);
      await create?.run(context);
      await link?.run(context);
      await unlink?.run(context);

      expect(opened.map((modal) => modal.title)).toEqual([
        "Create Bitbucket pull request",
        "Link Bitbucket pull request",
        "Unlink Bitbucket pull request",
      ]);
      expect(opened.map((modal) => modal.presentation)).toEqual(
        Array(3).fill(presentation === "mobile" ? "drawer" : "dialog"),
      );
      expect(JSON.stringify(opened[0]?.content())).toContain("bitbucket-pr-destination");
      expect(JSON.stringify(opened[0]?.content())).not.toContain("bitbucket-pr-source");
      expect(JSON.stringify(opened[1]?.content())).toContain("bitbucket-review-reference");
    }
  });
});

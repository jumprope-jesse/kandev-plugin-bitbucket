import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type Registration = { id: string; lifecycle: { initialize: (registry: Registry, host: Host) => void; destroy?: () => void } };

type TaskContext = { workspaceId: string; taskId: string; repositories: unknown[]; pathname: string; presentation: "desktop" | "mobile" };
type TaskAction = { id: string; label: string; placement: string; visible?: (context: TaskContext) => boolean; run: (context: TaskContext) => Promise<void> };
type OpenedModal = {
  title: string;
  content: () => unknown;
  presentation?: "dialog" | "drawer";
};
type OpenedTaskLinkDialog = {
  title: string;
  description: string;
  inputLabel: string;
  placeholder: string;
  emptyError: string;
  failureMessage: string;
  successMessage: string;
  onSubmit: (reference: string) => Promise<void>;
};
type Invocation = { key: string; input?: unknown; options?: { signal?: AbortSignal } };
type IntegrationSettings = {
  id: string;
  label: string;
  description: string;
  icon?: string;
  Component: (props: { workspaceId?: string }) => unknown;
};
type ReviewProvider = {
  id: string;
  icon: string;
  getSnapshot(taskId: string): readonly Record<string, unknown>[];
  refresh(taskId: string, signal: AbortSignal): Promise<void>;
  getAssociationSnapshot?(workspaceId: string): readonly Record<string, unknown>[];
  refreshAssociations?(workspaceId: string, signal: AbortSignal): Promise<void>;
  unlink?(context: { workspaceId: string; taskId: string; reviewKey: string; signal: AbortSignal }): Promise<void>;
  ReviewPanel: (props: Record<string, unknown>) => unknown;
};

type Registry = {
  registerNavItem: (item: { path: string; icon: string }) => void;
  registerRoute: (path: string, component: unknown, options?: Record<string, unknown>) => void;
  registerComponent: (slot: string, component: unknown) => void;
  registerIntegrationSettings: (settings: IntegrationSettings) => void;
  registerRepositoryProvider: (provider: {
    id: string;
    icon: string;
    matchesURL: (url: string) => boolean;
    listRepositories(context: { workspaceId: string; signal: AbortSignal }): Promise<unknown[]>;
    createChangeRequest?(context: Record<string, unknown>): Promise<Record<string, unknown>>;
    supportsDraft?: boolean;
  }) => void;
  registerTaskAction: (action: TaskAction & { icon: string }) => void;
  registerReviewProvider: (provider: ReviewProvider) => void;
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
  openTaskLinkDialog: (options: OpenedTaskLinkDialog) => { close: () => void };
  storage: {
    get: () => Promise<undefined>;
    set: () => Promise<{ updatedAt: string }>;
    subscribe: () => () => void;
  };
};

const ui = new Proxy({}, { get: (_, key) => String(key) }) as Record<string, unknown>;

function modalHost(
  isMobile: boolean,
  opened: OpenedModal[],
  invocations: Invocation[] = [],
  taskLinks: OpenedTaskLinkDialog[] = [],
  results: unknown[] = [],
): Host {
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
    api: { invokeAction: async (key, input, options) => { invocations.push({ key, input, options }); return results.shift() ?? {}; } },
    useResponsiveBreakpoint: () => ({ isMobile }),
    store: { getState: () => ({}), subscribe: () => () => {} },
    navigate: () => {},
    openModal: (options) => {
      opened.push(options);
      return { close: () => {} };
    },
    openTaskLinkDialog: (options) => {
      taskLinks.push(options);
      return { close: () => {} };
    },
    storage: {
      get: async () => undefined,
      set: async () => ({ updatedAt: new Date(0).toISOString() }),
      subscribe: () => () => {},
    },
  };
}

describe("Bitbucket plugin registrations", () => {
  it("registers native repo, Link, and review surfaces", async () => {
    const source = await readFile(new URL("../bundle.js", import.meta.url), "utf8");
    const sourceModule = await readFile(new URL("../src/bundle.ts", import.meta.url), "utf8");
    const styles = await readFile(new URL("../plugin.css", import.meta.url), "utf8");
    const registrations: Registration[] = [];

    vm.runInNewContext(source, {
      AbortController,
      window: {
        registerKandevPlugin(id: string, lifecycle: Registration["lifecycle"]) {
          registrations.push({ id, lifecycle });
        },
      },
    });

    const repositoryProviders: Array<{
      id: string;
      icon: string;
      matchesURL: (url: string) => boolean;
      listRepositories(context: { workspaceId: string; signal: AbortSignal }): Promise<unknown[]>;
      supportsDraft?: boolean;
      createChangeRequest?(context: Record<string, unknown>): Promise<Record<string, unknown>>;
    }> = [];
    const taskActions: unknown[] = [];
    const reviewProviders: ReviewProvider[] = [];
    const navItems: Array<{ path: string; icon: string }> = [];
    const routes: Array<{ path: string; options?: Record<string, unknown> }> = [];
    const integrations: IntegrationSettings[] = [];
    const components: string[] = [];
    const invocations: Invocation[] = [];
    registrations[0]?.lifecycle.initialize(
      {
        registerNavItem: (item) => navItems.push(item),
        registerRoute: (path, _component, options) => routes.push({ path, options }),
        registerComponent: (slot) => components.push(slot),
        registerIntegrationSettings: (settings) => integrations.push(settings),
        registerRepositoryProvider: (provider) => repositoryProviders.push(provider),
        registerTaskAction: (action) => taskActions.push(action),
        registerReviewProvider: (provider) => reviewProviders.push(provider),
        registerWsHandler: () => {},
      },
      modalHost(false, [], invocations),
    );

    expect(registrations[0]?.id).toBe("kandev-plugin-bitbucket");
    expect(registrations[0]?.lifecycle.destroy).toBeTypeOf("function");
    expect(navItems).toEqual([expect.objectContaining({ path: "/bitbucket", icon: "bitbucket" })]);
    expect(routes[0]?.options).toEqual(
      expect.objectContaining({
        topbar: expect.objectContaining({ icon: "bitbucket" }),
      }),
    );
    expect(components).not.toContain("plugin-settings");
    expect(components).not.toContain("chat-top-bar");
    expect(integrations).toEqual([
      expect.objectContaining({
        id: "bitbucket",
        label: "Bitbucket",
        icon: "bitbucket",
      }),
    ]);
    expect(JSON.stringify(integrations[0]?.Component({ workspaceId: "workspace-1" }))).toContain(
      "workspace-1",
    );
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
    const authenticationField = source.indexOf('htmlFor: "bitbucket-auth-method"');
    const settingsSeparator = source.indexOf("ui.Separator", authenticationField);
    const settingsActions = source.indexOf('className: "bb-settings-actions"', settingsSeparator);
    const checkConnection = source.indexOf('"Check connection"', settingsActions);
    const destructiveDisconnect = source.indexOf('className: "bb-settings-disconnect min-h-11"', settingsActions);
    expect(authenticationField).toBeGreaterThan(-1);
    expect(settingsSeparator).toBeGreaterThan(authenticationField);
    expect(settingsActions).toBeGreaterThan(settingsSeparator);
    expect(checkConnection).toBeGreaterThan(settingsActions);
    expect(destructiveDisconnect).toBeGreaterThan(checkConnection);
    expect(source.slice(destructiveDisconnect - 100, destructiveDisconnect)).toContain(
      'variant: "destructive"',
    );
    expect(styles).toContain(".bb-settings-disconnect { margin-left: auto;");
    expect(styles).toMatch(/@media \(max-width: 639px\)[\s\S]*\.bb-settings-actions > button[^}]*min-height: 2\.75rem/);
    expect(source).toContain("ui.DrawerContent");
    expect(source).toMatch(/invokeAction\(action\.connectionDisconnect, disconnectConnectionInput\(/);
    expect(source).toContain("setToken(\"\")");
    expect(source).toContain("setOAuthClientSecret(\"\")");
    expect(source).toContain("setMessage(\"Bitbucket disconnected. Stored credentials cleared.\")");
    expect(source).toContain("setError(errorMessage(reason))");
    expect(source).toContain("connection.refresh()");
    expect(source).toContain("oauthStartInput(scopedWorkspaceId)");
    expect(source).toContain("disabled: saving || !oauthReady");
    expect(source).not.toContain("makeCreatePullRequestModal");
    expect(source).not.toContain("makeLinkPullRequestModal");
    expect(source).not.toContain("makeUnlinkPullRequestModal");
    expect(source).toContain("linkPullRequestBody");
    expect(source).not.toContain('placement: "action"');
    expect(source).not.toContain("bitbucket-pr-source");
    expect(source).not.toContain("source: source.trim()");
    expect(source).toContain("function Watches");
    expect(source).not.toContain("Watch current filters");
    expect(source).toContain('watchesPreviewDelete: "watches.preview_delete"');
    expect(source).toContain('watchesReset: "watches.reset"');
    expect(source).toContain("setError(errorMessage(reason))");
    expect(source).toContain('className: "bb-error", role: "alert"');
    expect(source).toContain("ui.ChangeRequestList");
    expect(source).toContain("ui.IntegrationListToolbar");
    expect(source).toContain("lastFetchedAt: queue.lastFetchedAt");
    expect(source).toContain("ui.IntegrationScopeBar");
    expect(source).toContain("ui.IntegrationSaveQueryDialog");
    expect(source).toContain('host.storage.get("workspace"');
    expect(source).toContain('host.storage.set("workspace"');
    expect(source).not.toContain("canSaveCurrent: false");
    expect(source).toContain("ui.IntegrationStartTaskMenu");
    expect(source).toContain("iconName: \"eye\"");
    expect(source).toContain("iconName: \"message\"");
    expect(source).toContain("iconName: \"tool\"");
    expect(source).not.toContain("ui.IntegrationChangeRequestStatus");
    expect(source).toContain("ui.ChangeRequestDetail");
    expect(source).not.toContain("ui.Tabs");
    expect(source).not.toContain('className: "bb-review-tabs"');
    expect(source).not.toContain("React.Fragment");
    expect(source).not.toContain("host.openTaskReview");
    expect(source).not.toContain("window.setInterval(() => void refresh(), 9e4)");
    expect(source).toContain("ui.TaskRowIndicator");
    expect(source).toContain("ui.TaskCreateDialog");
    expect(source).toContain('id: "review"');
    expect(source).toContain('id: "address-feedback"');
    expect(source).toContain('id: "fix-ci"');
    expect(source).not.toContain("function LaunchPresets");
    expect(source).not.toContain("action.pullRequestsLaunch");
    expect(source).not.toContain("Review pull request #");
    expect(source).toContain('reviewsAction: "reviews.action"');
    expect(source).toContain('tasksLaunch: "tasks.launch"');
    expect(source).toContain("createTask: usePluginTaskCreation(selectedHostRepositoryId)");
    expect(source).toContain("refreshReviewStore");
    expect(source).toContain("function useAbortableAction");
    expect(source).toContain("controller.abort()");
    expect(source).toContain("signal: controller.signal");
    expect(source).not.toContain("Stop waiting");
    expect(source).not.toContain("bb-inline-review-action");
    expect(source).not.toContain("function PullRequestActions");
    expect(sourceModule).not.toContain("function PullRequestActions");
    expect(sourceModule).not.toContain("function ThreadReply");
    expect(sourceModule).not.toContain("function LegacyReviewDetailPanel");
    expect(styles).not.toContain(".bb-review-detail");
    expect(styles).not.toContain(".bb-review-actions");
    expect(styles).not.toContain(".bb-review-tabs");
    expect(styles).not.toContain(".bb-detail-list");
    expect(source).toContain("notice: actionError");
    expect(source).toContain("ui.Separator");
    expect(source).not.toContain('"Review actions"');
    expect(source).not.toContain('"Launch task"');
    expect(source).not.toContain('pullRequestsUpdate: "pullrequests.update"');
    expect(source).not.toContain("repositoryId: pullRequest.repositoryId, body");
    expect(repositoryProviders).toHaveLength(1);
    expect(repositoryProviders[0]?.icon).toBe("bitbucket");
    expect(repositoryProviders[0]?.matchesURL("https://git.example.test/scm/ENG/widgets.git")).toBe(true);
    expect(repositoryProviders[0]?.supportsDraft).toBe(false);
    const controller = new AbortController();
    await repositoryProviders[0]?.listRepositories({
      workspaceId: "workspace-1",
      signal: controller.signal,
    });
    expect(invocations[0]?.options?.signal).toBe(controller.signal);
    await repositoryProviders[0]?.createChangeRequest?.({
      workspaceId: "workspace-1",
      taskId: "task-1",
      repositoryId: "repository-1",
      title: "Native title",
      body: "Native body",
      baseBranch: "main",
      draft: false,
      signal: controller.signal,
    });
    expect(invocations).toContainEqual(expect.objectContaining({
      key: "pullrequests.create",
      input: {
        workspaceId: "workspace-1",
        taskId: "task-1",
        repositoryId: "repository-1",
        body: { title: "Native title", description: "Native body", destination: "main" },
      },
    }));
    expect(taskActions).toEqual(
      expect.arrayContaining([expect.objectContaining({ placement: "link" })]),
    );
    expect(taskActions).toEqual(
      expect.arrayContaining([expect.objectContaining({ icon: "bitbucket" })]),
    );
    expect(taskActions.every((candidate) => (candidate as { icon?: string }).icon === "bitbucket")).toBe(true);
    expect(reviewProviders).toEqual([expect.objectContaining({ id: "bitbucket" })]);
    expect(reviewProviders[0]?.icon).toBe("bitbucket");
    expect(reviewProviders[0]?.getAssociationSnapshot).toBeTypeOf("function");
    expect(reviewProviders[0]?.refreshAssociations).toBeTypeOf("function");
    expect(reviewProviders[0]?.unlink).toBeTypeOf("function");
    await reviewProviders[0]?.refreshAssociations?.("workspace-1", controller.signal);
    await reviewProviders[0]?.unlink?.({
      workspaceId: "workspace-1",
      taskId: "task-1",
      reviewKey: "workspace/repo#42",
      signal: controller.signal,
    });
    expect(invocations).toContainEqual(
      expect.objectContaining({
        key: "pullrequests.unlink",
        input: {
          workspaceId: "workspace-1",
          taskId: "task-1",
          body: { review_key: "workspace/repo#42" },
        },
      }),
    );
    const mobilePanel = reviewProviders[0]?.ReviewPanel({
      workspaceId: "workspace-1",
      taskId: "task-1",
      reviewKey: "workspace/repo#42",
      presentation: "mobile",
    }) as { props?: Record<string, unknown> };
    expect(mobilePanel.props?.presentation).toBe("mobile");
    expect(source).toContain('pullRequestsAssociations: "pullrequests.associations"');
    expect(source).toContain('testId: "bitbucket-scope-bar"');
    expect(source).toContain('titleTestId: "bitbucket-list-toolbar"');
    expect(source).toContain('"data-testid": "bitbucket-results"');
    expect(source).not.toContain("bitbucketReviewHref");
    expect(source).not.toContain("?review=");
    expect(source).not.toContain("bb-desktop-panes");
    expect(styles).not.toContain(".bb-desktop-panes");
  });

  it("hydrates head-commit checks through the review-provider snapshot", async () => {
    const source = await readFile(new URL("../bundle.js", import.meta.url), "utf8");
    const registrations: Registration[] = [];
    vm.runInNewContext(source, {
      AbortController,
      window: {
        registerKandevPlugin(id: string, lifecycle: Registration["lifecycle"]) {
          registrations.push({ id, lifecycle });
        },
      },
    });
    const reviewProviders: ReviewProvider[] = [];
    const results = [
      {
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
      },
      {
        id: "42",
        review_key: "acme/widgets#42",
        number: 42,
        title: "Fix CI",
        url: "https://bitbucket.org/acme/widgets/pull-requests/42",
        repository_id: "acme/widgets",
        repository_name: "widgets",
        state: "OPEN",
        statuses: [{ key: "pipeline", name: "Pipelines", state: "FAILED" }],
      },
    ];
    registrations[0]?.lifecycle.initialize(
      {
        registerNavItem: () => {},
        registerRoute: () => {},
        registerComponent: () => {},
        registerIntegrationSettings: () => {},
        registerRepositoryProvider: () => {},
        registerTaskAction: () => {},
        registerReviewProvider: (provider) => reviewProviders.push(provider),
        registerWsHandler: () => {},
      },
      modalHost(false, [], [], [], results),
    );

    await reviewProviders[0]?.refresh("task-1", new AbortController().signal);

    expect(reviewProviders[0]?.getSnapshot("task-1")).toEqual([
      expect.objectContaining({
        reviewKey: "acme/widgets#42",
        taskStatus: {
          number: 42,
          state: "open",
          pipelineState: "failure",
          checks: [{ id: "pipeline", label: "Pipelines", state: "failure" }],
          updatedAt: expect.any(Number),
        },
      }),
    ]);
  });

  it("registers only the supported native task-link form on desktop and mobile", async () => {
    const source = await readFile(new URL("../bundle.js", import.meta.url), "utf8");
    for (const presentation of ["desktop", "mobile"] as const) {
      const registrations: Registration[] = [];
      const taskActions: TaskAction[] = [];
      const opened: OpenedModal[] = [];
      const taskLinks: OpenedTaskLinkDialog[] = [];
      const invocations: Invocation[] = [];
      vm.runInNewContext(source, {
        AbortController,
        window: { registerKandevPlugin: (id: string, lifecycle: Registration["lifecycle"]) => registrations.push({ id, lifecycle }) },
      });
      registrations[0]?.lifecycle.initialize(
        {
          registerNavItem: () => {},
          registerRoute: () => {},
          registerComponent: () => {},
          registerIntegrationSettings: () => {},
          registerRepositoryProvider: () => {},
          registerTaskAction: (action) => taskActions.push(action),
          registerReviewProvider: () => {},
          registerWsHandler: () => {},
        },
        modalHost(presentation === "mobile", opened, invocations, taskLinks),
      );
      const context: TaskContext = { workspaceId: "workspace-1", taskId: "task-1", repositories: [{ provider_id: "bitbucket" }], pathname: "/tasks/task-1", presentation };
      const link = taskActions.find((action) => action.id === "link-pull-request");

      expect(link?.label).toBe("Bitbucket Pull Request");
      expect(taskActions).toHaveLength(1);
      await link?.run(context);
      expect(opened).toEqual([]);
      expect(taskLinks).toEqual([
        expect.objectContaining({
          title: "Link Bitbucket pull request",
          description: "Use a Bitbucket pull request URL or canonical key for this task.",
          inputLabel: "Pull request",
          placeholder: "workspace/repository#42",
          successMessage: "Bitbucket pull request linked",
        }),
      ]);
      await taskLinks[0]?.onSubmit(" workspace/repository#42 ");
      expect(invocations.find((invocation) => invocation.key === "pullrequests.link")).toMatchObject({
        key: "pullrequests.link",
        input: {
          workspaceId: "workspace-1",
          taskId: "task-1",
          body: { review_key: "workspace/repository#42" },
        },
      });
      expect(invocations.some((invocation) => invocation.key === "pullrequests.get")).toBe(true);
    }
  });
});

import {
  activeWorkspaceIdFromState,
  connectionActionBody,
  connectionIdentity,
  connectionOAuthRegistration,
  connectionSaveBody,
  currentWatchFilter,
  deriveOAuthCallbackURL,
  disconnectConnectionInput,
  linkPullRequestBody,
  normalizeRepositoryInspection,
  normalizeRepositories,
  normalizePullRequests,
  normalizeReviewDetail,
  normalizeWatches,
  launchPresets,
  oauthStartInput,
  pullRequestCreateBody,
  pluginRepositoryInput,
  statusTone,
  taskSupportsBitbucketRepository,
  taskRepositoryDescriptor,
  validateCloudWorkspace,
  validateConnectionIdentity,
  validateOAuthRegistration,
  workspacePullRequestAction,
  workspaceReviewAction,
} from "../src/view-models";
import { describe, expect, it } from "vitest";

describe("Bitbucket view models", () => {
  it("reads the active workspace from the host workspace slice", () => {
    expect(activeWorkspaceIdFromState({ workspaces: { activeId: "workspace-1" } })).toBe(
      "workspace-1",
    );
    expect(activeWorkspaceIdFromState({ activeWorkspaceId: "legacy-wrong-shape" })).toBeUndefined();
  });

  it("normalizes queue data without leaking provider payload shape into components", () => {
    expect(
      normalizePullRequests({
        values: [
          {
            id: 42,
            title: "Improve mobile review",
            repository: { id: "repo-1", name: "mobile" },
            state: "OPEN",
            author: { display_name: "Ari" },
            capabilities: "merge, decline",
          },
        ],
      }),
    ).toEqual([
      expect.objectContaining({
        key: "repo-1:42",
        number: 42,
        repositoryName: "mobile",
        author: "Ari",
        capabilities: ["merge", "decline"],
      }),
    ]);
  });

  it("maps Bitbucket repository descriptors between plugin snake case and host camel case", () => {
    const serverRepository = {
      id: "acme/widgets",
      name: "widgets",
      owner_or_project: "acme",
      provider_id: "bitbucket",
      provider_host: "bitbucket.org",
      provider_repository_id: "acme/widgets",
      clone_url: "https://bitbucket.org/acme/widgets.git",
      default_branch: "main",
    };
    const expectedRepository = {
      ownerOrProject: "acme",
      providerId: "bitbucket",
      providerHost: "bitbucket.org",
      repositoryId: "acme/widgets",
      repositoryName: "widgets",
      cloneUrl: "https://bitbucket.org/acme/widgets.git",
      defaultBranch: "main",
    };
    const repository = normalizeRepositoryInspection(serverRepository);

    expect(repository).toEqual(expectedRepository);
    expect(normalizeRepositories({ repositories: [serverRepository] })).toEqual([expectedRepository]);
    expect(pluginRepositoryInput(repository)).toEqual({
      provider_id: "bitbucket",
      provider_host: "bitbucket.org",
      owner_or_project: "acme",
      provider_repository_id: "acme/widgets",
      name: "widgets",
      clone_url: "https://bitbucket.org/acme/widgets.git",
      default_branch: "main",
    });
  });

  it("preserves pull-request inspection metadata required by native task import", () => {
    expect(
      normalizeRepositoryInspection({
        repository: {
          provider_id: "bitbucket",
          provider_host: "bitbucket.example.test",
          owner_or_project: "ENG",
          provider_repository_id: "ENG/widgets",
          name: "widgets",
          clone_url: "https://bitbucket.example.test/scm/eng/widgets.git",
        },
        pull_request: { number: 42, title: "Ship native Bitbucket import" },
        base_branch: "main",
        head_branch: "feature/bitbucket",
      }),
    ).toEqual(
      expect.objectContaining({
        baseBranch: "main",
        headBranch: "feature/bitbucket",
        pullRequest: { number: 42, title: "Ship native Bitbucket import" },
      }),
    );
  });

  it("normalizes build statuses for the native review panel", () => {
    expect(
      normalizeReviewDetail({
        id: "42",
        number: 42,
        title: "Verify Pipelines",
        repository_id: "ENG/widgets",
        repository_name: "widgets",
        state: "OPEN",
        statuses: [
          {
            key: "build-42",
            name: "Bitbucket Pipelines",
            state: "SUCCESSFUL",
            url: "https://bitbucket.example.test/builds/42",
            target: "feature/bitbucket",
          },
        ],
      })?.statuses,
    ).toEqual([
      {
        key: "build-42",
        name: "Bitbucket Pipelines",
        state: "SUCCESSFUL",
        url: "https://bitbucket.example.test/builds/42",
        target: "feature/bitbucket",
      },
    ]);
  });

  it("preserves every comment in a review thread so replies remain visible", () => {
    expect(
      normalizeReviewDetail({
        id: "42",
        number: 42,
        title: "Show threaded discussion",
        repository_id: "ENG/widgets",
        repository_name: "widgets",
        state: "OPEN",
        threads: [
          {
            id: "10",
            comments: [
              { ID: "10", Author: "Ada", Body: "Please add a test." },
              { ID: "11", ParentID: "10", Author: "Bob", Body: "Done." },
            ],
          },
        ],
      })?.threads,
    ).toEqual([
      {
        id: "10",
        author: "Ada",
        body: "Please add a test.",
        resolved: false,
        comments: [
          { id: "10", author: "Ada", body: "Please add a test." },
          { id: "11", parentId: "10", author: "Bob", body: "Done." },
        ],
      },
    ]);
  });

  it("turns current queue filters into an exact watch filter", () => {
    expect(currentWatchFilter("  mobile review  ", "open")).toEqual({
      query: "mobile review",
      states: ["open"],
    });
    expect(currentWatchFilter("", "all")).toEqual({ query: "", states: [] });
  });

  it("derives a pull-request repository and branches from task context", () => {
    expect(
      taskRepositoryDescriptor(
        [{ repository_id: "host-repo-1", base_branch: "release", checkout_branch: "feature/task-42" }],
        [
          {
            id: "host-repo-1",
            provider: "bitbucket",
            provider_host: "bitbucket.org",
            provider_owner: "acme",
            provider_repo_id: "acme/widgets",
            provider_name: "widgets",
            remote_url: "https://bitbucket.org/acme/widgets.git",
            default_branch: "main",
          },
        ],
      ),
    ).toEqual({
      providerId: "bitbucket",
      providerHost: "bitbucket.org",
      ownerOrProject: "acme",
      repositoryId: "acme/widgets",
      repositoryName: "widgets",
      cloneUrl: "https://bitbucket.org/acme/widgets.git",
      defaultBranch: "main",
      baseBranch: "release",
      headBranch: "feature/task-42",
    });
  });

  it("sends only optional presentation overrides when creating from a task", () => {
    expect(
      pullRequestCreateBody({
        title: "Review task work",
        description: "Please review this task checkout.",
        destination: "release",
        closeSourceOnMerge: true,
      }),
    ).toEqual({
      title: "Review task work",
      description: "Please review this task checkout.",
      destination: "release",
      close_source_on_merge: true,
    });
    expect(pullRequestCreateBody({ title: " ", description: "", destination: "", closeSourceOnMerge: false })).toEqual({});
  });

  it("accepts Bitbucket pull-request keys or URLs for linking, but only existing keys for unlinking", () => {
    expect(linkPullRequestBody("acme/widgets#42")).toEqual({ review_key: "acme/widgets#42" });
    expect(linkPullRequestBody("https://bitbucket.org/acme/widgets/pull-requests/42")).toEqual({ review_key: "acme/widgets#42" });
    expect(linkPullRequestBody("https://bitbucket.example.test/projects/ENG/repos/widgets/pull-requests/42/overview")).toEqual({ review_key: "ENG/widgets#42" });
    expect(linkPullRequestBody("https://bitbucket.example.test/bitbucket/projects/ENG/repos/widgets/pull-requests/42/overview")).toEqual({ review_key: "ENG/widgets#42" });
    expect(linkPullRequestBody("https://bitbucket.org/acme/widgets/issues/42")).toBeNull();
  });

  it("shows create only when task repository context is Bitbucket or not yet known", () => {
    expect(taskSupportsBitbucketRepository([])).toBe(true);
    expect(taskSupportsBitbucketRepository([{ repository_id: "host-repository" }])).toBe(true);
    expect(taskSupportsBitbucketRepository([{ provider: "github" }])).toBe(false);
    expect(taskSupportsBitbucketRepository([{ provider_id: "bitbucket" }])).toBe(true);
  });

  it("uses workspace scope for remote pull-request actions without a provider-local repository ID", () => {
    const input = workspacePullRequestAction("workspace-1", "acme/widgets#42", "42", "merge");

    expect(input).toEqual({
      workspaceId: "workspace-1",
      body: { review_key: "acme/widgets#42", pull_request_id: "42", operation: "merge" },
    });
    expect(input).not.toHaveProperty("repositoryId");
    expect(input.body).not.toHaveProperty("repository_id");
  });

  it("builds bounded approve, comment, and reply review mutations", () => {
    expect(workspaceReviewAction("workspace-1", "acme/widgets#42", "42", "approve")).toEqual({
      workspaceId: "workspace-1",
      body: { review_key: "acme/widgets#42", pull_request_id: "42", kind: "approve" },
    });
    expect(
      workspaceReviewAction("workspace-1", "acme/widgets#42", "42", "reply", {
        comment: "  Looks good  ",
        parentCommentId: "thread-1",
      }),
    ).toEqual({
      workspaceId: "workspace-1",
      body: {
        review_key: "acme/widgets#42",
        pull_request_id: "42",
        kind: "reply",
        comment: "Looks good",
        parent_comment_id: "thread-1",
      },
    });
  });

  it("uses verified workspace scope for disconnect without a request body", () => {
    expect(disconnectConnectionInput("workspace-1")).toEqual({ workspaceId: "workspace-1" });
  });

  it("offers only server-supported launch presets", () => {
    expect(launchPresets()).toEqual([
      { id: "default", name: "Default" },
      { id: "review", name: "Review and test" },
      { id: "implement", name: "Implement change" },
    ]);
  });

  it("normalizes watch controls without exposing persisted internals", () => {
    expect(
      normalizeWatches({
        watches: [
          { id: "team-open", status: "running", last_polled: "2026-07-31T12:00:00Z" },
          { id: "paused", status: "paused" },
        ],
      }),
    ).toEqual([
      { id: "team-open", status: "running", lastPolled: "2026-07-31T12:00:00Z" },
      { id: "paused", status: "paused" },
    ]);
  });

  it("maps status states to a presentation tone", () => {
    expect(statusTone("build failed")).toBe("danger");
    expect(statusTone("pending review")).toBe("warning");
  });

  it("uses auth_identity only for Cloud API tokens and Data Center user credentials", () => {
    expect(connectionIdentity("cloud", "api_token")).toMatchObject({
      field: "auth_identity",
      label: "Atlassian account email",
      inputType: "email",
    });
    expect(connectionIdentity("data_center", "user_pat")).toMatchObject({
      field: "auth_identity",
      label: "Bitbucket username",
      inputType: "text",
    });
    expect(connectionIdentity("data_center", "oauth")).not.toBeNull();
    expect(connectionIdentity("data_center", "project_token")).toBeNull();
    expect(connectionIdentity("data_center", "repository_token")).toBeNull();
    expect(connectionIdentity("cloud", "oauth")).toBeNull();
  });

  it("submits required non-secret identity and omits it for Cloud OAuth", () => {
    const cloudToken = {
      product: "cloud",
      baseUrl: "",
      authMethod: "api_token",
      token: "secret-token",
      identity: "ari@example.test",
      cloudWorkspace: "acme-platform",
      oauthRegistrationConfigured: false,
      oauthClientId: "",
      oauthClientSecret: "",
      oauthCallbackUrl: "https://kandev.example.test/api/plugins/kandev-plugin-bitbucket/webhooks/oauth-callback",
    } as const;
    expect(validateCloudWorkspace(cloudToken)).toBeNull();
    expect(validateConnectionIdentity(cloudToken)).toBeNull();
    expect(connectionActionBody(cloudToken)).toMatchObject({
      product: "cloud",
      auth_method: "api_token",
      token: "secret-token",
      auth_identity: "ari@example.test",
      cloud_workspace: "acme-platform",
    });
    expect(validateCloudWorkspace({ ...cloudToken, cloudWorkspace: "" })).toContain("workspace");
    expect(validateConnectionIdentity({ ...cloudToken, identity: "" })).toContain("email");
    const cloudOAuth = connectionActionBody({ ...cloudToken, authMethod: "oauth" });
    expect(cloudOAuth).toHaveProperty("cloud_workspace", "acme-platform");
    expect(cloudOAuth).not.toHaveProperty("auth_identity");
    expect(cloudOAuth).not.toHaveProperty("token");

    const dataCenterProjectToken = connectionActionBody({
      ...cloudToken,
      product: "data_center",
      baseUrl: "https://bitbucket.example.test/bitbucket",
      cloudWorkspace: "",
      authMethod: "project_token",
      identity: "",
    });
    expect(dataCenterProjectToken).toMatchObject({
      product: "data_center",
      auth_method: "project_token",
      token: "secret-token",
    });
    expect(dataCenterProjectToken).not.toHaveProperty("auth_identity");
  });

  it("uses a derived callback and saved OAuth registration state without reflecting secrets", () => {
    const oauth = {
      product: "data_center",
      baseUrl: "https://bitbucket.example.test/bitbucket",
      cloudWorkspace: "",
      authMethod: "oauth",
      token: "",
      identity: "dev",
      oauthRegistrationConfigured: false,
      oauthClientId: "client-id",
      oauthClientSecret: "client-secret",
      oauthCallbackUrl: "https://kandev.example.test/api/plugins/kandev-plugin-bitbucket/webhooks/oauth-callback",
    } as const;

    expect(validateOAuthRegistration(oauth)).toBeNull();
    expect(connectionSaveBody(oauth)).toMatchObject({
      oauth_client_id: "client-id",
      oauth_client_secret: "client-secret",
      oauth_redirect_url: "https://kandev.example.test/api/plugins/kandev-plugin-bitbucket/webhooks/oauth-callback",
    });
    expect(connectionSaveBody(oauth)).not.toHaveProperty("oauth_authorization_url");
    expect(connectionSaveBody(oauth)).not.toHaveProperty("oauth_token_url");
    expect(connectionActionBody(oauth)).not.toHaveProperty("oauth_client_secret");
    expect(oauthStartInput("workspace-1")).toEqual({ workspaceId: "workspace-1" });
    expect(validateOAuthRegistration({ ...oauth, oauthClientSecret: "" })).toContain("secret");
    const savedRegistration = { ...oauth, oauthRegistrationConfigured: true, oauthClientId: "", oauthClientSecret: "" };
    expect(validateOAuthRegistration(savedRegistration)).toBeNull();
    expect(connectionSaveBody(savedRegistration)).not.toHaveProperty("oauth_client_id");
    expect(connectionSaveBody(savedRegistration)).not.toHaveProperty("oauth_client_secret");
    expect(connectionSaveBody(savedRegistration)).not.toHaveProperty("oauth_redirect_url");
    expect(connectionOAuthRegistration({
      oauth_client_secret: "must-not-reflect",
      oauth_registration_configured: true,
    })).toEqual({
      configured: true,
    });
    expect(deriveOAuthCallbackURL("https://kandev.example.test/workspaces/acme")).toBe("https://kandev.example.test/api/plugins/kandev-plugin-bitbucket/webhooks/oauth-callback");
  });
});

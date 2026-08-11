import type {
  ConnectionFormInput,
  ConnectionIdentity,
  ConnectionState,
  JsonRecord,
  OAuthRegistration,
  PullRequest,
  RepositoryInspection,
  TaskLaunchPreset,
  WatchSummary,
} from "./view-model-base";
import { itemList, record, string } from "./view-model-base";

export function connectionIdentity(
  product: string,
  authMethod: string,
): ConnectionIdentity | null {
  if (product === "cloud" && authMethod === "api_token") {
    return {
      field: "auth_identity",
      label: "Atlassian account email",
      help: "Used with this API token for Bitbucket Cloud REST. Git uses x-bitbucket-api-token-auth.",
      inputType: "email",
    };
  }
  if (
    product === "data_center" &&
    (authMethod === "user_pat" || authMethod === "oauth")
  ) {
    return {
      field: "auth_identity",
      label: "Bitbucket username",
      help: "Used for HTTPS Git with this Data Center PAT or OAuth credential.",
      inputType: "text",
    };
  }
  return null;
}

export function validateConnectionIdentity(
  input: ConnectionFormInput,
): string | null {
  const identity = connectionIdentity(input.product, input.authMethod);
  const value = input.identity.trim();
  if (!identity) return null;
  if (!value) return `Enter ${identity.label.toLowerCase()}.`;
  if (
    identity.inputType === "email" &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  ) {
    return "Enter a valid Atlassian account email.";
  }
  return null;
}

export function validateCloudWorkspace(
  input: ConnectionFormInput,
): string | null {
  if (input.product !== "cloud" || input.cloudWorkspace.trim()) return null;
  return "Enter Bitbucket Cloud workspace slug or ID.";
}

export function currentWatchFilter(query: string, state: string): JsonRecord {
  return { query: query.trim(), states: state === "all" ? [] : [state] };
}

export function taskLaunchPresets(): TaskLaunchPreset[] {
  return [
    {
      id: "review",
      label: "Review",
      hint: "Read the diff, flag issues",
      iconName: "eye",
      prompt: (pullRequest) =>
        `Review Bitbucket pull request ${pullRequest.url || pullRequest.key}. Inspect the changes, run relevant tests, and report concrete findings.`,
    },
    {
      id: "address-feedback",
      label: "Address feedback",
      hint: "Apply review comments",
      iconName: "message",
      prompt: (pullRequest) =>
        `Address the review feedback on Bitbucket pull request ${pullRequest.url || pullRequest.key}. Make the requested changes, verify them, and summarize what changed.`,
    },
    {
      id: "fix-ci",
      label: "Fix CI",
      hint: "Diagnose failing checks",
      iconName: "tool",
      prompt: (pullRequest) =>
        `Fix the failing CI checks on Bitbucket pull request ${pullRequest.url || pullRequest.key}. Reproduce the failures, implement the smallest correct fix, and run the relevant checks.`,
    },
  ];
}

export function taskDialogInitialValues(
  pullRequest: PullRequest,
  preset: TaskLaunchPreset,
  hostRepositoryId?: string,
  remoteRepository?: RepositoryInspection,
): JsonRecord {
  const values: JsonRecord = {
    title: `${preset.label}: ${pullRequest.title}`,
    description: preset.prompt(pullRequest),
  };
  if (hostRepositoryId) values.repositoryId = hostRepositoryId;
  else if (pullRequest.url) {
    values.remoteUrl = pullRequest.url;
    if (remoteRepository) values.remoteRepository = remoteRepository;
  }
  if (pullRequest.sourceBranch) {
    values.branch = pullRequest.sourceBranch;
    values.checkoutBranch = pullRequest.sourceBranch;
  }
  return values;
}

export function usePluginTaskCreation(hostRepositoryId?: string): boolean {
  return !hostRepositoryId?.trim();
}

export function taskLaunchBody(
  pullRequest: PullRequest,
  payload: JsonRecord,
  launchId: string,
): JsonRecord {
  const task: JsonRecord = {
    title: string(payload.title) ?? "",
    description: string(payload.description) ?? "",
    workflow_id: string(payload.workflow_id) ?? "",
    start_agent: payload.start_agent === true,
    plan_mode: payload.plan_mode === true,
  };
  const workflowStepID = string(payload.workflow_step_id);
  const agentProfileID = string(payload.agent_profile_id);
  const executorProfileID = string(payload.executor_profile_id);
  if (workflowStepID) task.workflow_step_id = workflowStepID;
  if (agentProfileID) task.agent_profile_id = agentProfileID;
  if (executorProfileID) task.executor_profile_id = executorProfileID;
  return { review_key: pullRequest.key, launch_id: launchId, task };
}

export function taskFromLaunchResult(value: unknown): JsonRecord {
  const result = record(value);
  const taskID = string(result.task_id);
  if (!taskID) throw new Error("Bitbucket task launch returned no task id.");
  return { id: taskID, bitbucketLinked: result.linked === true };
}

export function normalizeWatches(value: unknown): WatchSummary[] {
  return itemList(value, ["watches", "items", "values"]).flatMap(
    (entry): WatchSummary[] => {
      const watch = record(entry);
      const id = string(watch.id);
      const rawStatus = string(watch.status)?.toLowerCase();
      if (!id || (rawStatus !== "running" && rawStatus !== "paused")) return [];
      const summary: WatchSummary = { id, status: rawStatus };
      const lastPolled = string(watch.last_polled) ?? string(watch.lastPolled);
      if (lastPolled) summary.lastPolled = lastPolled;
      return [summary];
    },
  );
}

export function validateOAuthRegistration(
  input: ConnectionFormInput,
): string | null {
  if (input.authMethod !== "oauth") return null;
  const clientID = input.oauthClientId.trim();
  const clientSecret = input.oauthClientSecret.trim();
  if (input.oauthRegistrationConfigured && !clientID && !clientSecret)
    return null;
  if (!clientID) return "Enter OAuth client ID.";
  if (!clientSecret) return "Enter OAuth client secret.";
  if (!input.oauthCallbackUrl.trim())
    return "OAuth callback URL is unavailable.";
  return null;
}

export function connectionOAuthRegistration(value: unknown): OAuthRegistration {
  const source = record(value);
  return {
    configured: source.oauth_registration_configured === true,
  };
}

export function connectionActionBody(input: ConnectionFormInput): JsonRecord {
  const body: JsonRecord = {
    product: input.product,
    auth_method: input.authMethod,
  };
  const baseUrl = input.baseUrl.trim();
  const cloudWorkspace = input.cloudWorkspace.trim();
  const token = input.token.trim();
  const identity = input.identity.trim();
  const identityField = connectionIdentity(input.product, input.authMethod);
  if (baseUrl) body.base_url = baseUrl;
  if (input.product === "cloud" && cloudWorkspace)
    body.cloud_workspace = cloudWorkspace;
  if (input.authMethod !== "oauth" && token) body.token = token;
  if (identityField && identity) body[identityField.field] = identity;
  return body;
}

export function connectionSaveBody(input: ConnectionFormInput): JsonRecord {
  const body = connectionActionBody(input);
  if (input.authMethod !== "oauth") return body;
  const clientID = input.oauthClientId.trim();
  const clientSecret = input.oauthClientSecret.trim();
  if (clientID || clientSecret) {
    body.oauth_client_id = clientID;
    body.oauth_client_secret = clientSecret;
    body.oauth_redirect_url = input.oauthCallbackUrl.trim();
  }
  return body;
}

export function connectionState(value: unknown): ConnectionState {
  const candidate =
    string(record(value).state) ??
    string(record(value).status) ??
    "unconfigured";
  return [
    "unconfigured",
    "checking",
    "connected",
    "auth_required",
    "unavailable",
  ].includes(candidate)
    ? (candidate as ConnectionState)
    : "unavailable";
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const source = record(error);
  return (
    string(source.message) ??
    string(source.error) ??
    "Bitbucket request failed. Try again."
  );
}

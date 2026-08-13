import {
  linkPullRequestBody,
  normalizeRepositories,
  normalizeRepositoryInspection,
  pluginRepositoryInput,
} from "./view-models";
import {
  type PluginHost,
  type PluginIcon,
  type PluginRegistry,
} from "./host-contract";
import { record, text, icon } from "./ui-runtime";
import { ReviewDetailPanel } from "./dashboard-components";
import { action } from "./actions";
import {
  associationStore,
  refreshAssociationStore,
  refreshReviewStore,
  reviewStore,
} from "./review-store";
import { pluginTranslate } from "./i18n";

function isCredentialFreeHTTPSURL(rawURL: string): boolean {
  try {
    const parsed = new URL(rawURL);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

export function registerNativeIntegrations(
  registry: PluginRegistry,
  host: PluginHost,
  bitbucketIcon: PluginIcon,
) {
  const t = pluginTranslate(host);
  registry.registerRepositoryProvider({
    id: "bitbucket",
    get label() {
      return t("bitbucket");
    },
    icon: bitbucketIcon,
    async listRepositories({
      workspaceId: scopedWorkspaceId,
      query,
      cursor,
      limit,
      signal,
    }) {
      const response = await host.api.invokeAction<unknown>(
        action.repositoriesList,
        {
          workspaceId: scopedWorkspaceId,
          body: {
            query: query ?? "",
            cursor: cursor ?? "",
            limit: limit ?? 100,
          },
        },
        { signal },
      );
      if (signal.aborted) return { repositories: [] };
      return {
        repositories: normalizeRepositories(response),
        nextCursor: text(record(response).next_cursor) || undefined,
      };
    },
    async listBranches({ workspaceId: scopedWorkspaceId, repository, signal }) {
      const response = await host.api.invokeAction<Record<string, unknown>>(
        action.repositoriesBranches,
        {
          workspaceId: scopedWorkspaceId,
          body: { repository: pluginRepositoryInput(repository) },
        },
        { signal },
      );
      if (signal.aborted) return [];
      const branches = record(response).branches;
      return Array.isArray(branches)
        ? branches.flatMap((entry) => {
            const name = text(record(entry).name);
            return name ? [{ name }] : [];
          })
        : [];
    },
    async inspectURL({ workspaceId: scopedWorkspaceId, url, signal }) {
      // Keep the cheap frontend eligibility check aligned with the authenticated
      // backend action. Returning null lets Kandev try its built-in or another
      // registered provider instead of turning an unsupported SSH/HTTP URL into
      // a provider failure.
      if (!isCredentialFreeHTTPSURL(url)) return null;
      const response = await host.api.invokeAction<unknown>(
        action.repositoriesInspect,
        { workspaceId: scopedWorkspaceId, body: { url } },
        { signal },
      );
      return signal.aborted ? null : normalizeRepositoryInspection(response);
    },
    supportsDraft: false,
    async createChangeRequest({
      workspaceId,
      taskId,
      sessionId,
      repositoryId,
      title,
      body,
      baseBranch,
      signal,
    }) {
      const response = await host.api.invokeAction<Record<string, unknown>>(
        action.pullRequestsCreate,
        {
          workspaceId,
          taskId,
          sessionId,
          repositoryId,
          body: {
            title,
            description: body,
            ...(baseBranch ? { destination: baseBranch } : {}),
          },
        },
        { signal },
      );
      await Promise.all([
        refreshReviewStore(host, taskId, signal, workspaceId),
        refreshAssociationStore(host, workspaceId, signal),
      ]).catch(() => undefined);
      return {
        url: text(response.url),
        provider: "bitbucket",
        ...(typeof response.linked === "boolean"
          ? { linked: response.linked }
          : {}),
        ...(text(response.association_error)
          ? { associationError: text(response.association_error) }
          : {}),
      };
    },
  });
  registry.registerTaskAction({
    id: "link-pull-request",
    get label() {
      return t("linkPullRequestMenu");
    },
    icon: bitbucketIcon,
    placement: "link",
    async run(context) {
      host.openTaskLinkDialog({
        title: t("linkPullRequestTitle"),
        description: t("linkPullRequestDescription"),
        inputLabel: t("pullRequest"),
        placeholder: "workspace/repository#42",
        emptyError: t("linkPullRequestEmpty"),
        failureMessage: t("linkPullRequestFailure"),
        successMessage: t("linkPullRequestSuccess"),
        inputTestId: "bitbucket-review-reference",
        errorTestId: "bitbucket-review-reference-error",
        submitTestId: "bitbucket-review-reference-submit",
        async onSubmit(reference, signal) {
          const body = linkPullRequestBody(reference);
          if (!body) throw new Error(t("linkPullRequestEmpty"));
          await host.api.invokeAction(
            action.pullRequestsLink,
            {
              workspaceId: context.workspaceId,
              taskId: context.taskId,
              body,
            },
            { signal },
          );
          await Promise.all([
            refreshReviewStore(
              host,
              context.taskId,
              signal,
              context.workspaceId,
            ),
            refreshAssociationStore(host, context.workspaceId, signal),
          ]).catch(() => undefined);
        },
      });
    },
  });
  registry.registerReviewProvider({
    id: "bitbucket",
    get label() {
      return t("bitbucket");
    },
    icon: bitbucketIcon,
    get changeRequestNoun() {
      return t("pullRequestNoun");
    },
    order: 30,
    getSnapshot: (taskId) => reviewStore.get(taskId),
    subscribe: (taskId, listener) => reviewStore.subscribe(taskId, listener),
    async refresh(taskId, signal) {
      await refreshReviewStore(host, taskId, signal);
    },
    getAssociationSnapshot: (workspaceId) => associationStore.get(workspaceId),
    subscribeAssociations: (workspaceId, listener) =>
      associationStore.subscribe(workspaceId, listener),
    async refreshAssociations(workspaceId, signal) {
      await refreshAssociationStore(host, workspaceId, signal);
    },
    async unlink({
      workspaceId,
      taskId,
      reviewKey,
      connectionScope,
      repositoryId,
      changeRequestNumber,
      signal,
    }) {
      await host.api.invokeAction(
        action.pullRequestsUnlink,
        {
          workspaceId,
          taskId,
          body: {
            review_key: reviewKey,
            provider_scope: connectionScope,
            repository_id: repositoryId,
            number: changeRequestNumber,
          },
        },
        { signal },
      );
    },
    ReviewPanel: (props) =>
      host.jsx(ReviewDetailPanel, {
        host,
        workspaceId: text(props.workspaceId),
        taskId: text(props.taskId),
        reviewKey: text(props.reviewKey),
        connectionScope: text(props.connectionScope),
        repositoryId: text(props.repositoryId),
        changeRequestNumber: Number(props.changeRequestNumber),
        presentation:
          text(props.presentation) === "mobile" ? "mobile" : "desktop",
      }),
  });
}

import {
  linkPullRequestBody,
  normalizeRepositories,
  normalizeRepositoryInspection,
  pluginRepositoryInput,
} from "./view-models";
import { type PluginHost, type PluginRegistry } from "./host-contract";
import { record, text, icon } from "./ui-runtime";
import { ReviewDetailPanel } from "./dashboard-components";
import { action } from "./actions";
import {
  associationStore,
  refreshAssociationStore,
  refreshReviewStore,
  reviewStore,
} from "./review-store";

export function registerNativeIntegrations(
  registry: PluginRegistry,
  host: PluginHost,
) {
  registry.registerRepositoryProvider({
    id: "bitbucket",
    label: "Bitbucket",
    icon: "bitbucket",
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
    matchesURL(url) {
      return /(?:^git@bitbucket\.org:|^https?:\/\/[^/]*bitbucket[^/]*\/|\/scm\/)/i.test(
        url,
      );
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
    label: "Bitbucket Pull Request",
    icon: "bitbucket",
    placement: "link",
    async run(context) {
      host.openTaskLinkDialog({
        title: "Link Bitbucket pull request",
        description:
          "Use a Bitbucket pull request URL or canonical key for this task.",
        inputLabel: "Pull request",
        placeholder: "workspace/repository#42",
        emptyError: "Enter a Bitbucket pull request URL or key.",
        failureMessage: "Failed to link Bitbucket pull request.",
        successMessage: "Bitbucket pull request linked",
        inputTestId: "bitbucket-review-reference",
        errorTestId: "bitbucket-review-reference-error",
        submitTestId: "bitbucket-review-reference-submit",
        async onSubmit(reference, signal) {
          const body = linkPullRequestBody(reference);
          if (!body)
            throw new Error("Enter a Bitbucket pull request URL or key.");
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
    label: "Bitbucket",
    icon: "bitbucket",
    changeRequestNoun: "pull request",
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
    async unlink({ workspaceId, taskId, reviewKey, signal }) {
      await host.api.invokeAction(
        action.pullRequestsUnlink,
        { workspaceId, taskId, body: { review_key: reviewKey } },
        { signal },
      );
    },
    ReviewPanel: (props = {}) =>
      host.jsx(ReviewDetailPanel, {
        host,
        workspaceId: text(props.workspaceId) || undefined,
        taskId: text(props.taskId) || undefined,
        reviewKey: text(props.reviewKey),
        presentation:
          text(props.presentation) === "mobile" ? "mobile" : "desktop",
      }),
  });
}

package plugin

import (
	"context"
	"fmt"

	"kandev-plugin-bitbucket/internal/domain"
	"kandev-plugin-bitbucket/internal/watches"

	"github.com/kandev/kandev/pkg/pluginsdk"
)

func (w *Workflows) handlePullRequestAction(ctx context.Context, request *pluginsdk.PluginActionRequest) (*pluginsdk.PluginActionResponse, error) {
	switch request.ActionKey {
	case "pullrequests.search":
		var input searchPullRequestsInput
		if err := decodeAction(request.Body, &input); err != nil {
			return nil, err
		}
		provider, repository, err := w.repository(ctx, request.Context.WorkspaceID, input.Repository)
		if err != nil {
			return nil, err
		}
		if err := requireCapability(provider, domain.CapabilityPullRequests); err != nil {
			return nil, err
		}
		page, err := searchPullRequestPage(ctx, provider, domain.PullRequestQuery{
			Repository: repository,
			Text:       input.Query,
			State:      input.State,
			Limit:      boundedLimit(input.Limit),
			Cursor:     input.Cursor,
		})
		if err != nil {
			return nil, fmt.Errorf("search pull requests: %w", err)
		}
		return actionResponse(map[string]any{
			"pull_requests": pullRequestViews(page.PullRequests),
			"next_cursor":   page.NextCursor,
		})
	case "pullrequests.queue":
		var input queuePullRequestsInput
		if err := decodeAction(request.Body, &input); err != nil {
			return nil, err
		}
		unconfigured, err := w.workspaceIsUnconfigured(ctx, request.Context.WorkspaceID)
		if err != nil {
			return nil, err
		}
		if unconfigured {
			return actionResponse(map[string]any{"pull_requests": []any{}})
		}
		provider, err := w.provider(ctx, request.Context.WorkspaceID)
		if err != nil {
			return nil, err
		}
		if err := requireCapability(provider, domain.CapabilityPullRequests); err != nil {
			return nil, err
		}
		page, err := searchWorkspacePullRequests(
			ctx,
			provider,
			input.Query,
			input.State,
			boundedLimit(input.Limit),
			input.Cursor,
		)
		if err != nil {
			return nil, fmt.Errorf("list pull request queue: %w", err)
		}
		return actionResponse(map[string]any{
			"pull_requests": pullRequestViews(page.PullRequests),
			"next_cursor":   page.NextCursor,
		})
	case "pullrequests.associations":
		var input pullRequestAssociationsInput
		if err := decodeAction(request.Body, &input); err != nil {
			return nil, err
		}
		associations, err := w.pullRequestAssociations(ctx, request.Context.WorkspaceID, input.ReviewKeys)
		if err != nil {
			return nil, err
		}
		return actionResponse(map[string]any{"associations": associations})
	case "pullrequests.get", "pullrequests.inspect":
		var lookup pullRequestLookup
		if err := decodeAction(request.Body, &lookup); err != nil {
			return nil, err
		}
		if request.ActionKey == "pullrequests.get" && request.Context.TaskID != "" && lookup.ReviewKey == "" && lookup.Number == 0 {
			return w.taskPullRequests(ctx, request.Context.WorkspaceID, request.Context.TaskID)
		}
		if request.ActionKey == "pullrequests.get" && request.Context.TaskID != "" {
			key, associationErr := w.pullRequestLookupKey(ctx, request.Context.WorkspaceID, lookup)
			if associationErr != nil {
				return nil, associationErr
			}
			allowed, associationErr := w.taskHasPullRequestAssociation(ctx, request.Context.WorkspaceID, request.Context.TaskID, key)
			if associationErr != nil {
				return nil, associationErr
			}
			if !allowed {
				return nil, fmt.Errorf("Bitbucket pull request is not associated with the verified task")
			}
		}
		provider, pullRequest, err := w.pullRequestLookup(ctx, request.Context.WorkspaceID, lookup)
		if err != nil {
			return nil, err
		}
		if err := requireCapability(provider, domain.CapabilityPullRequests); err != nil {
			return nil, err
		}
		review, err := provider.GetReview(ctx, pullRequest.Repository, pullRequest.Number)
		if err != nil {
			return nil, fmt.Errorf("get pull request review: %w", err)
		}
		return actionResponse(reviewView(review))
	case "pullrequests.create":
		if request.Context.TaskID == "" {
			return nil, fmt.Errorf("verified task context is required")
		}
		var input taskCreatePullRequestInput
		if err := decodeAction(request.Body, &input); err != nil {
			return nil, err
		}
		provider, repository, source, destination, title, description, err := w.createPullRequestFromTask(ctx, request.Context, input)
		if err != nil {
			return nil, err
		}
		if err := requireCapability(provider, domain.CapabilityPullRequests); err != nil {
			return nil, err
		}
		pullRequest, err := provider.CreatePullRequest(ctx, domain.CreatePullRequestInput{Repository: repository, Title: title, Description: description, Source: source, Destination: destination, CloseSourceOnMerge: input.CloseSourceOnMerge})
		if err != nil {
			return nil, fmt.Errorf("create pull request: %w", err)
		}
		view := pullRequestView(pullRequest)
		link, associationErr := w.linkForPullRequest(ctx, request.Context.WorkspaceID, pullRequest)
		if associationErr == nil {
			_, associationErr = w.links.Link(ctx, request.Context.TaskID, link)
		}
		view["linked"] = associationErr == nil
		if associationErr != nil {
			view["association_error"] = "task association could not be saved"
		}
		return actionResponse(view)
	case "reviews.get":
		provider, pullRequest, err := w.pullRequest(ctx, request.Context.WorkspaceID, request.Body)
		if err != nil {
			return nil, err
		}
		if err := requireCapability(provider, domain.CapabilityReview); err != nil {
			return nil, err
		}
		review, err := provider.GetReview(ctx, pullRequest.Repository, pullRequest.Number)
		if err != nil {
			return nil, fmt.Errorf("get review: %w", err)
		}
		return actionResponse(reviewView(review))
	case "reviews.action", "pullrequests.update":
		var input reviewActionInput
		if err := decodeAction(request.Body, &input); err != nil {
			return nil, err
		}
		if input.Kind == "" {
			input.Kind = input.Operation
		}
		provider, pullRequest, err := w.pullRequestLookup(ctx, request.Context.WorkspaceID, input.pullRequestLookup)
		if err != nil {
			return nil, err
		}
		action := domain.ReviewAction{Kind: domain.Mutation(input.Kind), Comment: input.Comment, ParentCommentID: input.ParentCommentID, BuildKey: input.BuildKey}
		capability, err := action.Kind.Capability()
		if err != nil {
			return nil, err
		}
		if err := requireCapability(provider, capability); err != nil {
			return nil, err
		}
		updated, err := provider.ApplyReviewAction(ctx, pullRequest, action)
		if err != nil {
			return nil, fmt.Errorf("apply review action: %w", err)
		}
		return actionResponse(pullRequestView(updated))
	case "tasks.launch", "pullrequests.launch":
		var input launchTaskInput
		if err := decodeAction(request.Body, &input); err != nil {
			return nil, err
		}
		provider, pullRequest, err := w.pullRequestLookup(ctx, request.Context.WorkspaceID, input.pullRequestLookup)
		if err != nil {
			return nil, err
		}
		if err := requireCapability(provider, domain.CapabilityPullRequests); err != nil {
			return nil, err
		}
		if request.ActionKey == "tasks.launch" {
			return w.launchWorkspaceTask(ctx, request.Context.WorkspaceID, pullRequest, input)
		}
		if input.Task != nil {
			return nil, fmt.Errorf("native task settings are only supported by tasks.launch")
		}
		if request.ActionKey == "pullrequests.launch" && !input.Launch.StartAgent {
			input.Launch.StartAgent = true
		}
		if err := applyLaunchPreset(&input.Launch, input.Preset); err != nil {
			return nil, err
		}
		taskID, err := w.tasks.Create(ctx, watches.Creation{WorkspaceID: request.Context.WorkspaceID, Watch: watches.Watch{ID: "manual", Launch: input.Launch}, PullRequest: watchPullRequest(pullRequest), ReservationToken: "manual:" + pullRequest.Key()})
		if err != nil {
			return nil, err
		}
		return actionResponse(map[string]any{"task_id": taskID})
	case "links.link", "pullrequests.link":
		if request.Context.TaskID == "" {
			return nil, fmt.Errorf("verified task context is required")
		}
		_, pullRequest, err := w.pullRequest(ctx, request.Context.WorkspaceID, request.Body)
		if err != nil {
			return nil, err
		}
		link, err := w.linkForPullRequest(ctx, request.Context.WorkspaceID, pullRequest)
		if err != nil {
			return nil, err
		}
		links, err := w.links.Link(ctx, request.Context.TaskID, link)
		if err != nil {
			return nil, err
		}
		return actionResponse(links)
	case "links.unlink", "pullrequests.unlink":
		if request.Context.TaskID == "" {
			return nil, fmt.Errorf("verified task context is required")
		}
		var input unlinkInput
		if err := decodeAction(request.Body, &input); err != nil {
			return nil, err
		}
		key := input.Key
		if key == "" {
			key = input.ReviewKey
		}
		links, err := w.links.Unlink(ctx, request.Context.TaskID, key)
		if err != nil {
			return nil, err
		}
		if err := w.watches.DetachTaskLink(
			ctx,
			request.Context.WorkspaceID,
			request.Context.TaskID,
			key,
		); err != nil {
			return nil, err
		}
		return actionResponse(links)
	default:
		return nil, fmt.Errorf("unsupported Bitbucket action %q", request.ActionKey)
	}
}

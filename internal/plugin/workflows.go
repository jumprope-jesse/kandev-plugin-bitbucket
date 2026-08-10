package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"kandev-plugin-bitbucket/internal/domain"
	"kandev-plugin-bitbucket/internal/watches"

	"github.com/kandev/kandev/pkg/pluginsdk"
)

const referenceSource = "bitbucket"

// Workflows implements every authenticated plugin action plus composer and
// credential RPCs. Its inputs are host-verified action context and adapter
// DTOs; it never receives a repository URL with embedded credentials.
type Workflows struct {
	host        pluginsdk.Host
	resolver    ProviderResolver
	tasks       *TaskGateway
	links       *LinkStore
	watches     *watches.Service
	credentials *CredentialResolver
}

func NewWorkflows(host pluginsdk.Host, resolver ProviderResolver) (*Workflows, error) {
	if host == nil || resolver == nil {
		return nil, fmt.Errorf("host and provider resolver are required")
	}
	state, err := NewWatchStateRepository(host)
	if err != nil {
		return nil, err
	}
	taskGateway, err := NewTaskGateway(host)
	if err != nil {
		return nil, err
	}
	links, err := NewLinkStore(host)
	if err != nil {
		return nil, err
	}
	events, err := NewEventSink(host)
	if err != nil {
		return nil, err
	}
	watchProvider, err := NewWatchProvider(resolver)
	if err != nil {
		return nil, err
	}
	watchService, err := watches.NewService(watches.Options{Repository: state, Provider: watchProvider, Tasks: taskGateway, Events: events})
	if err != nil {
		return nil, err
	}
	credentials, err := NewCredentialResolver(providerCredentialSource{resolver: resolver})
	if err != nil {
		return nil, err
	}
	return &Workflows{host: host, resolver: resolver, tasks: taskGateway, links: links, watches: watchService, credentials: credentials}, nil
}

func (w *Workflows) HandleAction(ctx context.Context, request *pluginsdk.PluginActionRequest) (*pluginsdk.PluginActionResponse, error) {
	if request == nil {
		return nil, fmt.Errorf("action request is required")
	}
	switch request.ActionKey {
	case "connection.get", "health.get":
		if connections, ok := w.resolver.(ConnectionSettingsStore); ok {
			settings, found, loadErr := connections.Load(ctx, request.Context.WorkspaceID)
			if loadErr != nil {
				return nil, fmt.Errorf("load Bitbucket connection: %w", loadErr)
			}
			if !found {
				return actionResponse(map[string]any{"state": "unconfigured", "healthy": false})
			}
			oauthConfigured := settings.AuthMethod == "oauth" && settings.OAuthClientID != ""
			if inspector, ok := w.resolver.(interface {
				oauthRegistrationConfigured(context.Context, string) (bool, error)
			}); ok {
				oauthConfigured, _ = inspector.oauthRegistrationConfigured(ctx, request.Context.WorkspaceID)
			}
			provider, providerErr := w.provider(ctx, request.Context.WorkspaceID)
			if providerErr != nil {
				return actionResponse(connectionResponse(settings, false, providerErr, oauthConfigured))
			}
			healthErr := provider.Health(ctx)
			return actionResponse(connectionResponse(settings, healthErr == nil, healthErr, oauthConfigured))
		}
		provider, err := w.provider(ctx, request.Context.WorkspaceID)
		if err != nil {
			return nil, err
		}
		err = provider.Health(ctx)
		return actionResponse(map[string]any{"healthy": err == nil, "capabilities": provider.Capabilities(), "error": safeError(err)})
	case "connection.disconnect":
		connections, ok := w.resolver.(interface {
			Disconnect(context.Context, string) error
		})
		if !ok {
			return nil, fmt.Errorf("Bitbucket connection updates are unavailable")
		}
		if err := connections.Disconnect(ctx, request.Context.WorkspaceID); err != nil {
			return nil, err
		}
		return actionResponse(map[string]any{"state": "unconfigured", "healthy": false})
	case "connection.save":
		var input connectionSaveInput
		if err := decodeAction(request.Body, &input); err != nil {
			return nil, err
		}
		connections, ok := w.resolver.(ConnectionSettingsStore)
		if !ok {
			return nil, fmt.Errorf("Bitbucket connection updates are unavailable")
		}
		settings, err := connections.Save(ctx, request.Context.WorkspaceID, input.ConnectionInput)
		if err != nil {
			return nil, fmt.Errorf("save Bitbucket connection failed")
		}
		if !input.Probe {
			return actionResponse(connectionResponse(settings, false, nil))
		}
		provider, err := w.provider(ctx, request.Context.WorkspaceID)
		if err != nil {
			return actionResponse(connectionResponse(settings, false, err))
		}
		err = provider.Health(ctx)
		return actionResponse(connectionResponse(settings, err == nil, err))
	case "oauth.start":
		coordinator, ok := w.resolver.(interface {
			StartOAuth(context.Context, string) (*url.URL, error)
		})
		if !ok {
			return nil, fmt.Errorf("Bitbucket OAuth is not configured")
		}
		authorizationURL, err := coordinator.StartOAuth(ctx, request.Context.WorkspaceID)
		if err != nil {
			return nil, err
		}
		return actionResponse(map[string]any{"url": authorizationURL.String()})
	case "repositories.list":
		var input listRepositoriesInput
		if err := decodeAction(request.Body, &input); err != nil {
			return nil, err
		}
		unconfigured, err := w.workspaceIsUnconfigured(ctx, request.Context.WorkspaceID)
		if err != nil {
			return nil, err
		}
		if unconfigured {
			return actionResponse(map[string]any{"repositories": []any{}})
		}
		provider, err := w.provider(ctx, request.Context.WorkspaceID)
		if err != nil {
			return nil, err
		}
		repositories, err := provider.ListRepositories(ctx, input.Query, boundedLimit(input.Limit))
		if err != nil {
			return nil, fmt.Errorf("list repositories: %w", err)
		}
		return actionResponse(map[string]any{"repositories": repositoryViews(repositories)})
	case "branches.list", "repositories.branches":
		var input repositoryInput
		if err := decodeAction(request.Body, &input); err != nil {
			return nil, err
		}
		provider, repository, err := w.repository(ctx, request.Context.WorkspaceID, input.Repository)
		if err != nil {
			return nil, err
		}
		if err := requireCapability(provider, domain.CapabilityBranches); err != nil {
			return nil, err
		}
		branches, err := provider.ListBranches(ctx, repository)
		if err != nil {
			return nil, fmt.Errorf("list branches: %w", err)
		}
		return actionResponse(map[string]any{"branches": branchViews(branches)})
	case "repositories.inspect":
		var input repositoryInspectInput
		if err := decodeAction(request.Body, &input); err != nil {
			return nil, err
		}
		parsed, err := url.Parse(input.URL)
		if err != nil || parsed.User != nil || parsed.Host == "" || parsed.Scheme != "https" {
			return nil, fmt.Errorf("repository URL must be a credential-free HTTPS URL")
		}
		provider, err := w.provider(ctx, request.Context.WorkspaceID)
		if err != nil {
			return nil, err
		}
		repository, err := provider.InspectRepositoryURL(input.URL)
		if err == nil {
			return actionResponse(repositoryViews([]domain.Repository{repository})[0])
		}
		locator, inspectErr := provider.InspectPullRequestURL(input.URL)
		if inspectErr != nil {
			return nil, fmt.Errorf("Bitbucket repository is unavailable")
		}
		pullRequest, getErr := provider.GetPullRequest(ctx, locator.Repository, locator.Number)
		if getErr != nil {
			return nil, fmt.Errorf("Bitbucket pull request is unavailable")
		}
		repositoryView := repositoryViews([]domain.Repository{pullRequest.Repository})[0]
		repositoryView["base_branch"] = pullRequest.Destination.Name
		repositoryView["head_branch"] = pullRequest.Source.Name
		return actionResponse(map[string]any{
			"repository": repositoryView, "pull_request": pullRequestView(pullRequest),
			"base_branch": pullRequest.Destination.Name, "head_branch": pullRequest.Source.Name,
		})
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
		pullRequests, err := provider.SearchPullRequests(ctx, domain.PullRequestQuery{Repository: repository, Text: input.Query, State: input.State, Limit: boundedLimit(input.Limit)})
		if err != nil {
			return nil, fmt.Errorf("search pull requests: %w", err)
		}
		return actionResponse(map[string]any{"pull_requests": pullRequestViews(pullRequests)})
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
		pullRequests, err := searchWorkspacePullRequests(ctx, provider, input.Query, input.State, boundedLimit(input.Limit))
		if err != nil {
			return nil, fmt.Errorf("list pull request queue: %w", err)
		}
		return actionResponse(map[string]any{"pull_requests": pullRequestViews(pullRequests)})
	case "pullrequests.associations":
		associations, err := w.pullRequestAssociations(ctx, request.Context.WorkspaceID)
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
			return actionResponse(pullRequestView(pullRequest))
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
	case "watches.list", "watches.get":
		result, err := w.watches.List(ctx, request.Context.WorkspaceID)
		if err != nil {
			return nil, err
		}
		return actionResponse(map[string]any{"watches": result})
	case "watches.create":
		var watch watches.Watch
		if err := decodeAction(request.Body, &watch); err != nil {
			return nil, err
		}
		watch.WorkspaceID = request.Context.WorkspaceID
		result, err := w.watches.Create(ctx, watch)
		if err != nil {
			return nil, err
		}
		return actionResponse(result)
	case "watches.update":
		var input watchUpdateInput
		if err := decodeAction(request.Body, &input); err != nil {
			return nil, err
		}
		watchID := input.WatchID
		if watchID == "" {
			watchID = "default"
		}
		watch, err := w.watches.Get(ctx, request.Context.WorkspaceID, watchID)
		if err == watches.ErrWatchNotFound {
			if !input.Enabled {
				return actionResponse(map[string]any{"watches": []watches.Watch{}})
			}
			watch, err = w.watches.Create(ctx, watches.Watch{ID: watchID, WorkspaceID: request.Context.WorkspaceID, Filter: input.Filter, Launch: input.Launch})
		}
		if err != nil {
			return nil, err
		}
		if hasFilter(input.Filter) {
			watch, err = w.watches.SetFilter(ctx, request.Context.WorkspaceID, watchID, input.Filter)
			if err != nil {
				return nil, err
			}
		}
		if input.Enabled {
			watch, err = w.watches.Resume(ctx, request.Context.WorkspaceID, watchID)
		} else {
			watch, err = w.watches.Pause(ctx, request.Context.WorkspaceID, watchID)
		}
		if err != nil {
			return nil, err
		}
		return actionResponse(map[string]any{"watch": watch})
	case "watches.filter":
		var input watchFilterInput
		if err := decodeAction(request.Body, &input); err != nil {
			return nil, err
		}
		result, err := w.watches.SetFilter(ctx, request.Context.WorkspaceID, input.WatchID, input.Filter)
		if err != nil {
			return nil, err
		}
		return actionResponse(result)
	case "watches.preset":
		var input watchPresetInput
		if err := decodeAction(request.Body, &input); err != nil {
			return nil, err
		}
		result, err := w.watches.SavePreset(ctx, request.Context.WorkspaceID, input.WatchID, input.Preset)
		if err != nil {
			return nil, err
		}
		return actionResponse(result)
	case "watches.run":
		var input watchIDInput
		if err := decodeAction(request.Body, &input); err != nil {
			return nil, err
		}
		result, err := w.watches.Run(ctx, request.Context.WorkspaceID, input.WatchID)
		if err != nil {
			return nil, err
		}
		return actionResponse(result)
	case "watches.pause", "watches.resume":
		var input watchIDInput
		if err := decodeAction(request.Body, &input); err != nil {
			return nil, err
		}
		var result watches.Watch
		var err error
		if request.ActionKey == "watches.pause" {
			result, err = w.watches.Pause(ctx, request.Context.WorkspaceID, input.WatchID)
		} else {
			result, err = w.watches.Resume(ctx, request.Context.WorkspaceID, input.WatchID)
		}
		if err != nil {
			return nil, err
		}
		return actionResponse(result)
	case "watches.preview_reset", "watches.preview_delete":
		var input watchIDInput
		if err := decodeAction(request.Body, &input); err != nil {
			return nil, err
		}
		if request.ActionKey == "watches.preview_reset" {
			result, err := w.watches.PreviewReset(ctx, request.Context.WorkspaceID, input.WatchID)
			if err != nil {
				return nil, err
			}
			return actionResponse(result)
		}
		result, err := w.watches.PreviewDelete(ctx, request.Context.WorkspaceID, input.WatchID)
		if err != nil {
			return nil, err
		}
		return actionResponse(result)
	case "watches.reset", "watches.delete":
		var input watchIDInput
		if err := decodeAction(request.Body, &input); err != nil {
			return nil, err
		}
		if request.ActionKey == "watches.reset" {
			result, err := w.watches.Reset(ctx, request.Context.WorkspaceID, input.WatchID)
			if err != nil {
				return nil, err
			}
			return actionResponse(result)
		}
		result, err := w.watches.Delete(ctx, request.Context.WorkspaceID, input.WatchID)
		if err != nil {
			return nil, err
		}
		return actionResponse(result)
	default:
		return nil, fmt.Errorf("unsupported Bitbucket action %q", request.ActionKey)
	}
}

// HandleWebhook dispatches only the declared OAuth callback and keeps all
// callback parameters inside the PKCE coordinator rather than action bodies.
func (w *Workflows) HandleWebhook(ctx context.Context, request *pluginsdk.WebhookRequest) (*pluginsdk.WebhookResponse, error) {
	if request == nil || request.WebhookKey != "oauth-callback" || request.Method != "GET" {
		return &pluginsdk.WebhookResponse{Status: 404}, nil
	}
	callback, ok := w.resolver.(interface {
		HandleOAuthCallback(context.Context, string, string) (*pluginsdk.WebhookResponse, error)
	})
	if !ok {
		return &pluginsdk.WebhookResponse{Status: 404}, nil
	}
	query, err := url.ParseQuery(request.Query)
	if err != nil {
		return &pluginsdk.WebhookResponse{Status: 400}, nil
	}
	response, err := callback.HandleOAuthCallback(ctx, query.Get("state"), query.Get("code"))
	if err != nil {
		return &pluginsdk.WebhookResponse{Status: 400, Headers: map[string]string{"Content-Type": "text/plain; charset=utf-8"}, Body: []byte("OAuth callback could not be completed.")}, nil
	}
	return response, nil
}

func (w *Workflows) SearchEntityReferences(ctx context.Context, request *pluginsdk.SearchEntityReferencesRequest) (*pluginsdk.SearchEntityReferencesResponse, error) {
	if request == nil || request.Source != referenceSource || request.WorkspaceID == "" {
		return nil, fmt.Errorf("invalid Bitbucket reference search")
	}
	provider, err := w.provider(ctx, request.WorkspaceID)
	if err != nil {
		return nil, err
	}
	if err := requireCapability(provider, domain.CapabilityPullRequests); err != nil {
		return nil, err
	}
	repositories, err := provider.ListRepositories(ctx, "", boundedLimit(int(request.Limit)))
	if err != nil {
		return nil, fmt.Errorf("list reference repositories: %w", err)
	}
	response := &pluginsdk.SearchEntityReferencesResponse{}
	limit := boundedLimit(int(request.Limit))
	for _, repository := range repositories {
		pullRequests, err := provider.SearchPullRequests(ctx, domain.PullRequestQuery{Repository: repository, Text: request.Query, Limit: boundedLimit(int(request.Limit))})
		if err != nil {
			return nil, fmt.Errorf("search Bitbucket references: %w", err)
		}
		for _, pullRequest := range pullRequests {
			response.Candidates = append(response.Candidates, pluginsdk.EntityReferenceCandidate{ProviderLocalID: pullRequest.Key(), Title: pullRequest.Title, URL: pullRequest.URL, Attributes: map[string]any{"key": pullRequest.Key(), "repository": map[string]any{"namespace": pullRequest.Repository.Namespace, "slug": pullRequest.Repository.Slug}, "number": pullRequest.Number}})
			if len(response.Candidates) >= limit {
				return response, nil
			}
		}
	}
	return response, nil
}

func (w *Workflows) AuthorizeEntityReference(ctx context.Context, request *pluginsdk.AuthorizeEntityReferenceRequest) (*pluginsdk.AuthorizeEntityReferenceResponse, error) {
	if request == nil || request.Source != referenceSource || request.WorkspaceID == "" || (request.Purpose != "search" && request.Purpose != "submission") {
		return &pluginsdk.AuthorizeEntityReferenceResponse{Allowed: false, Reason: "invalid Bitbucket reference"}, nil
	}
	repository, number, key, ok := referenceIdentity(request.Reference)
	if !ok {
		return &pluginsdk.AuthorizeEntityReferenceResponse{Allowed: false, Reason: "incomplete Bitbucket reference"}, nil
	}
	provider, err := w.provider(ctx, request.WorkspaceID)
	if err != nil || requireCapability(provider, domain.CapabilityPullRequests) != nil {
		return &pluginsdk.AuthorizeEntityReferenceResponse{Allowed: false, Reason: "Bitbucket connection unavailable"}, nil
	}
	pullRequest, err := provider.GetPullRequest(ctx, repository, number)
	if err != nil || pullRequest.Key() != key {
		return &pluginsdk.AuthorizeEntityReferenceResponse{Allowed: false, Reason: "Bitbucket pull request is unavailable"}, nil
	}
	return &pluginsdk.AuthorizeEntityReferenceResponse{Allowed: true}, nil
}

func (w *Workflows) ResolveGitCredential(ctx context.Context, request *pluginsdk.ResolveGitCredentialRequest) (*pluginsdk.ResolveGitCredentialResponse, error) {
	return w.credentials.ResolveGitCredential(ctx, request)
}

func (w *Workflows) GetGitCredentialBinding(ctx context.Context, request *pluginsdk.GitCredentialBindingRequest) (*pluginsdk.GitCredentialBindingResponse, error) {
	return w.credentials.GetGitCredentialBinding(ctx, request)
}

func (w *Workflows) provider(ctx context.Context, workspaceID string) (domain.Provider, error) {
	if workspaceID == "" {
		return nil, fmt.Errorf("verified workspace context is required")
	}
	provider, err := w.resolver.Provider(ctx, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("resolve Bitbucket connection: %w", err)
	}
	return provider, nil
}

func (w *Workflows) workspaceIsUnconfigured(ctx context.Context, workspaceID string) (bool, error) {
	if workspaceID == "" {
		return false, fmt.Errorf("verified workspace context is required")
	}
	connections, ok := w.resolver.(ConnectionSettingsStore)
	if !ok {
		return false, nil
	}
	_, found, err := connections.Load(ctx, workspaceID)
	if err != nil {
		return false, fmt.Errorf("load Bitbucket connection: %w", err)
	}
	return !found, nil
}

func (w *Workflows) repository(ctx context.Context, workspaceID string, remote watches.RemoteRepository) (domain.Provider, domain.Repository, error) {
	provider, err := w.provider(ctx, workspaceID)
	if err != nil {
		return nil, domain.Repository{}, err
	}
	repository, err := domainRepository(remote)
	if err != nil {
		return nil, domain.Repository{}, err
	}
	return provider, repository, nil
}

func (w *Workflows) pullRequest(ctx context.Context, workspaceID string, body []byte) (domain.Provider, domain.PullRequest, error) {
	var input pullRequestLookup
	if err := decodeAction(body, &input); err != nil {
		return nil, domain.PullRequest{}, err
	}
	return w.pullRequestLookup(ctx, workspaceID, input)
}

func (w *Workflows) pullRequestLookup(ctx context.Context, workspaceID string, input pullRequestLookup) (domain.Provider, domain.PullRequest, error) {
	if input.ReviewKey != "" {
		provider, err := w.provider(ctx, workspaceID)
		if err != nil {
			return nil, domain.PullRequest{}, err
		}
		repository, number, key, ok := pullRequestIdentity(provider, input.ReviewKey)
		if !ok {
			return nil, domain.PullRequest{}, fmt.Errorf("invalid Bitbucket pull request key")
		}
		pullRequest, err := provider.GetPullRequest(ctx, repository, number)
		if err != nil || pullRequest.Key() != key {
			return nil, domain.PullRequest{}, fmt.Errorf("Bitbucket pull request is unavailable")
		}
		return provider, pullRequest, nil
	}
	provider, repository, err := w.repository(ctx, workspaceID, input.Repository)
	if err != nil {
		return nil, domain.PullRequest{}, err
	}
	if input.Number <= 0 {
		return nil, domain.PullRequest{}, fmt.Errorf("pull request number is required")
	}
	pullRequest, err := provider.GetPullRequest(ctx, repository, input.Number)
	if err != nil {
		return nil, domain.PullRequest{}, fmt.Errorf("get pull request: %w", err)
	}
	return provider, pullRequest, nil
}

func pullRequestIdentity(provider domain.Provider, value string) (domain.Repository, int, string, bool) {
	if repository, number, ok := parsePullRequestKey(value); ok {
		return repository, number, value, true
	}
	locator, err := provider.InspectPullRequestURL(value)
	if err != nil || locator.Repository.Namespace == "" || locator.Repository.Slug == "" || locator.Number <= 0 {
		return domain.Repository{}, 0, "", false
	}
	return locator.Repository, locator.Number, fmt.Sprintf("%s/%s#%d", locator.Repository.Namespace, locator.Repository.Slug, locator.Number), true
}

func (w *Workflows) launchWorkspaceTask(ctx context.Context, workspaceID string, pullRequest domain.PullRequest, input launchTaskInput) (*pluginsdk.PluginActionResponse, error) {
	taskInput, prompt, err := nativeTaskOptions(input)
	if err != nil {
		return nil, err
	}
	reservation, err := taskLaunchReservation(pullRequest.Key(), input.LaunchID)
	if err != nil {
		return nil, err
	}
	taskID, found, err := w.tasks.FindByReservation(ctx, workspaceID, reservation)
	if err != nil {
		return nil, err
	}
	if !found {
		taskID, err = w.createWorkspaceTask(ctx, workspaceID, pullRequest, taskInput, prompt, reservation)
		if err != nil {
			return nil, err
		}
	}
	response := map[string]any{"task_id": taskID}
	link, associationErr := w.linkForPullRequest(ctx, workspaceID, pullRequest)
	if associationErr == nil {
		_, associationErr = w.links.Link(ctx, taskID, link)
	}
	response["linked"] = associationErr == nil
	if associationErr != nil {
		response["association_error"] = "task association could not be saved"
	}
	return actionResponse(response)
}

func taskLaunchReservation(pullRequestKey, launchID string) (string, error) {
	reservation := "manual:" + pullRequestKey
	launchID = strings.TrimSpace(launchID)
	if launchID == "" {
		return reservation, nil
	}
	if len(launchID) > 128 {
		return "", fmt.Errorf("launch_id is invalid")
	}
	for _, char := range launchID {
		if (char < 'a' || char > 'z') && (char < 'A' || char > 'Z') && (char < '0' || char > '9') && char != '-' && char != '_' {
			return "", fmt.Errorf("launch_id is invalid")
		}
	}
	return reservation + ":" + launchID, nil
}

func nativeTaskOptions(input launchTaskInput) (nativeTaskInput, string, error) {
	if input.Task != nil {
		if input.Preset != "" || input.Launch != (watches.Launch{}) {
			return nativeTaskInput{}, "", fmt.Errorf("native and legacy task settings cannot be combined")
		}
		return *input.Task, "", nil
	}
	if err := applyLaunchPreset(&input.Launch, input.Preset); err != nil {
		return nativeTaskInput{}, "", err
	}
	return nativeTaskInput{
		WorkflowID:        input.Launch.WorkflowID,
		WorkflowStepID:    input.Launch.WorkflowStepID,
		AgentProfileID:    input.Launch.AgentProfileID,
		ExecutorProfileID: input.Launch.ExecutorProfileID,
		StartAgent:        input.Launch.StartAgent,
	}, input.Launch.Prompt, nil
}

func (w *Workflows) createWorkspaceTask(ctx context.Context, workspaceID string, pullRequest domain.PullRequest, task nativeTaskInput, prompt, reservation string) (string, error) {
	remote, err := remoteRepository(watchPullRequest(pullRequest))
	if err != nil {
		return "", err
	}
	title := strings.TrimSpace(task.Title)
	if title == "" {
		title = strings.TrimSpace(pullRequest.Title)
		if title == "" {
			title = fmt.Sprintf("Bitbucket pull request #%d", pullRequest.Number)
		} else {
			title = fmt.Sprintf("Bitbucket PR #%d: %s", pullRequest.Number, title)
		}
	}
	description := strings.TrimSpace(task.Description)
	if description == "" {
		description = pullRequest.URL
	}
	launch := &pluginsdk.PluginTaskLaunchOptions{
		AgentProfileID:    stringPointer(strings.TrimSpace(task.AgentProfileID)),
		ExecutorProfileID: stringPointer(strings.TrimSpace(task.ExecutorProfileID)),
		Prompt:            stringPointer(strings.TrimSpace(prompt)),
	}
	if task.PlanMode {
		launch.PlanMode = stringPointer("on")
	}
	if launch.AgentProfileID == nil && launch.ExecutorProfileID == nil && launch.Prompt == nil && launch.PlanMode == nil {
		launch = nil
	}
	created, err := w.host.Tasks().Create(ctx, pluginsdk.CreateTaskInput{
		WorkspaceID:    workspaceID,
		WorkflowID:     strings.TrimSpace(task.WorkflowID),
		WorkflowStepID: stringPointer(strings.TrimSpace(task.WorkflowStepID)),
		Title:          title,
		Description:    description,
		StartAgent:     task.StartAgent,
		Repositories: []pluginsdk.PluginTaskRepository{{
			Remote:         remote,
			BaseBranch:     stringPointer(pullRequest.Destination.Name),
			CheckoutBranch: stringPointer(pullRequest.Source.Name),
		}},
		Launch: launch,
		Metadata: map[string]any{
			"pull_request_key": pullRequest.Key(),
			"reservation":      reservation,
		},
	})
	if err != nil {
		return "", fmt.Errorf("create Bitbucket task: %w", err)
	}
	if created == nil || created.ID == "" {
		return "", fmt.Errorf("create Bitbucket task returned no task id")
	}
	return created.ID, nil
}

func (w *Workflows) taskPullRequests(ctx context.Context, workspaceID, taskID string) (*pluginsdk.PluginActionResponse, error) {
	links, err := w.links.List(ctx, taskID)
	if err != nil {
		return nil, err
	}
	watchAssociations, err := w.watchOwnedAssociations(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	provider, err := w.provider(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	_ = w.autoLinkTaskPullRequests(ctx, workspaceID, taskID, provider)
	if refreshedLinks, refreshErr := w.links.List(ctx, taskID); refreshErr == nil {
		links = refreshedLinks
	}
	pullRequests := make([]domain.PullRequest, 0, len(links)+len(watchAssociations[taskID]))
	unavailable := make([]map[string]any, 0)
	seen := make(map[string]struct{}, len(links)+len(watchAssociations[taskID]))
	for _, link := range links {
		available, err := w.linkMatchesConnection(ctx, workspaceID, link)
		if err != nil {
			return nil, err
		}
		if !available {
			if _, watchOwned := watchAssociations[taskID][link.Key]; !watchOwned {
				unavailable = append(unavailable, map[string]any{"key": link.Key, "reason": "connection_changed"})
			}
			continue
		}
		repository, number, ok := parsePullRequestKey(link.Key)
		if !ok {
			continue
		}
		seen[link.Key] = struct{}{}
		pullRequest, getErr := provider.GetPullRequest(ctx, repository, number)
		if getErr == nil && pullRequest.Key() == link.Key {
			pullRequests = append(pullRequests, pullRequest)
		}
	}
	watchKeys := sortedAssociationKeys(watchAssociations[taskID])
	for _, key := range watchKeys {
		if _, found := seen[key]; found {
			continue
		}
		repository, number, ok := parsePullRequestKey(key)
		if !ok {
			continue
		}
		pullRequest, getErr := provider.GetPullRequest(ctx, repository, number)
		if getErr == nil && pullRequest.Key() == key {
			pullRequests = append(pullRequests, pullRequest)
		}
	}
	response := map[string]any{"pull_requests": pullRequestViews(pullRequests)}
	if len(unavailable) > 0 {
		response["unavailable_pull_requests"] = unavailable
	}
	return actionResponse(response)
}

func (w *Workflows) pullRequestAssociations(ctx context.Context, workspaceID string) ([]map[string]any, error) {
	if workspaceID == "" {
		return nil, fmt.Errorf("verified workspace context is required")
	}
	watchAssociations, err := w.watchOwnedAssociations(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	associations := make([]map[string]any, 0)
	page := pluginsdk.Page{Limit: 100}
	for {
		tasks, info, err := w.host.Tasks().List(ctx, pluginsdk.TaskFilter{WorkspaceIDs: []string{workspaceID}}, page)
		if err != nil {
			return nil, fmt.Errorf("list workspace tasks: %w", err)
		}
		for _, task := range tasks {
			links, err := w.links.List(ctx, task.ID)
			if err != nil {
				return nil, fmt.Errorf("list task pull request links: %w", err)
			}
			keys := make(map[string]struct{}, len(links)+len(watchAssociations[task.ID]))
			for _, link := range links {
				keys[link.Key] = struct{}{}
			}
			for key := range watchAssociations[task.ID] {
				keys[key] = struct{}{}
			}
			for _, key := range sortedAssociationKeys(keys) {
				associations = append(associations, map[string]any{
					"review_key": key,
					"task_id":    task.ID,
					"task_title": task.Title,
				})
			}
		}
		if info == nil || !info.HasMore || info.NextCursor == "" {
			return associations, nil
		}
		page.Cursor = info.NextCursor
	}
}

func (w *Workflows) watchOwnedAssociations(ctx context.Context, workspaceID string) (map[string]map[string]struct{}, error) {
	configured, err := w.watches.List(ctx, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("list watch-owned pull request links: %w", err)
	}
	associations := make(map[string]map[string]struct{})
	for _, watch := range configured {
		for mapKey, link := range watch.Links {
			if !link.Owned || link.TaskID == "" {
				continue
			}
			key := link.PullRequestKey
			if key == "" {
				key = mapKey
			}
			if _, _, ok := parsePullRequestKey(key); !ok {
				continue
			}
			if associations[link.TaskID] == nil {
				associations[link.TaskID] = make(map[string]struct{})
			}
			associations[link.TaskID][key] = struct{}{}
		}
	}
	return associations, nil
}

func sortedAssociationKeys(keys map[string]struct{}) []string {
	result := make([]string, 0, len(keys))
	for key := range keys {
		result = append(result, key)
	}
	sort.Strings(result)
	return result
}

func (w *Workflows) taskHasPullRequestAssociation(ctx context.Context, workspaceID, taskID, key string) (bool, error) {
	links, err := w.links.List(ctx, taskID)
	if err != nil {
		return false, err
	}
	for _, link := range links {
		if link.Key != key {
			continue
		}
		matches, err := w.linkMatchesConnection(ctx, workspaceID, link)
		if err != nil {
			return false, err
		}
		if matches {
			return true, nil
		}
	}
	watchAssociations, err := w.watchOwnedAssociations(ctx, workspaceID)
	if err != nil {
		return false, err
	}
	_, found := watchAssociations[taskID][key]
	return found, nil
}

func (w *Workflows) pullRequestLookupKey(ctx context.Context, workspaceID string, lookup pullRequestLookup) (string, error) {
	if lookup.ReviewKey != "" {
		provider, err := w.provider(ctx, workspaceID)
		if err != nil {
			return "", err
		}
		_, _, key, ok := pullRequestIdentity(provider, lookup.ReviewKey)
		if !ok {
			return "", fmt.Errorf("invalid Bitbucket pull request key")
		}
		return key, nil
	}
	repository, err := domainRepository(lookup.Repository)
	if err != nil || lookup.Number <= 0 {
		return "", fmt.Errorf("invalid Bitbucket pull request key")
	}
	return fmt.Sprintf("%s/%s#%d", repository.Namespace, repository.Slug, lookup.Number), nil
}

func (w *Workflows) autoLinkTaskPullRequests(ctx context.Context, workspaceID, taskID string, provider domain.Provider) error {
	task, err := w.host.Tasks().Get(ctx, taskID)
	if err != nil || task == nil || task.ID != taskID || task.WorkspaceID != workspaceID {
		return fmt.Errorf("verified task is unavailable")
	}
	candidates, err := taskBitbucketRepositories(ctx, w.host, *task)
	if err != nil {
		return err
	}
	for _, candidate := range candidates {
		remote := watches.RemoteRepository{
			ProviderID: "bitbucket", ProviderHost: candidate.repository.ProviderHost,
			OwnerOrProject: candidate.repository.OwnerOrProject, ProviderRepositoryID: candidate.repository.ProviderRepositoryID,
			Name: providerRepositoryName(candidate.repository), CloneURL: candidate.repository.RemoteURL,
			DefaultBranch: stringValue(candidate.repository.DefaultBranch), BaseBranch: candidate.taskRepository.BaseBranch,
			HeadBranch: candidate.taskRepository.CheckoutBranch,
		}
		repository, err := domainRepository(remote)
		if err != nil {
			return fmt.Errorf("task Bitbucket repository is invalid")
		}
		pullRequests, err := provider.SearchPullRequests(ctx, domain.PullRequestQuery{Repository: repository, State: "OPEN", Limit: 100})
		if err != nil {
			return fmt.Errorf("search task pull requests: %w", err)
		}
		checkoutBranch := branchName(candidate.taskRepository.CheckoutBranch)
		for _, pullRequest := range pullRequests {
			if pullRequest.Repository.Namespace != repository.Namespace || pullRequest.Repository.Slug != repository.Slug || pullRequest.Source.Name != checkoutBranch {
				continue
			}
			link, err := w.linkForPullRequest(ctx, workspaceID, pullRequest)
			if err != nil {
				return err
			}
			if _, err := w.links.AutoLink(ctx, taskID, link); err != nil {
				return err
			}
		}
	}
	return nil
}

func (w *Workflows) linkForPullRequest(ctx context.Context, workspaceID string, pullRequest domain.PullRequest) (PullRequestLink, error) {
	link := PullRequestLink{
		Key: pullRequest.Key(), RepositoryID: pullRequest.Repository.Namespace + "/" + pullRequest.Repository.Slug,
		URL: pullRequest.URL, Number: int64(pullRequest.Number),
	}
	identity, bound, err := w.connectionIdentity(ctx, workspaceID)
	if err != nil {
		return PullRequestLink{}, err
	}
	if !bound {
		return link, nil
	}
	if identity.Product == "" || identity.Host == "" {
		return PullRequestLink{}, fmt.Errorf("Bitbucket connection is unavailable")
	}
	link.Product, link.Host = identity.Product, identity.Host
	if _, _, err := normalizePullRequestLink(link); err != nil {
		return PullRequestLink{}, fmt.Errorf("Bitbucket pull request does not match the active connection")
	}
	return link, nil
}

type connectionIdentity struct {
	Product domain.Product
	Host    string
}

func (w *Workflows) linkMatchesConnection(ctx context.Context, workspaceID string, link PullRequestLink) (bool, error) {
	identity, bound, err := w.connectionIdentity(ctx, workspaceID)
	if err != nil {
		return false, err
	}
	if !bound {
		return true, nil
	}
	return identity.Product == link.Product && strings.EqualFold(identity.Host, link.Host), nil
}

func (w *Workflows) connectionIdentity(ctx context.Context, workspaceID string) (connectionIdentity, bool, error) {
	connections, ok := w.resolver.(interface {
		Load(context.Context, string) (ConnectionSettings, bool, error)
	})
	if !ok {
		return connectionIdentity{}, false, nil
	}
	settings, found, err := connections.Load(ctx, workspaceID)
	if err != nil {
		return connectionIdentity{}, true, fmt.Errorf("load Bitbucket connection: %w", err)
	}
	if !found {
		return connectionIdentity{}, true, nil
	}
	identity := connectionIdentity{Product: settings.Product}
	if settings.Product == domain.ProductCloud {
		identity.Host = "bitbucket.org"
		return identity, true, nil
	}
	if settings.Product != domain.ProductDataCenter {
		return connectionIdentity{}, true, nil
	}
	base, err := url.Parse(settings.BaseURL)
	if err != nil || base.Scheme != "https" || base.User != nil || base.Host == "" {
		return connectionIdentity{}, true, nil
	}
	identity.Host = strings.ToLower(base.Host)
	return identity, true, nil
}

func requireCapability(provider domain.Provider, capability domain.Capability) error {
	if !provider.Capabilities().Supports(capability) {
		return fmt.Errorf("Bitbucket connection does not support %s", capability)
	}
	return nil
}

func decodeAction(body []byte, target any) error {
	if len(body) == 0 {
		body = []byte("{}")
	}
	decoder := json.NewDecoder(strings.NewReader(string(body)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("invalid action body: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		if err == nil {
			return fmt.Errorf("invalid action body: multiple JSON values")
		}
		return fmt.Errorf("invalid action body: %w", err)
	}
	return nil
}

func actionResponse(value any) (*pluginsdk.PluginActionResponse, error) {
	body, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return &pluginsdk.PluginActionResponse{Body: body, Headers: map[string]string{"Content-Type": "application/json"}}, nil
}

func boundedLimit(limit int) int {
	if limit <= 0 {
		return 25
	}
	if limit > 100 {
		return 100
	}
	return limit
}

func applyLaunchPreset(launch *watches.Launch, preset string) error {
	if launch == nil {
		return fmt.Errorf("launch settings are required")
	}
	switch strings.ToLower(strings.TrimSpace(preset)) {
	case "", "default":
		return nil
	case "review":
		if launch.Prompt == "" {
			launch.Prompt = "Review the Bitbucket pull request and run relevant tests."
		}
	case "implement":
		if launch.Prompt == "" {
			launch.Prompt = "Implement the Bitbucket pull request changes and run relevant tests."
		}
	default:
		return fmt.Errorf("unknown Bitbucket launch preset")
	}
	return nil
}
func safeError(err error) string {
	if err == nil {
		return ""
	}
	return "Bitbucket connection health check failed"
}

type listRepositoriesInput struct {
	Query string `json:"query"`
	Limit int    `json:"limit"`
}
type repositoryInput struct {
	Repository watches.RemoteRepository `json:"repository"`
}
type repositoryInspectInput struct {
	URL string `json:"url"`
}
type searchPullRequestsInput struct {
	Repository watches.RemoteRepository `json:"repository"`
	Query      string                   `json:"query"`
	State      string                   `json:"state"`
	Limit      int                      `json:"limit"`
}
type queuePullRequestsInput struct {
	Query string `json:"query"`
	State string `json:"state"`
	Limit int    `json:"limit"`
	View  string `json:"view"`
}
type pullRequestLookup struct {
	ReviewKey     string                   `json:"review_key"`
	Repository    watches.RemoteRepository `json:"repository"`
	Number        int                      `json:"number"`
	PullRequestID string                   `json:"pull_request_id"`
	View          string                   `json:"view"`
	Include       []string                 `json:"include"`
}
type taskCreatePullRequestInput struct {
	Title              string `json:"title"`
	Description        string `json:"description"`
	Destination        string `json:"destination"`
	CloseSourceOnMerge bool   `json:"close_source_on_merge"`
}
type reviewActionInput struct {
	pullRequestLookup
	Kind            string `json:"kind"`
	Operation       string `json:"operation"`
	Comment         string `json:"comment"`
	ParentCommentID string `json:"parent_comment_id"`
	BuildKey        string `json:"build_key"`
}
type launchTaskInput struct {
	pullRequestLookup
	Launch   watches.Launch   `json:"launch"`
	Preset   string           `json:"preset"`
	Task     *nativeTaskInput `json:"task"`
	LaunchID string           `json:"launch_id"`
}
type nativeTaskInput struct {
	Title             string `json:"title"`
	Description       string `json:"description"`
	WorkflowID        string `json:"workflow_id"`
	WorkflowStepID    string `json:"workflow_step_id"`
	AgentProfileID    string `json:"agent_profile_id"`
	ExecutorProfileID string `json:"executor_profile_id"`
	StartAgent        bool   `json:"start_agent"`
	PlanMode          bool   `json:"plan_mode"`
}
type unlinkInput struct {
	Key       string `json:"key"`
	ReviewKey string `json:"review_key"`
}
type watchIDInput struct {
	WatchID string `json:"watch_id"`
}
type watchFilterInput struct {
	WatchID string         `json:"watch_id"`
	Filter  watches.Filter `json:"filter"`
}
type watchPresetInput struct {
	WatchID string         `json:"watch_id"`
	Preset  watches.Preset `json:"preset"`
}
type watchUpdateInput struct {
	WatchID string         `json:"watch_id"`
	Enabled bool           `json:"enabled"`
	Filter  watches.Filter `json:"filter"`
	Launch  watches.Launch `json:"launch"`
}
type connectionSaveInput struct {
	ConnectionInput
	Probe bool `json:"probe"`
}

func repositoryViews(repositories []domain.Repository) []map[string]any {
	views := make([]map[string]any, 0, len(repositories))
	for _, repository := range repositories {
		cloneURL := ""
		host := ""
		if repository.CloneURL != nil {
			cloneURL = repository.CloneURL.String()
			host = repositoryProviderHost(repository.CloneURL)
		}
		views = append(views, map[string]any{
			"id": repository.Namespace + "/" + repository.Slug, "name": repository.Slug,
			"owner_or_project": repository.Namespace, "provider_id": "bitbucket", "provider_host": host,
			"provider_repository_id": repository.Namespace + "/" + repository.Slug, "clone_url": cloneURL,
			"default_branch": repository.DefaultBranch,
		})
	}
	return views
}

func branchViews(branches []domain.Branch) []map[string]any {
	views := make([]map[string]any, 0, len(branches))
	for _, branch := range branches {
		views = append(views, map[string]any{"name": branch.Name, "commit": branch.Commit, "is_default": branch.IsDefault})
	}
	return views
}

func pullRequestViews(pullRequests []domain.PullRequest) []map[string]any {
	views := make([]map[string]any, 0, len(pullRequests))
	for _, pullRequest := range pullRequests {
		views = append(views, pullRequestView(pullRequest))
	}
	return views
}

func pullRequestView(pullRequest domain.PullRequest) map[string]any {
	createdAt := ""
	if !pullRequest.CreatedAt.IsZero() {
		createdAt = pullRequest.CreatedAt.UTC().Format(time.RFC3339)
	}
	return map[string]any{
		"id": strconv.Itoa(pullRequest.Number), "review_key": pullRequest.Key(), "number": pullRequest.Number,
		"title": pullRequest.Title, "description": pullRequest.Description, "url": pullRequest.URL,
		"repository_id":   pullRequest.Repository.Namespace + "/" + pullRequest.Repository.Slug,
		"repository_name": pullRequest.Repository.Slug, "repository": repositoryViews([]domain.Repository{pullRequest.Repository})[0],
		"state": pullRequest.State, "source_branch": pullRequest.Source.Name, "destination_branch": pullRequest.Destination.Name,
		"author":              pullRequest.Author,
		"author_display_name": pullRequest.AuthorDisplayName,
		"created_at":          createdAt,
		"capabilities":        actionCapabilities(pullRequest.Capabilities),
	}
}

func reviewView(review domain.Review) map[string]any {
	view := pullRequestView(review.PullRequest)
	files := make([]map[string]any, 0, len(review.Files))
	for _, file := range review.Files {
		files = append(files, map[string]any{
			"path": file.Path, "status": file.Status, "additions": file.Additions, "deletions": file.Deletions, "patch": file.Patch,
		})
	}
	commits := make([]map[string]any, 0, len(review.Commits))
	for _, commit := range review.Commits {
		commits = append(commits, map[string]any{"id": commit.Hash, "hash": commit.Hash, "message": commit.Message, "author": commit.Author})
	}
	participants := make([]map[string]any, 0, len(review.Participants))
	viewerKnown := strings.TrimSpace(review.ViewerID) != ""
	viewerApproved := false
	for _, participant := range review.Participants {
		participantView := map[string]any{"id": participant.ID, "name": participant.Name, "role": participant.Role, "approved": participant.Approved}
		if viewerKnown && strings.EqualFold(participant.ID, review.ViewerID) {
			participantView["is_current_user"] = true
			viewerApproved = participant.Approved
		}
		participants = append(participants, participantView)
	}
	threads := make([]map[string]any, 0, len(review.Threads))
	for _, thread := range review.Threads {
		threadView := map[string]any{"id": thread.ID, "comments": thread.Comments}
		if len(thread.Comments) > 0 {
			threadView["author"] = thread.Comments[0].Author
			threadView["body"] = thread.Comments[0].Body
		}
		threads = append(threads, threadView)
	}
	statuses := make([]map[string]any, 0, len(review.Statuses))
	for _, status := range review.Statuses {
		statuses = append(statuses, map[string]any{"key": status.Key, "name": status.Name, "state": status.State, "url": status.URL, "target": status.Target})
	}
	view["diff"] = review.Diff
	view["files"] = files
	view["commits"] = commits
	view["participants"] = participants
	if viewerKnown {
		view["viewer_approved"] = viewerApproved
	}
	view["threads"] = threads
	view["statuses"] = statuses
	return view
}

func actionCapabilities(capabilities domain.Capabilities) []string {
	values := []string{"link", "launch_task"}
	for capability, enabled := range capabilities {
		if enabled {
			values = append(values, string(capability))
		}
	}
	sort.Strings(values)
	return values
}

func searchWorkspacePullRequests(ctx context.Context, provider domain.Provider, query, state string, limit int) ([]domain.PullRequest, error) {
	repositories, err := provider.ListRepositories(ctx, "", limit)
	if err != nil {
		return nil, err
	}
	result := make([]domain.PullRequest, 0, limit)
	for _, repository := range repositories {
		pullRequests, searchErr := provider.SearchPullRequests(ctx, domain.PullRequestQuery{Repository: repository, Text: query, State: state, Limit: limit})
		if searchErr != nil {
			return nil, searchErr
		}
		for _, pullRequest := range pullRequests {
			if state != "" && !strings.EqualFold(state, "all") && !strings.EqualFold(state, pullRequest.State) {
				continue
			}
			result = append(result, pullRequest)
			if len(result) == limit {
				sort.Slice(result, func(i, j int) bool { return result[i].Key() < result[j].Key() })
				return result, nil
			}
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Key() < result[j].Key() })
	return result, nil
}

func parsePullRequestKey(key string) (domain.Repository, int, bool) {
	parts := strings.Split(strings.TrimSpace(key), "#")
	if len(parts) != 2 || parts[0] == "" {
		return domain.Repository{}, 0, false
	}
	path := strings.Split(parts[0], "/")
	if len(path) != 2 || path[0] == "" || path[1] == "" {
		return domain.Repository{}, 0, false
	}
	number, err := strconv.Atoi(parts[1])
	if err != nil || number <= 0 {
		return domain.Repository{}, 0, false
	}
	return domain.Repository{Namespace: path[0], Slug: path[1]}, number, true
}

func hasFilter(filter watches.Filter) bool {
	return len(filter.RepositoryIDs) > 0 || len(filter.Repositories) > 0 || len(filter.States) > 0 || len(filter.Authors) > 0 || filter.Query != ""
}

func sameRepositoryURL(left, right *url.URL) bool {
	if left == nil || right == nil || !strings.EqualFold(left.Host, right.Host) {
		return false
	}
	leftPath := strings.TrimSuffix(strings.TrimSuffix(left.Path, "/"), ".git")
	rightPath := strings.TrimSuffix(strings.TrimSuffix(right.Path, "/"), ".git")
	return leftPath == rightPath
}

func connectionResponse(settings ConnectionSettings, healthy bool, err error, oauthConfigured ...bool) map[string]any {
	state := "connected"
	if !healthy {
		state = "auth_required"
		if err != nil && !strings.Contains(strings.ToLower(err.Error()), "auth") {
			state = "unavailable"
		}
	}
	registrationConfigured := settings.AuthMethod == "oauth" && settings.OAuthClientID != ""
	if len(oauthConfigured) > 0 {
		registrationConfigured = oauthConfigured[0]
	}
	return map[string]any{
		"state": state, "healthy": healthy, "product": settings.Product, "base_url": settings.BaseURL,
		"cloud_workspace": settings.CloudWorkspace, "auth_method": settings.AuthMethod, "auth_identity": settings.AuthIdentity,
		"oauth_client_id": settings.OAuthClientID, "oauth_redirect_url": settings.OAuthRedirectURL,
		"oauth_registration_configured": registrationConfigured,
		"error":                         safeError(err),
	}
}

type providerCredentialSource struct{ resolver ProviderResolver }

func (s providerCredentialSource) GetGitCredentialBinding(ctx context.Context, scope GitCredentialScope) (string, error) {
	binder, ok := s.resolver.(interface {
		GitCredentialBinding(context.Context, GitCredentialScope) (string, error)
	})
	if !ok {
		return "", ErrCredentialUnavailable
	}
	return binder.GitCredentialBinding(ctx, scope)
}

func (s providerCredentialSource) ResolveGitCredential(ctx context.Context, scope GitCredentialScope) (GitCredential, error) {
	if validator, ok := s.resolver.(interface {
		ValidateGitCredentialScope(context.Context, GitCredentialScope) error
	}); ok {
		if err := validator.ValidateGitCredentialScope(ctx, scope); err != nil {
			return GitCredential{}, ErrCredentialUnavailable
		}
	}
	provider, err := s.resolver.Provider(ctx, scope.WorkspaceID)
	if err != nil {
		return GitCredential{}, err
	}
	credential, err := provider.ResolveGitCredential(ctx)
	if err != nil {
		return GitCredential{}, err
	}
	expiresAt := credential.ExpiresAt
	if expiresAt.IsZero() {
		expiresAt = time.Now().Add(5 * time.Minute)
	}
	return GitCredential{Username: credential.Username, Secret: credential.Secret, ExpiresAt: expiresAt}, nil
}

func referenceIdentity(reference map[string]any) (domain.Repository, int, string, bool) {
	key, ok := canonicalReferenceKey(reference)
	if !ok {
		return domain.Repository{}, 0, "", false
	}
	repository, number, ok := parsePullRequestKey(key)
	if !ok {
		return domain.Repository{}, 0, "", false
	}

	repositoryValue, hasRepository := reference["repository"]
	numberValue, hasNumber := reference["number"]
	if !hasRepository && !hasNumber {
		return repository, number, key, true
	}
	if !hasRepository || !hasNumber {
		return domain.Repository{}, 0, "", false
	}
	repositoryMap, repositoryOK := repositoryValue.(map[string]any)
	structuredNumber, numberOK := positiveNumber(numberValue)
	if !repositoryOK || !numberOK {
		return domain.Repository{}, 0, "", false
	}
	namespace, namespaceOK := repositoryMap["namespace"].(string)
	slug, slugOK := repositoryMap["slug"].(string)
	if !namespaceOK || !slugOK {
		return domain.Repository{}, 0, "", false
	}
	if namespace != repository.Namespace || slug != repository.Slug || structuredNumber != number {
		return domain.Repository{}, 0, "", false
	}
	return repository, number, key, true
}

func canonicalReferenceKey(reference map[string]any) (string, bool) {
	key, hasKey := reference["key"].(string)
	id, hasID := reference["id"].(string)
	key = strings.TrimSpace(key)
	id = strings.TrimSpace(id)
	if hasKey && hasID && key != id {
		return "", false
	}
	if key != "" {
		return key, true
	}
	return id, id != ""
}

func positiveNumber(value any) (int, bool) {
	switch value := value.(type) {
	case int:
		return value, value > 0
	case int64:
		return int(value), value > 0 && int64(int(value)) == value
	case float64:
		return int(value), value > 0 && value == float64(int(value))
	case json.Number:
		parsed, err := value.Int64()
		return int(parsed), err == nil && parsed > 0 && int64(int(parsed)) == parsed
	default:
		return 0, false
	}
}

package plugin

import (
	"context"
	"fmt"
	"net/url"
	"sort"
	"strings"

	"kandev-plugin-bitbucket/internal/domain"
	"kandev-plugin-bitbucket/internal/watches"

	"github.com/kandev/kandev/pkg/pluginsdk"
)

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
		repository, err = hydrateRepositoryIdentity(ctx, provider, repository)
		if err != nil {
			unavailable = append(unavailable, map[string]any{"key": link.Key, "reason": "repository_unavailable"})
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
		repository, err = hydrateRepositoryIdentity(ctx, provider, repository)
		if err != nil {
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

func (w *Workflows) pullRequestAssociations(
	ctx context.Context,
	workspaceID string,
	visibleReviewKeys *[]string,
) ([]map[string]any, error) {
	if workspaceID == "" {
		return nil, fmt.Errorf("verified workspace context is required")
	}
	watchAssociations, err := w.watchOwnedAssociations(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	associations := make([]map[string]any, 0)
	visible := associationKeyFilter(visibleReviewKeys)
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
				matchesConnection, err := w.linkMatchesConnection(ctx, workspaceID, link)
				if err != nil {
					return nil, err
				}
				if !matchesConnection || !visibleAssociationKey(visible, link.Key) {
					continue
				}
				keys[link.Key] = struct{}{}
			}
			for key := range watchAssociations[task.ID] {
				if !visibleAssociationKey(visible, key) {
					continue
				}
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

func associationKeyFilter(keys *[]string) map[string]struct{} {
	if keys == nil {
		return nil
	}
	result := make(map[string]struct{}, len(*keys))
	for _, key := range *keys {
		if _, _, ok := parsePullRequestKey(key); ok {
			result[key] = struct{}{}
		}
	}
	return result
}

func visibleAssociationKey(filter map[string]struct{}, key string) bool {
	if filter == nil {
		return true
	}
	_, found := filter[key]
	return found
}

func (w *Workflows) watchOwnedAssociations(ctx context.Context, workspaceID string) (map[string]map[string]struct{}, error) {
	configured, err := w.watches.List(ctx, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("list watch-owned pull request links: %w", err)
	}
	identity, bound, err := w.connectionIdentity(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	associations := make(map[string]map[string]struct{})
	for _, watch := range configured {
		for mapKey, link := range watch.Links {
			if !link.Owned || link.TaskID == "" || !watchLinkMatchesConnection(link, identity, bound) {
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

func watchLinkMatchesConnection(
	link watches.TaskLink,
	identity connectionIdentity,
	bound bool,
) bool {
	if !bound {
		return true
	}
	if identity.Host == "" || identity.Scope == "" || link.ProviderID != "bitbucket" || link.ProviderHost == "" {
		return false
	}
	if !providerHostMatches(link.ProviderHost, &url.URL{Scheme: "https", Host: identity.Host}) {
		return false
	}
	if link.ConnectionScope != "" {
		return sameConnectionScope(identity.Scope, link.ConnectionScope)
	}
	if identity.Product == domain.ProductCloud {
		return true
	}
	return link.PullRequestURL != "" && urlWithinConnectionScope(link.PullRequestURL, identity.Scope)
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
			ProviderScope: candidate.repository.ProviderScope, OwnerOrProject: candidate.repository.OwnerOrProject,
			ProviderRepositoryID: candidate.repository.ProviderRepositoryID,
			Name:                 providerRepositoryName(candidate.repository), CloneURL: candidate.repository.RemoteURL,
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
		Key: pullRequest.Key(), RepositoryID: pullRequest.Repository.ID,
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
	link.Product, link.Host, link.ConnectionScope = identity.Product, identity.Host, identity.Scope
	if _, _, err := normalizePullRequestLink(link); err != nil {
		return PullRequestLink{}, fmt.Errorf("Bitbucket pull request does not match the active connection")
	}
	return link, nil
}

func (w *Workflows) linkMatchesConnection(ctx context.Context, workspaceID string, link PullRequestLink) (bool, error) {
	identity, bound, err := w.connectionIdentity(ctx, workspaceID)
	if err != nil {
		return false, err
	}
	if !bound {
		return true, nil
	}
	if identity.Product != link.Product || !strings.EqualFold(identity.Host, link.Host) {
		return false, nil
	}
	if link.ConnectionScope != "" {
		return sameConnectionScope(identity.Scope, link.ConnectionScope), nil
	}
	// Legacy Data Center records did not persist the context path. Match only
	// when their canonical PR URL is inside the active connection scope.
	return urlWithinConnectionScope(link.URL, identity.Scope), nil
}

func (w *Workflows) connectionIdentity(ctx context.Context, workspaceID string) (connectionIdentity, bool, error) {
	return connectionIdentityForResolver(ctx, w.resolver, workspaceID)
}

package plugin

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"time"

	"kandev-plugin-bitbucket/internal/domain"
	"kandev-plugin-bitbucket/internal/watches"
)

// ProviderResolver selects the authenticated Cloud or Data Center adapter for
// a verified Kandev workspace. Connection/auth ownership stays behind this
// boundary; workflow callers never inspect tokens or provider HTTP payloads.
type ProviderResolver interface {
	Provider(context.Context, string) (domain.Provider, error)
}

type WatchProvider struct{ resolver ProviderResolver }

func NewWatchProvider(resolver ProviderResolver) (*WatchProvider, error) {
	if resolver == nil {
		return nil, fmt.Errorf("provider resolver is required")
	}
	return &WatchProvider{resolver: resolver}, nil
}

func (p *WatchProvider) ListPullRequests(ctx context.Context, watch watches.Watch) ([]watches.PullRequest, string, error) {
	provider, err := p.resolver.Provider(ctx, watch.WorkspaceID)
	if err != nil {
		return nil, "", fmt.Errorf("resolve Bitbucket provider: %w", err)
	}
	if !provider.Capabilities().Supports(domain.CapabilityPullRequests) {
		return nil, "", fmt.Errorf("Bitbucket connection does not support pull_requests")
	}
	if pager, ok := provider.(domain.PullRequestPager); ok {
		items, cursor, err := p.listPullRequestPage(ctx, provider, pager, watch)
		if err != nil {
			return nil, "", err
		}
		identity, bound, err := connectionIdentityForResolver(ctx, p.resolver, watch.WorkspaceID)
		if err != nil {
			return nil, "", err
		}
		if bound && identity.Scope == "" {
			return nil, "", fmt.Errorf("Bitbucket connection identity is unavailable")
		}
		for index := range items {
			items[index].ConnectionScope = identity.Scope
		}
		return items, cursor, nil
	}
	return nil, "", fmt.Errorf("Bitbucket connection does not support restart-safe pull request paging")
}

const watchCursorVersion = 1

type watchPageCursor struct {
	Version        int    `json:"version"`
	Repository     string `json:"repository"`
	State          string `json:"state"`
	ProviderCursor string `json:"provider_cursor,omitempty"`
}

type watchQueryGroup struct {
	repository domain.Repository
	state      string
}

func (p *WatchProvider) listPullRequestPage(ctx context.Context, provider domain.Provider, pager domain.PullRequestPager, watch watches.Watch) ([]watches.PullRequest, string, error) {
	repositories, err := filterRepositories(ctx, provider, watch.Filter)
	if err != nil {
		return nil, "", err
	}
	groups := watchGroups(repositories, watchStates(watch.Filter.States))
	if len(groups) == 0 {
		return nil, "", nil
	}
	current, found := parseWatchPageCursor(watch.Cursor)
	groupIndex := 0
	providerCursor := ""
	if found {
		for index, group := range groups {
			if group.repository.Namespace+"/"+group.repository.Slug == current.Repository && group.state == current.State {
				groupIndex, providerCursor = index, current.ProviderCursor
				break
			}
		}
	}
	group := groups[groupIndex]
	page, err := pager.SearchPullRequestsPage(ctx, domain.PullRequestQuery{
		Repository: group.repository, Text: watch.Filter.Query, State: group.state, Limit: 100, Cursor: providerCursor,
	})
	if err != nil {
		return nil, "", fmt.Errorf("search watched pull requests: %w", err)
	}
	resultByKey := make(map[string]watches.PullRequest, len(page.PullRequests))
	for _, pullRequest := range page.PullRequests {
		if matchesFilter(pullRequest, watch.Filter) {
			resultByKey[pullRequest.Key()] = watchPullRequest(pullRequest)
		}
	}
	result := make([]watches.PullRequest, 0, len(resultByKey))
	for _, pullRequest := range resultByKey {
		result = append(result, pullRequest)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Key < result[j].Key })
	if page.NextCursor != "" {
		return result, encodeWatchPageCursor(watchPageCursor{Version: watchCursorVersion, Repository: group.repository.Namespace + "/" + group.repository.Slug, State: group.state, ProviderCursor: page.NextCursor}), nil
	}
	if groupIndex+1 < len(groups) {
		next := groups[groupIndex+1]
		return result, encodeWatchPageCursor(watchPageCursor{Version: watchCursorVersion, Repository: next.repository.Namespace + "/" + next.repository.Slug, State: next.state}), nil
	}
	return result, "", nil
}

func watchGroups(repositories []domain.Repository, states []string) []watchQueryGroup {
	sort.Slice(repositories, func(i, j int) bool {
		left, right := repositories[i].Namespace+"/"+repositories[i].Slug, repositories[j].Namespace+"/"+repositories[j].Slug
		return left < right
	})
	groups := make([]watchQueryGroup, 0, len(repositories)*len(states))
	for _, repository := range repositories {
		for _, state := range states {
			groups = append(groups, watchQueryGroup{repository: repository, state: state})
		}
	}
	return groups
}

func encodeWatchPageCursor(cursor watchPageCursor) string {
	encoded, err := json.Marshal(cursor)
	if err != nil {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(encoded)
}

func parseWatchPageCursor(raw string) (watchPageCursor, bool) {
	if raw == "" || len(raw) > 8192 {
		return watchPageCursor{}, false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return watchPageCursor{}, false
	}
	var cursor watchPageCursor
	if err := json.Unmarshal(decoded, &cursor); err != nil || cursor.Version != watchCursorVersion || cursor.Repository == "" {
		return watchPageCursor{}, false
	}
	return cursor, true
}

func watchStates(states []string) []string {
	if len(states) == 0 {
		return []string{""}
	}
	unique := make(map[string]struct{}, len(states))
	for _, state := range states {
		normalized := strings.ToUpper(strings.TrimSpace(state))
		if normalized != "" {
			unique[normalized] = struct{}{}
		}
	}
	if _, all := unique["ALL"]; all {
		return []string{"ALL"}
	}
	values := make([]string, 0, len(unique))
	for state := range unique {
		values = append(values, state)
	}
	sort.Strings(values)
	return values
}

func filterRepositories(ctx context.Context, provider domain.Provider, filter watches.Filter) ([]domain.Repository, error) {
	if len(filter.Repositories) > 0 {
		repositories := make([]domain.Repository, 0, len(filter.Repositories))
		for _, repository := range filter.Repositories {
			parsed, err := domainRepository(repository)
			if err != nil {
				return nil, err
			}
			repositories = append(repositories, parsed)
		}
		return repositories, nil
	}
	repositories, err := listAllRepositories(ctx, provider, "")
	if err != nil {
		return nil, fmt.Errorf("list watched repositories: %w", err)
	}
	if len(filter.RepositoryIDs) == 0 {
		return repositories, nil
	}
	immutableIDs := make(map[string]struct{}, len(filter.RepositoryIDs))
	legacyIDs := make([]string, 0, len(filter.RepositoryIDs))
	for _, requestedID := range filter.RepositoryIDs {
		matched := false
		for _, repository := range repositories {
			if repository.ID != "" && repository.ID == requestedID {
				immutableIDs[requestedID] = struct{}{}
				matched = true
				break
			}
		}
		if !matched {
			legacyIDs = append(legacyIDs, requestedID)
		}
	}
	filtered := make([]domain.Repository, 0, len(repositories))
	for _, repository := range repositories {
		_, immutableMatch := immutableIDs[repository.ID]
		legacyID := repository.Namespace + "/" + repository.Slug
		if immutableMatch || containsFold(legacyIDs, legacyID) || containsFold(legacyIDs, repository.Slug) {
			filtered = append(filtered, repository)
		}
	}
	return filtered, nil
}

func matchesFilter(pullRequest domain.PullRequest, filter watches.Filter) bool {
	if len(filter.States) > 0 && !containsFold(filter.States, pullRequest.State) {
		return false
	}
	if len(filter.Authors) > 0 && !containsFold(filter.Authors, pullRequest.Author) {
		return false
	}
	return true
}

func watchPullRequest(pullRequest domain.PullRequest) watches.PullRequest {
	sourceRepository := pullRequest.SourceRepository
	if sourceRepository.Namespace == "" || sourceRepository.Slug == "" || sourceRepository.CloneURL == nil {
		sourceRepository = pullRequest.Repository
	}
	repository := remoteRepositoryFromDomain(sourceRepository, pullRequest.Destination.Name, pullRequest.Source.Name)
	return watches.PullRequest{
		Key: pullRequest.Key(), RepositoryID: repository.ProviderRepositoryID, Repository: repository,
		Number: int64(pullRequest.Number), Title: pullRequest.Title, URL: pullRequest.URL, State: pullRequest.State, Author: pullRequest.Author,
		UpdatedAt: time.Now().UTC(), Attributes: map[string]any{"capabilities": pullRequest.Capabilities},
	}
}

func domainRepository(repository watches.RemoteRepository) (domain.Repository, error) {
	if repository.ProviderID != "bitbucket" || repository.OwnerOrProject == "" || repository.Name == "" || repository.CloneURL == "" {
		return domain.Repository{}, fmt.Errorf("repository descriptor is incomplete")
	}
	cloneURL, err := url.Parse(repository.CloneURL)
	if err != nil || cloneURL.Scheme != "https" || cloneURL.User != nil {
		return domain.Repository{}, fmt.Errorf("repository clone URL must be credential-free HTTPS")
	}
	return domain.Repository{ID: repository.ProviderRepositoryID, ProviderScope: repository.ProviderScope, Namespace: repository.OwnerOrProject, Slug: repository.Name, CloneURL: cloneURL}, nil
}

func remoteRepositoryFromDomain(repository domain.Repository, baseBranch, headBranch string) watches.RemoteRepository {
	cloneURL := ""
	host := ""
	if repository.CloneURL != nil {
		cloneURL = repository.CloneURL.String()
		host = repositoryProviderHost(repository.CloneURL)
	}
	return watches.RemoteRepository{
		ProviderID: "bitbucket", ProviderHost: host, ProviderScope: repository.ProviderScope, OwnerOrProject: repository.Namespace,
		ProviderRepositoryID: repository.ID, Name: repository.Slug,
		CloneURL: cloneURL, BaseBranch: baseBranch, HeadBranch: headBranch,
	}
}

func repositoryProviderHost(value *url.URL) string {
	if value == nil || value.Scheme == "" || value.Host == "" {
		return ""
	}
	return value.Scheme + "://" + value.Host
}

func containsFold(values []string, value string) bool {
	for _, candidate := range values {
		if strings.EqualFold(candidate, value) {
			return true
		}
	}
	return false
}

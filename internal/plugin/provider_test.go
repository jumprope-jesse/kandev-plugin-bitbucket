package plugin

import (
	"context"
	"fmt"
	"testing"

	"github.com/stretchr/testify/require"
	"kandev-plugin-bitbucket/internal/domain"
	"kandev-plugin-bitbucket/internal/watches"
)

func TestWatchProviderRequestsConfiguredPullRequestStates(t *testing.T) {
	pullRequest := testPullRequest()
	pullRequest.State = "MERGED"
	provider := &workflowProvider{pullRequest: pullRequest}
	watchProvider, err := NewWatchProvider(staticResolver{provider: provider})
	require.NoError(t, err)

	_, _, err = watchProvider.ListPullRequests(context.Background(), watches.Watch{
		ID: "watch-1", WorkspaceID: "workspace-1", Filter: watches.Filter{States: []string{"merged"}},
	})
	require.NoError(t, err)
	require.Len(t, provider.searchQueries, 1)
	require.Equal(t, domain.PullRequestQuery{Repository: pullRequest.Repository, State: "MERGED", Limit: 100}, provider.searchQueries[0])
}

func TestWatchProviderResumesOpaqueProviderPagesWithoutMissingPastFirstPage(t *testing.T) {
	providerFirstPage := make([]domain.PullRequest, 0, 100)
	for number := 1; number <= 100; number++ {
		pullRequest := testPullRequest()
		pullRequest.Number = number
		providerFirstPage = append(providerFirstPage, pullRequest)
	}
	second := testPullRequest()
	second.Number = 101
	pager := &pagedWorkflowProvider{workflowProvider: workflowProvider{pullRequest: providerFirstPage[0]}, pages: map[string]domain.PullRequestPage{
		"":                {PullRequests: providerFirstPage, NextCursor: "provider-page-2"},
		"provider-page-2": {PullRequests: []domain.PullRequest{second}},
	}}
	watchProvider, err := NewWatchProvider(staticResolver{provider: pager})
	require.NoError(t, err)
	watch := watches.Watch{ID: "watch-1", WorkspaceID: "workspace-1"}

	firstPage, cursor, err := watchProvider.ListPullRequests(context.Background(), watch)
	require.NoError(t, err)
	require.Len(t, firstPage, 100)
	require.Equal(t, int64(1), firstPage[0].Number)
	require.Contains(t, pullRequestNumbers(firstPage), int64(100))
	require.NotEmpty(t, cursor)
	require.NotEqual(t, "workspace/repo#100", cursor, "watch cursor must wrap the provider's opaque continuation")

	watch.Cursor = cursor
	secondPage, cursor, err := watchProvider.ListPullRequests(context.Background(), watch)
	require.NoError(t, err)
	require.Equal(t, []int64{101}, pullRequestNumbers(secondPage))
	require.Empty(t, cursor)
	require.Equal(t, []string{"", "provider-page-2"}, pager.cursors)
}

func pullRequestNumbers(pullRequests []watches.PullRequest) []int64 {
	numbers := make([]int64, 0, len(pullRequests))
	for _, pullRequest := range pullRequests {
		numbers = append(numbers, pullRequest.Number)
	}
	return numbers
}

type pagedWorkflowProvider struct {
	workflowProvider
	pages   map[string]domain.PullRequestPage
	cursors []string
}

func (p *pagedWorkflowProvider) SearchPullRequests(context.Context, domain.PullRequestQuery) ([]domain.PullRequest, error) {
	return nil, fmt.Errorf("legacy pull request listing must not be used for watches")
}

func (p *pagedWorkflowProvider) SearchPullRequestsPage(_ context.Context, query domain.PullRequestQuery) (domain.PullRequestPage, error) {
	p.cursors = append(p.cursors, query.Cursor)
	page, found := p.pages[query.Cursor]
	if !found {
		return domain.PullRequestPage{}, fmt.Errorf("unexpected cursor %q", query.Cursor)
	}
	return page, nil
}

func TestWatchProviderFiltersPullRequestsByCanonicalAuthor(t *testing.T) {
	pullRequest := testPullRequest()
	pullRequest.Author = "cloud-account-ada"
	provider := &workflowProvider{pullRequest: pullRequest}
	watchProvider, err := NewWatchProvider(staticResolver{provider: provider})
	require.NoError(t, err)

	pullRequests, _, err := watchProvider.ListPullRequests(context.Background(), watches.Watch{
		ID: "watch-1", WorkspaceID: "workspace-1", Filter: watches.Filter{Authors: []string{"cloud-account-grace"}},
	})
	require.NoError(t, err)
	require.Empty(t, pullRequests)
}

func TestRepositorySearchProviderDispatchesCloudWorkspaceSearch(t *testing.T) {
	searcher := &cloudRepositorySearcher{workflowProvider: workflowProvider{pullRequest: testPullRequest()}}
	provider := repositorySearchProvider{Provider: searcher, workspace: "acme"}

	_, err := provider.ListRepositories(context.Background(), "widgets", 7)

	require.NoError(t, err)
	require.Equal(t, "acme", searcher.workspace)
	require.Equal(t, "widgets", searcher.query)
	require.Equal(t, 7, searcher.limit)
}

func TestRepositorySearchProviderDispatchesDataCenterSearch(t *testing.T) {
	searcher := &dataCenterRepositorySearcher{workflowProvider: workflowProvider{pullRequest: testPullRequest()}}
	provider := repositorySearchProvider{Provider: searcher}

	_, err := provider.ListRepositories(context.Background(), "widgets", 7)

	require.NoError(t, err)
	require.Equal(t, "widgets", searcher.query)
	require.Equal(t, 7, searcher.limit)
}

func TestRepositorySearchProviderForwardsPullRequestPaging(t *testing.T) {
	pullRequest := testPullRequest()
	query := domain.PullRequestQuery{Repository: pullRequest.Repository, State: "OPEN", Cursor: "page-2", Limit: 37}
	expected := domain.PullRequestPage{PullRequests: []domain.PullRequest{pullRequest}, NextCursor: "page-3"}
	pager := &pagedWorkflowProvider{pages: map[string]domain.PullRequestPage{"page-2": expected}}
	provider := repositorySearchProvider{Provider: pager, workspace: "acme"}

	forwarded, ok := any(provider).(domain.PullRequestPager)
	require.True(t, ok, "repository wrapper must retain the provider paging contract")
	if !ok {
		return
	}
	page, err := forwarded.SearchPullRequestsPage(context.Background(), query)

	require.NoError(t, err)
	require.Equal(t, expected, page)
	require.Equal(t, []string{"page-2"}, pager.cursors)
}

type cloudRepositorySearcher struct {
	workflowProvider
	workspace string
	query     string
	limit     int
}

func (s *cloudRepositorySearcher) SearchRepositories(_ context.Context, workspace, query string, limit int) ([]domain.Repository, error) {
	s.workspace, s.query, s.limit = workspace, query, limit
	return []domain.Repository{s.pullRequest.Repository}, nil
}

type dataCenterRepositorySearcher struct {
	workflowProvider
	query string
	limit int
}

func (s *dataCenterRepositorySearcher) SearchRepositories(_ context.Context, query string, limit int) ([]domain.Repository, error) {
	s.query, s.limit = query, limit
	return []domain.Repository{s.pullRequest.Repository}, nil
}

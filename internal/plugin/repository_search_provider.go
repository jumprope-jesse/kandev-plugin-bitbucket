package plugin

import (
	"context"
	"strings"

	"kandev-plugin-bitbucket/internal/domain"
)

// repositorySearchProvider supplies the Cloud workspace internally and
// applies the optional generic repository query locally. Data Center ignores
// the workspace argument, so the same wrapper keeps the provider contract
// uniform across products.
type repositorySearchProvider struct {
	domain.Provider
	workspace string
}

func (p repositorySearchProvider) SearchPullRequestsPage(ctx context.Context, query domain.PullRequestQuery) (domain.PullRequestPage, error) {
	if pager, ok := p.Provider.(domain.PullRequestPager); ok {
		return pager.SearchPullRequestsPage(ctx, query)
	}
	pullRequests, err := p.Provider.SearchPullRequests(ctx, query)
	return domain.PullRequestPage{PullRequests: pullRequests}, err
}

func (p repositorySearchProvider) ListRepositories(ctx context.Context, query string, limit int) ([]domain.Repository, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return p.Provider.ListRepositories(ctx, p.workspace, limit)
	}
	if searcher, ok := p.Provider.(interface {
		SearchRepositories(context.Context, string, string, int) ([]domain.Repository, error)
	}); ok {
		return searcher.SearchRepositories(ctx, p.workspace, query, limit)
	}
	if searcher, ok := p.Provider.(interface {
		SearchRepositories(context.Context, string, int) ([]domain.Repository, error)
	}); ok {
		return searcher.SearchRepositories(ctx, query, limit)
	}

	repositories, err := p.Provider.ListRepositories(ctx, p.workspace, limit)
	if err != nil {
		return repositories, err
	}
	needle := strings.ToLower(query)
	filtered := make([]domain.Repository, 0, len(repositories))
	for _, repository := range repositories {
		if strings.Contains(strings.ToLower(repository.Namespace+"/"+repository.Slug), needle) {
			filtered = append(filtered, repository)
		}
	}
	return filtered, nil
}

func (p repositorySearchProvider) ListRepositoriesPage(
	ctx context.Context,
	_ string,
	query domain.RepositoryQuery,
) (domain.RepositoryPage, error) {
	if pager, ok := p.Provider.(domain.RepositoryPager); ok {
		return pager.ListRepositoriesPage(ctx, p.workspace, query)
	}
	repositories, err := p.ListRepositories(ctx, query.Text, query.Limit)
	return domain.RepositoryPage{Repositories: repositories}, err
}

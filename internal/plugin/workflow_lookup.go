package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"kandev-plugin-bitbucket/internal/domain"
	"kandev-plugin-bitbucket/internal/watches"
)

func searchWorkspacePullRequests(ctx context.Context, provider domain.Provider, query, state string, limit int) ([]domain.PullRequest, error) {
	repositories, err := listAllRepositories(ctx, provider, "")
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

func listRepositoryPage(
	ctx context.Context,
	provider domain.Provider,
	query domain.RepositoryQuery,
) (domain.RepositoryPage, error) {
	if pager, ok := provider.(domain.RepositoryPager); ok {
		return pager.ListRepositoriesPage(ctx, "", query)
	}
	repositories, err := provider.ListRepositories(ctx, query.Text, query.Limit)
	return domain.RepositoryPage{Repositories: repositories}, err
}

func listAllRepositories(ctx context.Context, provider domain.Provider, query string) ([]domain.Repository, error) {
	const pageLimit = 100
	var repositories []domain.Repository
	cursor := ""
	seen := make(map[string]struct{})
	for {
		page, err := listRepositoryPage(ctx, provider, domain.RepositoryQuery{Text: query, Limit: pageLimit, Cursor: cursor})
		if err != nil {
			return nil, err
		}
		repositories = append(repositories, page.Repositories...)
		if page.NextCursor == "" {
			return repositories, nil
		}
		if _, repeated := seen[page.NextCursor]; repeated {
			return nil, fmt.Errorf("repository pagination did not advance")
		}
		seen[page.NextCursor] = struct{}{}
		cursor = page.NextCursor
	}
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

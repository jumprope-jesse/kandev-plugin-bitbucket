package plugin

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"kandev-plugin-bitbucket/internal/domain"
	"kandev-plugin-bitbucket/internal/watches"
)

const workspacePullRequestCursorVersion = 1

type workspacePullRequestCursor struct {
	Version        int    `json:"version"`
	QueryHash      string `json:"query_hash"`
	Repository     string `json:"repository"`
	ProviderCursor string `json:"provider_cursor,omitempty"`
	Offset         int    `json:"offset,omitempty"`
}

func searchWorkspacePullRequests(
	ctx context.Context,
	provider domain.Provider,
	query string,
	state string,
	limit int,
	rawCursor string,
) (domain.PullRequestPage, error) {
	repositories, err := listAllRepositories(ctx, provider, "")
	if err != nil {
		return domain.PullRequestPage{}, err
	}
	sort.Slice(repositories, func(i, j int) bool {
		return workspaceRepositoryOrderKey(repositories[i]) < workspaceRepositoryOrderKey(repositories[j])
	})
	cursor, found, err := parseWorkspacePullRequestCursor(rawCursor, query, state)
	if err != nil {
		return domain.PullRequestPage{}, err
	}
	repositoryIndex := 0
	if found {
		repositoryIndex = -1
		for index, repository := range repositories {
			if workspaceRepositoryIdentity(repository) == cursor.Repository {
				repositoryIndex = index
				break
			}
		}
		if repositoryIndex < 0 {
			return domain.PullRequestPage{}, fmt.Errorf("pull request queue cursor repository is unavailable")
		}
	}
	if repositoryIndex >= len(repositories) {
		return domain.PullRequestPage{}, nil
	}

	target := limit + 1
	result := make([]domain.PullRequest, 0, target)
	nextAfterLimit := ""
	providerCursor := cursor.ProviderCursor
	offset := cursor.Offset
	pageHops := 0
	for ; repositoryIndex < len(repositories); repositoryIndex++ {
		repository := repositories[repositoryIndex]
		seenProviderCursors := make(map[string]struct{})
		for {
			pageHops++
			if pageHops > 10000 {
				return domain.PullRequestPage{}, fmt.Errorf("pull request queue pagination limit exceeded")
			}
			pageInputCursor := providerCursor
			seenProviderCursors[pageInputCursor] = struct{}{}
			page, searchErr := searchPullRequestPage(ctx, provider, domain.PullRequestQuery{
				Repository: repository,
				Text:       query,
				State:      state,
				Limit:      limit,
				Cursor:     pageInputCursor,
			})
			if searchErr != nil {
				return domain.PullRequestPage{}, searchErr
			}
			filtered := filterPullRequestState(page.PullRequests, state)
			if offset > len(filtered) {
				return domain.PullRequestPage{}, fmt.Errorf("pull request queue cursor offset is invalid")
			}
			for index := offset; index < len(filtered); index++ {
				result = append(result, filtered[index])
				after, encodeErr := queuePositionAfter(
					repositories,
					repositoryIndex,
					query,
					state,
					pageInputCursor,
					page.NextCursor,
					index+1,
					len(filtered),
				)
				if encodeErr != nil {
					return domain.PullRequestPage{}, encodeErr
				}
				if len(result) == limit {
					nextAfterLimit = after
				}
				if len(result) == target {
					return domain.PullRequestPage{PullRequests: result[:limit], NextCursor: nextAfterLimit}, nil
				}
			}
			offset = 0
			if page.NextCursor == "" {
				providerCursor = ""
				break
			}
			if _, repeated := seenProviderCursors[page.NextCursor]; repeated {
				return domain.PullRequestPage{}, fmt.Errorf("pull request pagination did not advance")
			}
			providerCursor = page.NextCursor
		}
	}
	if len(result) > limit {
		result = result[:limit]
	}
	return domain.PullRequestPage{PullRequests: result}, nil
}

func searchPullRequestPage(
	ctx context.Context,
	provider domain.Provider,
	query domain.PullRequestQuery,
) (domain.PullRequestPage, error) {
	if pager, ok := provider.(domain.PullRequestPager); ok {
		return pager.SearchPullRequestsPage(ctx, query)
	}
	if query.Cursor != "" {
		return domain.PullRequestPage{}, fmt.Errorf("pull request provider does not support pagination")
	}
	pullRequests, err := provider.SearchPullRequests(ctx, query)
	return domain.PullRequestPage{PullRequests: pullRequests}, err
}

func filterPullRequestState(pullRequests []domain.PullRequest, state string) []domain.PullRequest {
	if state == "" || strings.EqualFold(state, "all") {
		return pullRequests
	}
	filtered := make([]domain.PullRequest, 0, len(pullRequests))
	for _, pullRequest := range pullRequests {
		if strings.EqualFold(state, pullRequest.State) {
			filtered = append(filtered, pullRequest)
		}
	}
	return filtered
}

func queuePositionAfter(
	repositories []domain.Repository,
	repositoryIndex int,
	query string,
	state string,
	pageInputCursor string,
	nextProviderCursor string,
	nextOffset int,
	pageLength int,
) (string, error) {
	next := workspacePullRequestCursor{
		Version:    workspacePullRequestCursorVersion,
		QueryHash:  workspacePullRequestQueryHash(query, state),
		Repository: workspaceRepositoryIdentity(repositories[repositoryIndex]),
	}
	switch {
	case nextOffset < pageLength:
		next.ProviderCursor = pageInputCursor
		next.Offset = nextOffset
	case nextProviderCursor != "":
		next.ProviderCursor = nextProviderCursor
	case repositoryIndex+1 < len(repositories):
		next.Repository = workspaceRepositoryIdentity(repositories[repositoryIndex+1])
	default:
		return "", nil
	}
	encoded, err := json.Marshal(next)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(encoded), nil
}

func parseWorkspacePullRequestCursor(
	raw string,
	query string,
	state string,
) (workspacePullRequestCursor, bool, error) {
	if raw == "" {
		return workspacePullRequestCursor{}, false, nil
	}
	if len(raw) > 8192 {
		return workspacePullRequestCursor{}, false, fmt.Errorf("pull request queue cursor is invalid")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return workspacePullRequestCursor{}, false, fmt.Errorf("pull request queue cursor is invalid")
	}
	var cursor workspacePullRequestCursor
	if err := json.Unmarshal(decoded, &cursor); err != nil ||
		cursor.Version != workspacePullRequestCursorVersion ||
		cursor.Repository == "" ||
		cursor.QueryHash != workspacePullRequestQueryHash(query, state) ||
		cursor.Offset < 0 || cursor.Offset > 100 {
		return workspacePullRequestCursor{}, false, fmt.Errorf("pull request queue cursor is invalid")
	}
	return cursor, true, nil
}

func workspacePullRequestQueryHash(query string, state string) string {
	normalized := strings.TrimSpace(query) + "\x00" + strings.ToUpper(strings.TrimSpace(state))
	return fmt.Sprintf("%x", sha256.Sum256([]byte(normalized)))
}

func workspaceRepositoryIdentity(repository domain.Repository) string {
	if repository.ProviderScope != "" && repository.ID != "" {
		return repository.ProviderScope + "\x00" + repository.ID
	}
	return repository.Namespace + "/" + repository.Slug
}

func workspaceRepositoryOrderKey(repository domain.Repository) string {
	return workspaceRepositoryIdentity(repository) + "\x00" + repository.Namespace + "/" + repository.Slug
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

func hydrateRepositoryIdentity(
	ctx context.Context, provider domain.Provider, candidate domain.Repository,
) (domain.Repository, error) {
	if candidate.ID != "" && candidate.ProviderScope != "" {
		return candidate, nil
	}
	repositories, err := listAllRepositories(ctx, provider, "")
	if err != nil {
		return domain.Repository{}, err
	}
	for _, repository := range repositories {
		if strings.EqualFold(repository.Namespace, candidate.Namespace) &&
			strings.EqualFold(repository.Slug, candidate.Slug) && repository.ID != "" && repository.ProviderScope != "" {
			return repository, nil
		}
	}
	return domain.Repository{}, fmt.Errorf("repository immutable identity is unavailable")
}

func persistedRepository(
	ctx context.Context,
	provider domain.Provider,
	repositoryID string,
	providerScope string,
) (domain.Repository, error) {
	if strings.TrimSpace(repositoryID) == "" || strings.TrimSpace(providerScope) == "" {
		return domain.Repository{}, fmt.Errorf("repository immutable identity is unavailable")
	}
	repositories, err := listAllRepositories(ctx, provider, "")
	if err != nil {
		return domain.Repository{}, err
	}
	for _, repository := range repositories {
		if repository.ID == repositoryID && repository.ProviderScope == providerScope {
			return repository, nil
		}
	}
	return domain.Repository{}, fmt.Errorf("repository immutable identity is unavailable")
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

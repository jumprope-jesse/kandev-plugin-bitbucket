package cloud

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"

	"kandev-plugin-bitbucket/internal/domain"
)

func (c *Client) Capabilities() domain.Capabilities {
	return domain.Capabilities{domain.CapabilityBranches: true, domain.CapabilityPullRequests: true, domain.CapabilityReview: true, domain.CapabilityApprove: true, domain.CapabilityMerge: true, domain.CapabilityDecline: true, domain.CapabilityComments: true, domain.CapabilityThreadReplies: true, domain.CapabilityBuildStatuses: true, domain.CapabilityBuildActions: false, domain.CapabilityIssues: false}
}

func (c *Client) GetPullRequest(ctx context.Context, repository domain.Repository, number int) (domain.PullRequest, error) {
	if err := validateRepository(repository); err != nil || number <= 0 {
		return domain.PullRequest{}, fmt.Errorf("invalid Cloud pull request")
	}
	endpoint := c.repositoryEndpoint(repository, "pullrequests", fmt.Sprint(number))
	var payload pullRequestPayload
	if err := c.getJSON(ctx, &endpoint, &payload); err != nil {
		return domain.PullRequest{}, err
	}
	pullRequest, err := mapPullRequest(repository, payload)
	pullRequest.Capabilities = c.Capabilities()
	return pullRequest, err
}

func (c *Client) CreatePullRequest(ctx context.Context, input domain.CreatePullRequestInput) (domain.PullRequest, error) {
	if err := validateRepository(input.Repository); err != nil || input.Title == "" || input.Source == "" || input.Destination == "" {
		return domain.PullRequest{}, fmt.Errorf("invalid Cloud pull request input")
	}
	endpoint := c.repositoryEndpoint(input.Repository, "pullrequests")
	var payload pullRequestPayload
	body := map[string]any{"title": input.Title, "description": input.Description, "source": map[string]any{"branch": map[string]string{"name": input.Source}}, "destination": map[string]any{"branch": map[string]string{"name": input.Destination}}, "close_source_branch": input.CloseSourceOnMerge}
	if err := c.json(ctx, http.MethodPost, &endpoint, body, &payload); err != nil {
		return domain.PullRequest{}, err
	}
	pullRequest, err := mapPullRequest(input.Repository, payload)
	pullRequest.Capabilities = c.Capabilities()
	return pullRequest, err
}

func (c *Client) GetReview(ctx context.Context, repository domain.Repository, number int) (domain.Review, error) {
	if err := validateRepository(repository); err != nil || number <= 0 {
		return domain.Review{}, fmt.Errorf("invalid Cloud pull request")
	}
	pullRequestEndpoint := c.repositoryEndpoint(repository, "pullrequests", fmt.Sprint(number))
	var payload pullRequestPayload
	if err := c.getJSON(ctx, &pullRequestEndpoint, &payload); err != nil {
		return domain.Review{}, err
	}
	pr, err := mapPullRequest(repository, payload)
	if err != nil {
		return domain.Review{}, err
	}
	pr.Capabilities = c.Capabilities()
	diffEndpoint := c.repositoryEndpoint(repository, "pullrequests", fmt.Sprint(number), "diff")
	diff, err := c.getText(ctx, &diffEndpoint)
	if err != nil {
		return domain.Review{}, err
	}
	files, err := c.reviewFiles(ctx, repository, number, diff)
	if err != nil {
		return domain.Review{}, err
	}
	commits, err := c.reviewCommits(ctx, repository, number)
	if err != nil {
		return domain.Review{}, err
	}
	comments, err := c.reviewComments(ctx, repository, number)
	if err != nil {
		return domain.Review{}, err
	}
	if !isPathSegment(pr.Source.Commit) {
		return domain.Review{}, fmt.Errorf("Cloud pull request source commit is invalid")
	}
	statuses, err := c.reviewStatuses(ctx, repository, pr.Source.Commit)
	if err != nil {
		return domain.Review{}, err
	}
	viewerID, err := c.currentUserID(ctx)
	if err != nil {
		return domain.Review{}, err
	}
	return domain.Review{
		PullRequest:  pr,
		ViewerID:     viewerID,
		Diff:         diff,
		Files:        files,
		Commits:      commits,
		Participants: mapParticipants(payload.Participants),
		Threads:      comments,
		Statuses:     statuses,
	}, nil
}

func (c *Client) MutatePullRequest(ctx context.Context, repository domain.Repository, number int, input domain.MutationInput) (domain.PullRequest, error) {
	capability, err := input.Kind.Capability()
	if err != nil {
		return domain.PullRequest{}, err
	}
	if !c.Capabilities().Supports(capability) {
		return domain.PullRequest{}, fmt.Errorf("Cloud does not support %s", capability)
	}
	if err := validateRepository(repository); err != nil || number <= 0 {
		return domain.PullRequest{}, fmt.Errorf("invalid Cloud pull request")
	}
	endpoint := c.repositoryEndpoint(repository, "pullrequests", fmt.Sprint(number))
	method, body := http.MethodPost, any(nil)
	switch input.Kind {
	case domain.MutationApprove:
		endpoint.Path = path.Join(endpoint.Path, "approve")
	case domain.MutationUnapprove:
		method = http.MethodDelete
		endpoint.Path = path.Join(endpoint.Path, "approve")
	case domain.MutationMerge:
		endpoint.Path = path.Join(endpoint.Path, "merge")
	case domain.MutationDecline:
		endpoint.Path = path.Join(endpoint.Path, "decline")
	case domain.MutationAddComment, domain.MutationReply:
		if input.Comment == "" {
			return domain.PullRequest{}, fmt.Errorf("Cloud review comment must not be empty")
		}
		endpoint.Path = path.Join(endpoint.Path, "comments")
		body = map[string]any{"content": map[string]string{"raw": input.Comment}}
		if input.Kind == domain.MutationReply {
			parentID, err := parseCommentID(input.ParentCommentID)
			if err != nil {
				return domain.PullRequest{}, err
			}
			body.(map[string]any)["parent"] = map[string]int{"id": parentID}
		}
	}
	if err := c.json(ctx, method, &endpoint, body, nil); err != nil {
		return domain.PullRequest{}, err
	}
	return c.GetPullRequest(ctx, repository, number)
}
func (c *Client) ApplyReviewAction(ctx context.Context, pullRequest domain.PullRequest, action domain.ReviewAction) (domain.PullRequest, error) {
	return c.MutatePullRequest(ctx, pullRequest.Repository, pullRequest.Number, action)
}
func (c *Client) Health(ctx context.Context) error {
	endpoint := *c.apiBase
	endpoint.Path = path.Join(endpoint.Path, "user")
	var value map[string]any
	return c.getJSON(ctx, &endpoint, &value)
}

func (c *Client) currentUserID(ctx context.Context) (string, error) {
	endpoint := *c.apiBase
	endpoint.Path = path.Join(endpoint.Path, "user")
	var value struct {
		AccountID string `json:"account_id"`
	}
	if err := c.getJSON(ctx, &endpoint, &value); err != nil {
		return "", err
	}
	if strings.TrimSpace(value.AccountID) == "" {
		return "", fmt.Errorf("Cloud current user omitted an account id")
	}
	return value.AccountID, nil
}
func (c *Client) ResolveGitCredential(ctx context.Context) (domain.GitCredential, error) {
	if c.tokenSource == nil {
		return domain.GitCredential{}, fmt.Errorf("Cloud token source is not configured")
	}
	token, expiresAt, err := c.accessToken(ctx)
	if err != nil {
		return domain.GitCredential{}, err
	}
	username, err := c.gitUsername()
	if err != nil {
		return domain.GitCredential{}, err
	}
	return domain.GitCredential{Username: username, Secret: token, ExpiresAt: expiresAt}, nil
}

// ListBranches lists matching branches from the Cloud v2 branch endpoint.
func (c *Client) ListBranches(ctx context.Context, repository domain.Repository) ([]domain.Branch, error) {
	return c.listBranches(ctx, repository, "", maxPageLength)
}
func (c *Client) listBranches(ctx context.Context, repository domain.Repository, search string, limit int) ([]domain.Branch, error) {
	if err := validateRepository(repository); err != nil {
		return nil, err
	}
	if limit <= 0 {
		return nil, fmt.Errorf("branch limit must be positive")
	}
	endpoint := c.repositoryEndpoint(repository, "refs", "branches")
	query := endpoint.Query()
	query.Set("pagelen", fmt.Sprint(min(limit, maxPageLength)))
	if search != "" {
		query.Set("q", fmt.Sprintf("name~%q", search))
	}
	endpoint.RawQuery = query.Encode()

	var branches []domain.Branch
	for next := &endpoint; next != nil && len(branches) < limit; {
		var page branchPage
		if err := c.getJSON(ctx, next, &page); err != nil {
			return nil, err
		}
		for _, item := range page.Values {
			if item.Name == "" {
				return nil, fmt.Errorf("Cloud branch omitted a name")
			}
			branches = append(branches, domain.Branch{Name: item.Name, Commit: item.Target.Hash})
			if len(branches) == limit {
				break
			}
		}
		var err error
		next, err = c.nextURL(next, page.Next)
		if err != nil {
			return nil, err
		}
	}
	return branches, nil
}

// SearchPullRequests lists pull requests matching a title search and requested state.
func (c *Client) SearchPullRequests(ctx context.Context, query domain.PullRequestQuery) ([]domain.PullRequest, error) {
	if query.Limit <= 0 {
		return nil, fmt.Errorf("pull request limit must be positive")
	}
	states, err := cloudPullRequestStates(query.State)
	if err != nil {
		return nil, err
	}
	pullRequests := make([]domain.PullRequest, 0, query.Limit)
	seen := make(map[string]struct{})
	for _, state := range states {
		results, searchErr := c.listPullRequestsForState(ctx, query.Repository, query.Text, state, query.Limit)
		if searchErr != nil {
			return nil, searchErr
		}
		for _, pullRequest := range results {
			if _, found := seen[pullRequest.Key()]; found {
				continue
			}
			seen[pullRequest.Key()] = struct{}{}
			pullRequests = append(pullRequests, pullRequest)
		}
	}
	sort.Slice(pullRequests, func(i, j int) bool { return pullRequests[i].Key() < pullRequests[j].Key() })
	if len(pullRequests) > query.Limit {
		return pullRequests[:query.Limit], nil
	}
	return pullRequests, nil
}

// SearchPullRequestsPage returns one bounded Cloud page. NextCursor is an
// opaque, origin-validated API URL and is safe to persist only for this query.
func (c *Client) SearchPullRequestsPage(ctx context.Context, query domain.PullRequestQuery) (domain.PullRequestPage, error) {
	if query.Limit <= 0 {
		return domain.PullRequestPage{}, fmt.Errorf("pull request limit must be positive")
	}
	states, err := cloudPullRequestStates(query.State)
	if err != nil {
		return domain.PullRequestPage{}, err
	}
	if len(states) > 1 {
		return c.searchAllPullRequestsPage(ctx, query, states)
	}
	return c.searchPullRequestsSinglePage(ctx, query, states[0])
}

const cloudAllPageCursorVersion = 1

type cloudAllPageCursor struct {
	Version int    `json:"version"`
	State   int    `json:"state"`
	Cursor  string `json:"cursor,omitempty"`
}

func (c *Client) searchAllPullRequestsPage(ctx context.Context, query domain.PullRequestQuery, states []string) (domain.PullRequestPage, error) {
	cursor, err := parseCloudAllPageCursor(query.Cursor)
	if err != nil {
		return domain.PullRequestPage{}, err
	}
	if cursor.State >= len(states) {
		return domain.PullRequestPage{}, fmt.Errorf("invalid Cloud pull request cursor")
	}
	pageQuery := query
	pageQuery.Cursor = cursor.Cursor
	page, err := c.searchPullRequestsSinglePage(ctx, pageQuery, states[cursor.State])
	if err != nil {
		return domain.PullRequestPage{}, err
	}
	if page.NextCursor != "" {
		page.NextCursor = encodeCloudAllPageCursor(cloudAllPageCursor{Version: cloudAllPageCursorVersion, State: cursor.State, Cursor: page.NextCursor})
		return page, nil
	}
	if cursor.State+1 < len(states) {
		page.NextCursor = encodeCloudAllPageCursor(cloudAllPageCursor{Version: cloudAllPageCursorVersion, State: cursor.State + 1})
	}
	return page, nil
}

func (c *Client) searchPullRequestsSinglePage(ctx context.Context, query domain.PullRequestQuery, state string) (domain.PullRequestPage, error) {
	endpoint, err := c.pullRequestPageEndpoint(query, state)
	if err != nil {
		return domain.PullRequestPage{}, err
	}
	var page pullRequestPage
	if err := c.getJSON(ctx, endpoint, &page); err != nil {
		return domain.PullRequestPage{}, err
	}
	pullRequests := make([]domain.PullRequest, 0, len(page.Values))
	for _, item := range page.Values {
		pullRequest, err := mapPullRequest(query.Repository, item)
		if err != nil {
			return domain.PullRequestPage{}, err
		}
		pullRequest.Capabilities = c.Capabilities()
		pullRequests = append(pullRequests, pullRequest)
	}
	next, err := c.nextURL(endpoint, page.Next)
	if err != nil {
		return domain.PullRequestPage{}, err
	}
	nextCursor := ""
	if next != nil {
		nextCursor = next.String()
	}
	return domain.PullRequestPage{PullRequests: pullRequests, NextCursor: nextCursor}, nil
}

func encodeCloudAllPageCursor(cursor cloudAllPageCursor) string {
	encoded, err := json.Marshal(cursor)
	if err != nil {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(encoded)
}

func parseCloudAllPageCursor(raw string) (cloudAllPageCursor, error) {
	if raw == "" {
		return cloudAllPageCursor{Version: cloudAllPageCursorVersion}, nil
	}
	if len(raw) > 8192 {
		return cloudAllPageCursor{}, fmt.Errorf("invalid Cloud pull request cursor")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return cloudAllPageCursor{}, fmt.Errorf("invalid Cloud pull request cursor")
	}
	var cursor cloudAllPageCursor
	if err := json.Unmarshal(decoded, &cursor); err != nil || cursor.Version != cloudAllPageCursorVersion || cursor.State < 0 {
		return cloudAllPageCursor{}, fmt.Errorf("invalid Cloud pull request cursor")
	}
	return cursor, nil
}

func (c *Client) pullRequestPageEndpoint(query domain.PullRequestQuery, state string) (*url.URL, error) {
	if err := validateRepository(query.Repository); err != nil {
		return nil, err
	}
	if query.Cursor != "" {
		return c.nextURL(c.apiBase, query.Cursor)
	}
	endpoint := c.repositoryEndpoint(query.Repository, "pullrequests")
	parameters := endpoint.Query()
	parameters.Set("state", state)
	parameters.Set("pagelen", fmt.Sprint(min(query.Limit, maxPullRequestPageLength)))
	if query.Text != "" {
		parameters.Set("q", fmt.Sprintf("title~%q", query.Text))
	}
	endpoint.RawQuery = parameters.Encode()
	return &endpoint, nil
}

func (c *Client) listPullRequests(ctx context.Context, repository domain.Repository, search string, limit int) ([]domain.PullRequest, error) {
	return c.listPullRequestsForState(ctx, repository, search, "OPEN", limit)
}

func (c *Client) listPullRequestsForState(ctx context.Context, repository domain.Repository, search, state string, limit int) ([]domain.PullRequest, error) {
	if err := validateRepository(repository); err != nil {
		return nil, err
	}
	if limit <= 0 {
		return nil, fmt.Errorf("pull request limit must be positive")
	}
	endpoint := c.repositoryEndpoint(repository, "pullrequests")
	query := endpoint.Query()
	query.Set("state", state)
	query.Set("pagelen", fmt.Sprint(min(limit, maxPullRequestPageLength)))
	if search != "" {
		query.Set("q", fmt.Sprintf("title~%q", search))
	}
	endpoint.RawQuery = query.Encode()

	var pullRequests []domain.PullRequest
	for next := &endpoint; next != nil && len(pullRequests) < limit; {
		var page pullRequestPage
		if err := c.getJSON(ctx, next, &page); err != nil {
			return nil, err
		}
		for _, item := range page.Values {
			pullRequest, err := mapPullRequest(repository, item)
			if err != nil {
				return nil, err
			}
			pullRequest.Capabilities = c.Capabilities()
			pullRequests = append(pullRequests, pullRequest)
			if len(pullRequests) == limit {
				break
			}
		}
		var err error
		next, err = c.nextURL(next, page.Next)
		if err != nil {
			return nil, err
		}
	}
	return pullRequests, nil
}

func cloudPullRequestStates(raw string) ([]string, error) {
	switch strings.ToUpper(strings.TrimSpace(raw)) {
	case "", "OPEN":
		return []string{"OPEN"}, nil
	case "MERGED", "DECLINED", "SUPERSEDED":
		return []string{strings.ToUpper(strings.TrimSpace(raw))}, nil
	case "ALL":
		return []string{"OPEN", "MERGED", "DECLINED", "SUPERSEDED"}, nil
	default:
		return nil, fmt.Errorf("unsupported Cloud pull request state")
	}
}

type branchPage struct {
	Values []struct {
		Name   string `json:"name"`
		Target struct {
			Hash string `json:"hash"`
		} `json:"target"`
	} `json:"values"`
	Next string `json:"next"`
}

type pullRequestPage struct {
	Values []pullRequestPayload `json:"values"`
	Next   string               `json:"next"`
}

type pullRequestPayload struct {
	ID          int       `json:"id"`
	Title       string    `json:"title"`
	Description string    `json:"description"`
	State       string    `json:"state"`
	CreatedAt   time.Time `json:"created_on"`
	Author      struct {
		AccountID   string `json:"account_id"`
		DisplayName string `json:"display_name"`
	} `json:"author"`
	Links struct {
		HTML struct {
			Href string `json:"href"`
		} `json:"html"`
	} `json:"links"`
	Source struct {
		Branch struct {
			Name string `json:"name"`
		} `json:"branch"`
		Commit struct {
			Hash string `json:"hash"`
		} `json:"commit"`
		Repository *cloudRepositoryReference `json:"repository"`
	} `json:"source"`
	Destination struct {
		Branch struct {
			Name string `json:"name"`
		} `json:"branch"`
		Commit struct {
			Hash string `json:"hash"`
		} `json:"commit"`
		Repository struct {
			MainBranch struct {
				Name string `json:"name"`
			} `json:"mainbranch"`
		} `json:"repository"`
	} `json:"destination"`
	Participants []cloudParticipantPayload `json:"participants"`
}

type cloudRepositoryReference struct {
	Slug      string `json:"slug"`
	FullName  string `json:"full_name"`
	Workspace struct {
		Slug string `json:"slug"`
	} `json:"workspace"`
}

type cloudParticipantPayload struct {
	User struct {
		AccountID   string `json:"account_id"`
		DisplayName string `json:"display_name"`
	} `json:"user"`
	Role     string `json:"role"`
	Approved bool   `json:"approved"`
}

type reviewCommitPage struct {
	Values []struct {
		Hash    string `json:"hash"`
		Message string `json:"message"`
		Author  struct {
			Raw string `json:"raw"`
		} `json:"author"`
	} `json:"values"`
	Next string `json:"next"`
}

type reviewCommentPage struct {
	Values []struct {
		ID        int       `json:"id"`
		CreatedOn time.Time `json:"created_on"`
		Parent    struct {
			ID int `json:"id"`
		} `json:"parent"`
		Content struct {
			Raw string `json:"raw"`
		} `json:"content"`
		User struct {
			DisplayName string `json:"display_name"`
		} `json:"user"`
	} `json:"values"`
	Next string `json:"next"`
}

type reviewStatusPage struct {
	Values []struct {
		Key   string `json:"key"`
		Name  string `json:"name"`
		State string `json:"state"`
		URL   string `json:"url"`
	} `json:"values"`
	Next string `json:"next"`
}

const (
	maxReviewFiles   = 1000
	maxReviewEntries = 1000
	maxReviewPages   = 100
)

type reviewDiffstatPage struct {
	Values []reviewDiffstat `json:"values"`
	Next   string           `json:"next"`
}

type reviewDiffstat struct {
	Status       string `json:"status"`
	LinesAdded   int    `json:"lines_added"`
	LinesRemoved int    `json:"lines_removed"`
	Old          struct {
		Path string `json:"path"`
	} `json:"old"`
	New struct {
		Path string `json:"path"`
	} `json:"new"`
}

func (c *Client) reviewFiles(ctx context.Context, repository domain.Repository, number int, diff string) ([]domain.ReviewFile, error) {
	endpoint := c.repositoryEndpoint(repository, "pullrequests", fmt.Sprint(number), "diffstat")
	query := endpoint.Query()
	query.Set("pagelen", fmt.Sprint(maxPageLength))
	endpoint.RawQuery = query.Encode()

	patches := unifiedPatches(diff)
	files := make([]domain.ReviewFile, 0)
	err := c.forReviewPages(ctx, endpoint, func(next *url.URL) (string, error) {
		var page reviewDiffstatPage
		if err := c.getJSON(ctx, next, &page); err != nil {
			return "", err
		}
		if len(files)+len(page.Values) > maxReviewFiles {
			return "", fmt.Errorf("Cloud review file limit exceeded")
		}
		for _, stat := range page.Values {
			file, err := mapReviewFile(stat, patches)
			if err != nil {
				return "", err
			}
			files = append(files, file)
		}
		return page.Next, nil
	})
	if err != nil {
		return nil, err
	}
	return files, nil
}

func (c *Client) reviewCommits(ctx context.Context, repository domain.Repository, number int) ([]domain.Commit, error) {
	endpoint := c.repositoryEndpoint(repository, "pullrequests", fmt.Sprint(number), "commits")
	commits := make([]domain.Commit, 0)
	err := c.forReviewPages(ctx, endpoint, func(next *url.URL) (string, error) {
		var page reviewCommitPage
		if err := c.getJSON(ctx, next, &page); err != nil {
			return "", err
		}
		if len(commits)+len(page.Values) > maxReviewEntries {
			return "", fmt.Errorf("Cloud review commit limit exceeded")
		}
		commits = append(commits, mapReviewCommits(page)...)
		return page.Next, nil
	})
	return commits, err
}

func (c *Client) reviewComments(ctx context.Context, repository domain.Repository, number int) ([]domain.Thread, error) {
	endpoint := c.repositoryEndpoint(repository, "pullrequests", fmt.Sprint(number), "comments")
	comments := reviewCommentPage{}
	err := c.forReviewPages(ctx, endpoint, func(next *url.URL) (string, error) {
		var page reviewCommentPage
		if err := c.getJSON(ctx, next, &page); err != nil {
			return "", err
		}
		if len(comments.Values)+len(page.Values) > maxReviewEntries {
			return "", fmt.Errorf("Cloud review comment limit exceeded")
		}
		comments.Values = append(comments.Values, page.Values...)
		return page.Next, nil
	})
	if err != nil {
		return nil, err
	}
	return mapReviewThreads(comments), nil
}

func (c *Client) reviewStatuses(ctx context.Context, repository domain.Repository, commit string) ([]domain.BuildStatus, error) {
	endpoint := c.repositoryEndpoint(repository, "commit", commit, "statuses")
	statuses := make([]domain.BuildStatus, 0)
	err := c.forReviewPages(ctx, endpoint, func(next *url.URL) (string, error) {
		var page reviewStatusPage
		if err := c.getJSON(ctx, next, &page); err != nil {
			return "", err
		}
		if len(statuses)+len(page.Values) > maxReviewEntries {
			return "", fmt.Errorf("Cloud review status limit exceeded")
		}
		statuses = append(statuses, mapReviewStatuses(page, commit)...)
		return page.Next, nil
	})
	return statuses, err
}

func (c *Client) forReviewPages(_ context.Context, endpoint url.URL, collect func(*url.URL) (string, error)) error {
	query := endpoint.Query()
	query.Set("pagelen", fmt.Sprint(maxPageLength))
	endpoint.RawQuery = query.Encode()
	seen := make(map[string]struct{})
	for next, pages := &endpoint, 0; next != nil; pages++ {
		if pages >= maxReviewPages {
			return fmt.Errorf("Cloud review pagination limit exceeded")
		}
		key := next.String()
		if _, ok := seen[key]; ok {
			return fmt.Errorf("Cloud review pagination repeated a page")
		}
		seen[key] = struct{}{}
		rawNext, err := collect(next)
		if err != nil {
			return err
		}
		next, err = c.nextURL(next, rawNext)
		if err != nil {
			return err
		}
	}
	return nil
}

func mapReviewFile(stat reviewDiffstat, patches map[string]string) (domain.ReviewFile, error) {
	status, err := reviewFileStatus(stat.Status)
	if err != nil {
		return domain.ReviewFile{}, fmt.Errorf("Cloud review diffstat: %w", err)
	}
	filePath := stat.New.Path
	if filePath == "" {
		filePath = stat.Old.Path
	}
	filePath, err = reviewPath(filePath)
	if err != nil {
		return domain.ReviewFile{}, fmt.Errorf("Cloud review diffstat: %w", err)
	}
	return domain.ReviewFile{Path: filePath, Status: status, Additions: stat.LinesAdded, Deletions: stat.LinesRemoved, Patch: patches[filePath]}, nil
}

func unifiedPatches(diff string) map[string]string {
	patches := make(map[string]string)
	var paths []string
	var patch strings.Builder
	flush := func() {
		if len(paths) == 0 || patch.Len() == 0 {
			return
		}
		value := patch.String()
		for _, filePath := range paths {
			if filePath != "" {
				patches[filePath] = value
			}
		}
	}
	for _, line := range strings.SplitAfter(diff, "\n") {
		if strings.HasPrefix(line, "diff --git ") {
			flush()
			patch.Reset()
			paths = nil
			fields := strings.Fields(strings.TrimSpace(line))
			if len(fields) >= 4 {
				paths = []string{strings.TrimPrefix(fields[2], "a/"), strings.TrimPrefix(fields[3], "b/")}
			}
		}
		patch.WriteString(line)
	}
	flush()
	return patches
}

func reviewFileStatus(status string) (string, error) {
	switch strings.ToLower(status) {
	case "added":
		return "added", nil
	case "modified":
		return "modified", nil
	case "removed", "deleted":
		return "deleted", nil
	case "renamed", "moved":
		return "renamed", nil
	default:
		return "", fmt.Errorf("unknown file status %q", status)
	}
}

func reviewPath(value string) (string, error) {
	clean := path.Clean(value)
	if value == "" || clean == "." || clean == ".." || strings.HasPrefix(clean, "../") || path.IsAbs(value) {
		return "", fmt.Errorf("invalid file path")
	}
	return clean, nil
}

func (c *Client) repositoryEndpoint(repository domain.Repository, elements ...string) url.URL {
	endpoint := *c.apiBase
	segments := append([]string{endpoint.Path, "repositories", repository.Namespace, repository.Slug}, elements...)
	endpoint.Path = path.Join(segments...)
	endpoint.RawPath = ""
	return endpoint
}

func (c *Client) getJSON(ctx context.Context, endpoint *url.URL, target any) error {
	if c.tokenSource == nil {
		return fmt.Errorf("Cloud token source is not configured")
	}
	token, _, err := c.accessToken(ctx)
	if err != nil {
		return fmt.Errorf("resolve Cloud access token: %w", err)
	}
	for attempt := 0; attempt < 3; attempt++ {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
		if err != nil {
			return err
		}
		request.Header.Set("Accept", "application/json")
		if err := c.authorize(request, token); err != nil {
			return err
		}
		response, err := c.httpClient.Do(request)
		if err != nil {
			return fmt.Errorf("request Bitbucket Cloud: %w", err)
		}
		if (response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= http.StatusInternalServerError) && attempt < 2 {
			delay := c.retryDelay(attempt, retryAfter(response.Header.Get("Retry-After")))
			response.Body.Close()
			if err := wait(ctx, delay); err != nil {
				return err
			}
			continue
		}
		if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
			response.Body.Close()
			return fmt.Errorf("Bitbucket Cloud request returned %s", response.Status)
		}
		body, err := readBounded(response.Body, c.maxResponseBytes)
		response.Body.Close()
		if err != nil {
			return err
		}
		if err := json.Unmarshal(body, target); err != nil {
			return fmt.Errorf("decode Bitbucket Cloud response: %w", err)
		}
		return nil
	}
	return fmt.Errorf("Bitbucket Cloud request retry limit exceeded")
}

func (c *Client) getText(ctx context.Context, endpoint *url.URL) (string, error) {
	if c.tokenSource == nil {
		return "", fmt.Errorf("Cloud token source is not configured")
	}
	token, _, err := c.accessToken(ctx)
	if err != nil {
		return "", fmt.Errorf("resolve Cloud access token: %w", err)
	}
	for attempt := 0; attempt < 3; attempt++ {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
		if err != nil {
			return "", err
		}
		request.Header.Set("Accept", "text/plain")
		if err := c.authorize(request, token); err != nil {
			return "", err
		}
		response, err := c.httpClient.Do(request)
		if err != nil {
			return "", fmt.Errorf("request Bitbucket Cloud: %w", err)
		}
		if (response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= http.StatusInternalServerError) && attempt < 2 {
			delay := c.retryDelay(attempt, retryAfter(response.Header.Get("Retry-After")))
			response.Body.Close()
			if err := wait(ctx, delay); err != nil {
				return "", err
			}
			continue
		}
		if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
			response.Body.Close()
			return "", fmt.Errorf("Bitbucket Cloud request returned %s", response.Status)
		}
		body, err := readBounded(response.Body, c.maxResponseBytes)
		response.Body.Close()
		if err != nil {
			return "", err
		}
		return string(body), nil
	}
	return "", fmt.Errorf("Bitbucket Cloud request retry limit exceeded")
}

func (c *Client) json(ctx context.Context, method string, endpoint *url.URL, input any, target any) error {
	var body []byte
	var err error
	if input != nil {
		body, err = json.Marshal(input)
		if err != nil {
			return err
		}
	}
	if c.tokenSource == nil {
		return fmt.Errorf("Cloud token source is not configured")
	}
	token, _, err := c.accessToken(ctx)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	if err := c.authorize(request, token); err != nil {
		return err
	}
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("Bitbucket Cloud request returned %s", response.Status)
	}
	if target == nil {
		return nil
	}
	data, err := readBounded(response.Body, c.maxResponseBytes)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, target)
}

func mapPullRequest(repository domain.Repository, payload pullRequestPayload) (domain.PullRequest, error) {
	if payload.ID <= 0 || payload.Title == "" || payload.Source.Branch.Name == "" || payload.Destination.Branch.Name == "" {
		return domain.PullRequest{}, fmt.Errorf("Cloud pull request is incomplete")
	}
	if repository.DefaultBranch == "" {
		repository.DefaultBranch = payload.Destination.Repository.MainBranch.Name
	}
	if repository.CloneURL == nil {
		cloneURL, err := url.Parse("https://bitbucket.org")
		if err != nil {
			return domain.PullRequest{}, err
		}
		cloneURL.Path = "/" + path.Join(repository.Namespace, repository.Slug+".git")
		repository.CloneURL = cloneURL
	}
	if err := validatePullRequestURL(payload.Links.HTML.Href, repository, payload.ID); err != nil {
		return domain.PullRequest{}, err
	}
	sourceRepository, err := mapSourceRepository(payload.Source.Repository, repository)
	if err != nil {
		return domain.PullRequest{}, err
	}
	return domain.PullRequest{
		Repository:        repository,
		SourceRepository:  sourceRepository,
		Number:            payload.ID,
		Title:             payload.Title,
		Description:       payload.Description,
		State:             payload.State,
		Author:            payload.Author.AccountID,
		AuthorDisplayName: payload.Author.DisplayName,
		CreatedAt:         payload.CreatedAt,
		URL:               payload.Links.HTML.Href,
		Source:            domain.Branch{Name: payload.Source.Branch.Name, Commit: payload.Source.Commit.Hash},
		Destination:       domain.Branch{Name: payload.Destination.Branch.Name, Commit: payload.Destination.Commit.Hash},
	}, nil
}

func mapSourceRepository(payload *cloudRepositoryReference, fallback domain.Repository) (domain.Repository, error) {
	if payload == nil {
		return fallback, nil
	}
	namespace, slug := payload.Workspace.Slug, payload.Slug
	if !isPathSegment(namespace) || !isPathSegment(slug) {
		parts := strings.Split(payload.FullName, "/")
		if len(parts) == 2 {
			namespace, slug = parts[0], parts[1]
		}
	}
	if !isPathSegment(namespace) || !isPathSegment(slug) {
		return domain.Repository{}, fmt.Errorf("Cloud pull request source repository is incomplete")
	}
	cloneURL, err := url.Parse("https://bitbucket.org")
	if err != nil {
		return domain.Repository{}, err
	}
	cloneURL.Path = "/" + path.Join(namespace, slug+".git")
	return domain.Repository{Namespace: namespace, Slug: slug, CloneURL: cloneURL}, nil
}

func validatePullRequestURL(raw string, repository domain.Repository, number int) error {
	value, err := url.Parse(raw)
	if err != nil || value.Scheme != "https" || value.User != nil || value.Host != "bitbucket.org" || value.RawQuery != "" || value.Fragment != "" {
		return fmt.Errorf("Cloud pull request has invalid HTML URL")
	}
	expectedPath := "/" + path.Join(repository.Namespace, repository.Slug, "pull-requests", fmt.Sprint(number))
	if value.Path != expectedPath {
		return fmt.Errorf("Cloud pull request has invalid HTML URL")
	}
	return nil
}

func mapParticipants(values []cloudParticipantPayload) []domain.Participant {
	participants := make([]domain.Participant, 0, len(values))
	for _, value := range values {
		participants = append(participants, domain.Participant{ID: value.User.AccountID, Name: value.User.DisplayName, Role: value.Role, Approved: value.Approved})
	}
	return participants
}

func mapReviewCommits(page reviewCommitPage) []domain.Commit {
	commits := make([]domain.Commit, 0, len(page.Values))
	for _, commit := range page.Values {
		commits = append(commits, domain.Commit{Hash: commit.Hash, Message: commit.Message, Author: commit.Author.Raw})
	}
	return commits
}

func mapReviewThreads(page reviewCommentPage) []domain.Thread {
	threads := make([]domain.Thread, 0, len(page.Values))
	byRoot := make(map[string]int, len(page.Values))
	for _, value := range page.Values {
		if value.Parent.ID != 0 {
			continue
		}
		id := fmt.Sprint(value.ID)
		byRoot[id] = len(threads)
		threads = append(threads, domain.Thread{ID: id, Comments: []domain.Comment{{ID: id, Author: value.User.DisplayName, Body: value.Content.Raw, When: value.CreatedOn}}})
	}
	for _, value := range page.Values {
		if value.Parent.ID == 0 {
			continue
		}
		parentID := fmt.Sprint(value.Parent.ID)
		index, ok := byRoot[parentID]
		if !ok {
			index = len(threads)
			byRoot[parentID] = index
			threads = append(threads, domain.Thread{ID: parentID})
		}
		threads[index].Comments = append(threads[index].Comments, domain.Comment{ID: fmt.Sprint(value.ID), ParentID: parentID, Author: value.User.DisplayName, Body: value.Content.Raw, When: value.CreatedOn})
	}
	return threads
}

func mapReviewStatuses(page reviewStatusPage, target string) []domain.BuildStatus {
	statuses := make([]domain.BuildStatus, 0, len(page.Values))
	for _, status := range page.Values {
		statuses = append(statuses, domain.BuildStatus{Key: status.Key, Name: status.Name, State: status.State, URL: status.URL, Target: target})
	}
	return statuses
}

func validateRepository(repository domain.Repository) error {
	if !isPathSegment(repository.Namespace) || !isPathSegment(repository.Slug) {
		return fmt.Errorf("repository namespace and slug must be URL path segments")
	}
	return nil
}

func parseCommentID(value string) (int, error) {
	id, err := strconv.Atoi(value)
	if err != nil || id <= 0 {
		return 0, fmt.Errorf("review reply parent comment id must be a positive integer")
	}
	return id, nil
}

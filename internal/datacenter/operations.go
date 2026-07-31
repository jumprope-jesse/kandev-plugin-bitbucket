package datacenter

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"

	"kandev-plugin-bitbucket/internal/domain"
)

func (c *Client) Capabilities() domain.Capabilities {
	c.capabilitiesMu.RLock()
	if c.probedCapabilities != nil {
		capabilities := cloneCapabilities(c.probedCapabilities)
		c.capabilitiesMu.RUnlock()
		return capabilities
	}
	c.capabilitiesMu.RUnlock()
	return c.capabilitiesForVersion("")
}

func (c *Client) GetPullRequest(ctx context.Context, repository domain.Repository, number int) (domain.PullRequest, error) {
	if !c.Capabilities().Supports(domain.CapabilityPullRequests) {
		return domain.PullRequest{}, fmt.Errorf("Data Center does not support %s for this authentication mode", domain.CapabilityPullRequests)
	}
	if err := validateRepository(repository); err != nil || number <= 0 {
		return domain.PullRequest{}, fmt.Errorf("invalid Data Center pull request")
	}
	endpoint := c.repositoryEndpoint(repository, "pull-requests", fmt.Sprint(number))
	var payload pullRequestPayload
	if err := c.getJSON(ctx, &endpoint, &payload); err != nil {
		return domain.PullRequest{}, err
	}
	pullRequest, err := c.mapPullRequest(repository, payload)
	pullRequest.Capabilities = c.Capabilities()
	return pullRequest, err
}

func (c *Client) CreatePullRequest(ctx context.Context, input domain.CreatePullRequestInput) (domain.PullRequest, error) {
	if !c.Capabilities().Supports(domain.CapabilityPullRequests) {
		return domain.PullRequest{}, fmt.Errorf("Data Center does not support %s for this authentication mode", domain.CapabilityPullRequests)
	}
	if err := validateRepository(input.Repository); err != nil || input.Title == "" || input.Source == "" || input.Destination == "" {
		return domain.PullRequest{}, fmt.Errorf("invalid Data Center pull request input")
	}
	endpoint := c.repositoryEndpoint(input.Repository, "pull-requests")
	body := map[string]any{"title": input.Title, "description": input.Description, "fromRef": map[string]string{"id": "refs/heads/" + input.Source}, "toRef": map[string]string{"id": "refs/heads/" + input.Destination}}
	var payload pullRequestPayload
	if err := c.json(ctx, http.MethodPost, &endpoint, body, &payload); err != nil {
		return domain.PullRequest{}, err
	}
	pullRequest, err := c.mapPullRequest(input.Repository, payload)
	pullRequest.Capabilities = c.Capabilities()
	return pullRequest, err
}

func (c *Client) GetReview(ctx context.Context, repository domain.Repository, number int) (domain.Review, error) {
	if !c.Capabilities().Supports(domain.CapabilityReview) {
		return domain.Review{}, fmt.Errorf("Data Center does not support %s for this authentication mode", domain.CapabilityReview)
	}
	if err := validateRepository(repository); err != nil || number <= 0 {
		return domain.Review{}, fmt.Errorf("invalid Data Center pull request")
	}
	pullRequestEndpoint := c.repositoryEndpoint(repository, "pull-requests", fmt.Sprint(number))
	var payload pullRequestPayload
	if err := c.getJSON(ctx, &pullRequestEndpoint, &payload); err != nil {
		return domain.Review{}, err
	}
	pr, err := c.mapPullRequest(repository, payload)
	if err != nil {
		return domain.Review{}, err
	}
	pr.Capabilities = c.Capabilities()
	diffEndpoint := c.repositoryEndpoint(repository, "pull-requests", fmt.Sprint(number)+".diff")
	diff, err := c.getText(ctx, &diffEndpoint)
	if err != nil {
		return domain.Review{}, err
	}
	files, err := c.reviewFiles(ctx, repository, number)
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
	if !isPathSegment(pr.Destination.Commit) {
		return domain.Review{}, fmt.Errorf("Data Center pull request destination commit is invalid")
	}
	statuses, err := c.reviewStatuses(ctx, pr.Destination.Commit)
	if err != nil {
		return domain.Review{}, err
	}
	return domain.Review{
		PullRequest:  pr,
		Diff:         diff,
		Files:        files,
		Commits:      commits,
		Participants: mapParticipants(payload.Participants),
		Threads:      mapReviewThreads(comments),
		Statuses:     statuses,
	}, nil
}

func (c *Client) MutatePullRequest(ctx context.Context, repository domain.Repository, number int, input domain.MutationInput) (domain.PullRequest, error) {
	capability, err := input.Kind.Capability()
	if err != nil {
		return domain.PullRequest{}, err
	}
	if !c.Capabilities().Supports(capability) {
		return domain.PullRequest{}, fmt.Errorf("Data Center does not support %s", capability)
	}
	version := 0
	if input.Kind == domain.MutationMerge || input.Kind == domain.MutationDecline {
		pullRequest, err := c.GetPullRequest(ctx, repository, number)
		if err != nil {
			return domain.PullRequest{}, err
		}
		version = pullRequest.Version
	}
	return c.mutatePullRequest(ctx, repository, number, version, input)
}

func (c *Client) mutatePullRequest(ctx context.Context, repository domain.Repository, number, version int, input domain.MutationInput) (domain.PullRequest, error) {
	capability, err := input.Kind.Capability()
	if err != nil {
		return domain.PullRequest{}, err
	}
	if !c.Capabilities().Supports(capability) {
		return domain.PullRequest{}, fmt.Errorf("Data Center does not support %s", capability)
	}
	if err := validateRepository(repository); err != nil || number <= 0 {
		return domain.PullRequest{}, fmt.Errorf("invalid Data Center pull request")
	}
	endpoint := c.repositoryEndpoint(repository, "pull-requests", fmt.Sprint(number))
	method, body := http.MethodPost, any(nil)
	switch input.Kind {
	case domain.MutationApprove:
		endpoint.Path = path.Join(endpoint.Path, "approve")
	case domain.MutationUnapprove:
		method = http.MethodDelete
		endpoint.Path = path.Join(endpoint.Path, "approve")
	case domain.MutationMerge:
		if version <= 0 {
			return domain.PullRequest{}, fmt.Errorf("Data Center pull request version is required to merge")
		}
		endpoint.Path = path.Join(endpoint.Path, "merge")
		query := endpoint.Query()
		query.Set("version", fmt.Sprint(version))
		endpoint.RawQuery = query.Encode()
	case domain.MutationDecline:
		if version <= 0 {
			return domain.PullRequest{}, fmt.Errorf("Data Center pull request version is required to decline")
		}
		endpoint.Path = path.Join(endpoint.Path, "decline")
		query := endpoint.Query()
		query.Set("version", fmt.Sprint(version))
		endpoint.RawQuery = query.Encode()
	case domain.MutationAddComment, domain.MutationReply:
		if input.Comment == "" {
			return domain.PullRequest{}, fmt.Errorf("Data Center review comment must not be empty")
		}
		endpoint.Path = path.Join(endpoint.Path, "comments")
		body = map[string]any{"text": input.Comment}
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
func (c *Client) Health(ctx context.Context) error { _, err := c.Probe(ctx); return err }
func (c *Client) ResolveGitCredential(ctx context.Context) (domain.GitCredential, error) {
	if c.tokenSource == nil {
		return domain.GitCredential{}, fmt.Errorf("Data Center token source is not configured")
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

// ListBranches lists matching Data Center branches using start/limit pagination.
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
	endpoint := c.repositoryEndpoint(repository, "branches")
	var branches []domain.Branch
	for start := 0; len(branches) < limit; {
		query := endpoint.Query()
		query.Set("start", fmt.Sprint(start))
		query.Set("limit", fmt.Sprint(min(limit, maxPageLength)))
		if search != "" {
			query.Set("filterText", search)
		}
		endpoint.RawQuery = query.Encode()
		var page branchPage
		if err := c.getJSON(ctx, &endpoint, &page); err != nil {
			return nil, err
		}
		for _, item := range page.Values {
			if item.DisplayID == "" {
				return nil, fmt.Errorf("Data Center branch omitted a display id")
			}
			branches = append(branches, domain.Branch{Name: item.DisplayID, Commit: item.LatestCommit, IsDefault: item.IsDefault})
			if len(branches) == limit {
				break
			}
		}
		if page.IsLastPage {
			break
		}
		if page.NextPageStart <= start {
			return nil, fmt.Errorf("Data Center branch pagination did not advance")
		}
		start = page.NextPageStart
	}
	return branches, nil
}

// SearchPullRequests lists Data Center pull requests by title search and requested state.
func (c *Client) SearchPullRequests(ctx context.Context, query domain.PullRequestQuery) ([]domain.PullRequest, error) {
	if !c.Capabilities().Supports(domain.CapabilityPullRequests) {
		return nil, fmt.Errorf("Data Center does not support %s for this authentication mode", domain.CapabilityPullRequests)
	}
	state, err := dataCenterPullRequestState(query.State)
	if err != nil {
		return nil, err
	}
	return c.listPullRequestsForState(ctx, query.Repository, query.Text, state, query.Limit)
}

// SearchPullRequestsPage returns one bounded Data Center page. NextCursor is
// the server-issued nextPageStart value and callers must treat it as opaque.
func (c *Client) SearchPullRequestsPage(ctx context.Context, query domain.PullRequestQuery) (domain.PullRequestPage, error) {
	if !c.Capabilities().Supports(domain.CapabilityPullRequests) {
		return domain.PullRequestPage{}, fmt.Errorf("Data Center does not support %s for this authentication mode", domain.CapabilityPullRequests)
	}
	state, err := dataCenterPullRequestState(query.State)
	if err != nil {
		return domain.PullRequestPage{}, err
	}
	if err := validateRepository(query.Repository); err != nil || query.Limit <= 0 {
		return domain.PullRequestPage{}, fmt.Errorf("invalid Data Center pull request query")
	}
	start := 0
	if query.Cursor != "" {
		start, err = strconv.Atoi(query.Cursor)
		if err != nil || start < 0 {
			return domain.PullRequestPage{}, fmt.Errorf("invalid Data Center pull request cursor")
		}
	}
	endpoint := c.repositoryEndpoint(query.Repository, "pull-requests")
	parameters := endpoint.Query()
	parameters.Set("state", state)
	parameters.Set("start", fmt.Sprint(start))
	parameters.Set("limit", fmt.Sprint(min(query.Limit, maxPageLength)))
	if query.Text != "" {
		parameters.Set("filterText", query.Text)
	}
	endpoint.RawQuery = parameters.Encode()
	var page pullRequestPage
	if err := c.getJSON(ctx, &endpoint, &page); err != nil {
		return domain.PullRequestPage{}, err
	}
	pullRequests := make([]domain.PullRequest, 0, len(page.Values))
	for _, item := range page.Values {
		pullRequest, err := c.mapPullRequest(query.Repository, item)
		if err != nil {
			return domain.PullRequestPage{}, err
		}
		pullRequest.Capabilities = c.Capabilities()
		pullRequests = append(pullRequests, pullRequest)
	}
	nextCursor := ""
	if !page.IsLastPage {
		if page.NextPageStart <= start {
			return domain.PullRequestPage{}, fmt.Errorf("Data Center pull request pagination did not advance")
		}
		nextCursor = fmt.Sprint(page.NextPageStart)
	}
	return domain.PullRequestPage{PullRequests: pullRequests, NextCursor: nextCursor}, nil
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
	endpoint := c.repositoryEndpoint(repository, "pull-requests")
	var pullRequests []domain.PullRequest
	for start := 0; len(pullRequests) < limit; {
		query := endpoint.Query()
		query.Set("state", state)
		query.Set("start", fmt.Sprint(start))
		query.Set("limit", fmt.Sprint(min(limit, maxPageLength)))
		if search != "" {
			query.Set("filterText", search)
		}
		endpoint.RawQuery = query.Encode()
		var page pullRequestPage
		if err := c.getJSON(ctx, &endpoint, &page); err != nil {
			return nil, err
		}
		for _, item := range page.Values {
			pullRequest, err := c.mapPullRequest(repository, item)
			if err != nil {
				return nil, err
			}
			pullRequest.Capabilities = c.Capabilities()
			pullRequests = append(pullRequests, pullRequest)
			if len(pullRequests) == limit {
				break
			}
		}
		if page.IsLastPage {
			break
		}
		if page.NextPageStart <= start {
			return nil, fmt.Errorf("Data Center pull request pagination did not advance")
		}
		start = page.NextPageStart
	}
	return pullRequests, nil
}

func dataCenterPullRequestState(raw string) (string, error) {
	switch state := strings.ToUpper(strings.TrimSpace(raw)); state {
	case "", "OPEN":
		return "OPEN", nil
	case "MERGED", "DECLINED", "ALL":
		return state, nil
	default:
		return "", fmt.Errorf("unsupported Data Center pull request state")
	}
}

type branchPage struct {
	IsLastPage    bool `json:"isLastPage"`
	NextPageStart int  `json:"nextPageStart"`
	Values        []struct {
		DisplayID    string `json:"displayId"`
		LatestCommit string `json:"latestCommit"`
		IsDefault    bool   `json:"isDefault"`
	} `json:"values"`
}

type pullRequestPage struct {
	IsLastPage    bool                 `json:"isLastPage"`
	NextPageStart int                  `json:"nextPageStart"`
	Values        []pullRequestPayload `json:"values"`
}

type pullRequestPayload struct {
	ID          int    `json:"id"`
	Version     int    `json:"version"`
	Title       string `json:"title"`
	Description string `json:"description"`
	State       string `json:"state"`
	Author      struct {
		Slug string `json:"slug"`
	} `json:"author"`
	Links struct {
		Self []struct {
			Href string `json:"href"`
		} `json:"self"`
	} `json:"links"`
	FromRef struct {
		DisplayID    string                         `json:"displayId"`
		LatestCommit string                         `json:"latestCommit"`
		Repository   *dataCenterRepositoryReference `json:"repository"`
	} `json:"fromRef"`
	ToRef struct {
		DisplayID    string `json:"displayId"`
		LatestCommit string `json:"latestCommit"`
		Repository   struct {
			DefaultBranch string `json:"defaultBranch"`
		} `json:"repository"`
	} `json:"toRef"`
	Participants []dataCenterParticipantPayload `json:"participants"`
}

type dataCenterRepositoryReference struct {
	Slug    string `json:"slug"`
	Project struct {
		Key string `json:"key"`
	} `json:"project"`
}

type dataCenterParticipantPayload struct {
	User struct {
		Slug        string `json:"slug"`
		DisplayName string `json:"displayName"`
	} `json:"user"`
	Role   string `json:"role"`
	Status string `json:"status"`
}

type reviewCommitPage struct {
	IsLastPage    bool `json:"isLastPage"`
	NextPageStart int  `json:"nextPageStart"`
	Values        []struct {
		ID      string `json:"id"`
		Message string `json:"message"`
		Author  struct {
			Name string `json:"name"`
		} `json:"author"`
	} `json:"values"`
}

type reviewActivityPage struct {
	IsLastPage    bool             `json:"isLastPage"`
	NextPageStart int              `json:"nextPageStart"`
	Values        []reviewActivity `json:"values"`
}

type reviewActivity struct {
	Action  string         `json:"action"`
	Comment *reviewComment `json:"comment"`
}

type reviewComment struct {
	ID     int `json:"id"`
	Parent struct {
		ID int `json:"id"`
	} `json:"parent"`
	Text   string `json:"text"`
	Author struct {
		DisplayName string `json:"displayName"`
	} `json:"author"`
}

type reviewStatusPage struct {
	IsLastPage    bool `json:"isLastPage"`
	NextPageStart int  `json:"nextPageStart"`
	Values        []struct {
		Key   string `json:"key"`
		Name  string `json:"name"`
		State string `json:"state"`
		URL   string `json:"url"`
	} `json:"values"`
}

type reviewChangesPage struct {
	IsLastPage    bool           `json:"isLastPage"`
	NextPageStart int            `json:"nextPageStart"`
	Values        []reviewChange `json:"values"`
}

type reviewChange struct {
	Type    string       `json:"type"`
	Path    reviewPath   `json:"path"`
	SrcPath reviewPath   `json:"srcPath"`
	Hunks   []reviewHunk `json:"hunks"`
}

type reviewPath struct {
	String string `json:"toString"`
}

type reviewHunk struct {
	SourceLine      int             `json:"sourceLine"`
	SourceSpan      int             `json:"sourceSpan"`
	DestinationLine int             `json:"destinationLine"`
	DestinationSpan int             `json:"destinationSpan"`
	Segments        []reviewSegment `json:"segments"`
}

type reviewSegment struct {
	Type  string           `json:"type"`
	Lines []reviewDiffLine `json:"lines"`
}

type reviewDiffLine struct {
	Line string `json:"line"`
}

const (
	maxReviewComments = 1000
	maxReviewEntries  = 1000
	maxReviewPages    = 100
)

func (c *Client) reviewCommits(ctx context.Context, repository domain.Repository, number int) ([]domain.Commit, error) {
	endpoint := c.repositoryEndpoint(repository, "pull-requests", fmt.Sprint(number), "commits")
	commits := make([]domain.Commit, 0)
	for start, pages := 0, 0; ; {
		if pages >= maxReviewPages {
			return nil, fmt.Errorf("Data Center review commit pagination limit exceeded")
		}
		query := endpoint.Query()
		query.Set("start", fmt.Sprint(start))
		query.Set("limit", fmt.Sprint(maxPageLength))
		endpoint.RawQuery = query.Encode()
		var page reviewCommitPage
		if err := c.getJSON(ctx, &endpoint, &page); err != nil {
			return nil, err
		}
		if len(commits)+len(page.Values) > maxReviewEntries {
			return nil, fmt.Errorf("Data Center review commit limit exceeded")
		}
		commits = append(commits, mapReviewCommits(page)...)
		pages++
		if page.IsLastPage {
			return commits, nil
		}
		if page.NextPageStart <= start {
			return nil, fmt.Errorf("Data Center review commit pagination did not advance")
		}
		start = page.NextPageStart
	}
}

func (c *Client) reviewStatuses(ctx context.Context, commit string) ([]domain.BuildStatus, error) {
	endpoint := c.buildStatusEndpoint(commit)
	statuses := make([]domain.BuildStatus, 0)
	for start, pages := 0, 0; ; {
		if pages >= maxReviewPages {
			return nil, fmt.Errorf("Data Center review status pagination limit exceeded")
		}
		query := endpoint.Query()
		query.Set("start", fmt.Sprint(start))
		query.Set("limit", fmt.Sprint(maxPageLength))
		endpoint.RawQuery = query.Encode()
		var page reviewStatusPage
		if err := c.getJSON(ctx, &endpoint, &page); err != nil {
			return nil, err
		}
		if len(statuses)+len(page.Values) > maxReviewEntries {
			return nil, fmt.Errorf("Data Center review status limit exceeded")
		}
		statuses = append(statuses, mapReviewStatuses(page, commit)...)
		pages++
		if page.IsLastPage {
			return statuses, nil
		}
		if page.NextPageStart <= start {
			return nil, fmt.Errorf("Data Center review status pagination did not advance")
		}
		start = page.NextPageStart
	}
}

func (c *Client) reviewFiles(ctx context.Context, repository domain.Repository, number int) ([]domain.ReviewFile, error) {
	endpoint := c.repositoryEndpoint(repository, "pull-requests", fmt.Sprint(number), "changes")
	files := make([]domain.ReviewFile, 0)
	for start, pages := 0, 0; ; {
		if pages >= maxReviewPages {
			return nil, fmt.Errorf("Data Center review change pagination limit exceeded")
		}
		query := endpoint.Query()
		query.Set("start", fmt.Sprint(start))
		query.Set("limit", fmt.Sprint(maxPageLength))
		endpoint.RawQuery = query.Encode()
		var page reviewChangesPage
		if err := c.getJSON(ctx, &endpoint, &page); err != nil {
			return nil, err
		}
		if len(files)+len(page.Values) > maxReviewEntries {
			return nil, fmt.Errorf("Data Center review file limit exceeded")
		}
		mapped, err := mapReviewFiles(page)
		if err != nil {
			return nil, err
		}
		files = append(files, mapped...)
		pages++
		if page.IsLastPage {
			return files, nil
		}
		if page.NextPageStart <= start {
			return nil, fmt.Errorf("Data Center review change pagination did not advance")
		}
		start = page.NextPageStart
	}
}

func (c *Client) reviewComments(ctx context.Context, repository domain.Repository, number int) ([]reviewComment, error) {
	endpoint := c.repositoryEndpoint(repository, "pull-requests", fmt.Sprint(number), "activities")
	comments := make([]reviewComment, 0)
	for start, pages := 0, 0; ; {
		if pages >= maxReviewPages {
			return nil, fmt.Errorf("Data Center review activity pagination limit exceeded")
		}
		query := endpoint.Query()
		query.Set("withComments", "true")
		query.Set("start", fmt.Sprint(start))
		query.Set("limit", fmt.Sprint(maxPageLength))
		endpoint.RawQuery = query.Encode()
		var page reviewActivityPage
		if err := c.getJSON(ctx, &endpoint, &page); err != nil {
			return nil, err
		}
		for _, activity := range page.Values {
			if activity.Action != "COMMENTED" || activity.Comment == nil || activity.Comment.ID <= 0 {
				continue
			}
			if len(comments) == maxReviewComments {
				return nil, fmt.Errorf("Data Center review comment limit exceeded")
			}
			comments = append(comments, *activity.Comment)
		}
		pages++
		if page.IsLastPage {
			return comments, nil
		}
		if page.NextPageStart <= start {
			return nil, fmt.Errorf("Data Center review activity pagination did not advance")
		}
		start = page.NextPageStart
	}
}

func mapReviewFiles(page reviewChangesPage) ([]domain.ReviewFile, error) {
	if len(page.Values) > maxPageLength {
		return nil, fmt.Errorf("Data Center review file limit exceeded")
	}
	files := make([]domain.ReviewFile, 0, len(page.Values))
	for _, change := range page.Values {
		status, err := reviewFileStatus(change.Type)
		if err != nil {
			return nil, fmt.Errorf("Data Center review change: %w", err)
		}
		sourcePath, err := normalizeReviewPath(change.SrcPath.String)
		if change.SrcPath.String != "" && err != nil {
			return nil, fmt.Errorf("Data Center review change: %w", err)
		}
		destinationPath, err := normalizeReviewPath(change.Path.String)
		if change.Path.String != "" && err != nil {
			return nil, fmt.Errorf("Data Center review change: %w", err)
		}
		filePath := destinationPath
		if status == "deleted" || filePath == "" {
			filePath = sourcePath
		}
		if filePath == "" {
			return nil, fmt.Errorf("Data Center review change: invalid file path")
		}
		if status == "added" {
			sourcePath = ""
		}
		if status == "deleted" {
			destinationPath = ""
		}
		patch, additions, deletions := renderReviewPatch(sourcePath, destinationPath, change.Hunks)
		files = append(files, domain.ReviewFile{Path: filePath, Status: status, Additions: additions, Deletions: deletions, Patch: patch})
	}
	return files, nil
}

func reviewFileStatus(status string) (string, error) {
	switch strings.ToUpper(status) {
	case "ADD", "ADDED", "COPY", "COPIED":
		return "added", nil
	case "MODIFY", "MODIFIED":
		return "modified", nil
	case "DELETE", "DELETED":
		return "deleted", nil
	case "MOVE", "MOVED", "RENAME", "RENAMED":
		return "renamed", nil
	default:
		return "", fmt.Errorf("unknown file status %q", status)
	}
}

func normalizeReviewPath(value string) (string, error) {
	clean := path.Clean(value)
	if value == "" || clean == "." || clean == ".." || strings.HasPrefix(clean, "../") || path.IsAbs(value) {
		return "", fmt.Errorf("invalid file path")
	}
	return clean, nil
}

func renderReviewPatch(sourcePath, destinationPath string, hunks []reviewHunk) (string, int, int) {
	var patch strings.Builder
	if sourcePath == "" {
		patch.WriteString("--- /dev/null\n")
	} else {
		fmt.Fprintf(&patch, "--- a/%s\n", sourcePath)
	}
	if destinationPath == "" {
		patch.WriteString("+++ /dev/null\n")
	} else {
		fmt.Fprintf(&patch, "+++ b/%s\n", destinationPath)
	}
	additions, deletions := 0, 0
	for _, hunk := range hunks {
		fmt.Fprintf(&patch, "@@ -%d,%d +%d,%d @@\n", hunk.SourceLine, hunk.SourceSpan, hunk.DestinationLine, hunk.DestinationSpan)
		for _, segment := range hunk.Segments {
			prefix := " "
			switch strings.ToUpper(segment.Type) {
			case "ADDED":
				prefix = "+"
				additions += len(segment.Lines)
			case "REMOVED":
				prefix = "-"
				deletions += len(segment.Lines)
			}
			for _, line := range segment.Lines {
				patch.WriteString(prefix)
				patch.WriteString(line.Line)
				patch.WriteByte('\n')
			}
		}
	}
	return patch.String(), additions, deletions
}

func (c *Client) repositoryEndpoint(repository domain.Repository, elements ...string) url.URL {
	endpoint := *c.connection.APIBase
	segments := append([]string{endpoint.Path, "projects", repository.Namespace, "repos", repository.Slug}, elements...)
	endpoint.Path = path.Join(segments...)
	endpoint.RawPath = ""
	return endpoint
}

func (c *Client) buildStatusEndpoint(commit string) url.URL {
	endpoint := *c.connection.APIBase
	contextPath := strings.TrimSuffix(endpoint.Path, "/rest/api/latest")
	endpoint.Path = path.Join(contextPath, "rest", "build-status", "latest", "commits", commit)
	endpoint.RawPath = ""
	return endpoint
}

func (c *Client) getJSON(ctx context.Context, endpoint *url.URL, target any) error {
	if c.tokenSource == nil {
		return fmt.Errorf("Data Center token source is not configured")
	}
	token, _, err := c.accessToken(ctx)
	if err != nil {
		return fmt.Errorf("resolve Data Center access token: %w", err)
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
			return fmt.Errorf("request Bitbucket Data Center: %w", err)
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
			return fmt.Errorf("Bitbucket Data Center request returned %s", response.Status)
		}
		body, err := readBounded(response.Body, c.maxResponseBytes)
		response.Body.Close()
		if err != nil {
			return err
		}
		if err := json.Unmarshal(body, target); err != nil {
			return fmt.Errorf("decode Bitbucket Data Center response: %w", err)
		}
		return nil
	}
	return fmt.Errorf("Bitbucket Data Center request retry limit exceeded")
}

func (c *Client) getText(ctx context.Context, endpoint *url.URL) (string, error) {
	if c.tokenSource == nil {
		return "", fmt.Errorf("Data Center token source is not configured")
	}
	token, _, err := c.accessToken(ctx)
	if err != nil {
		return "", fmt.Errorf("resolve Data Center access token: %w", err)
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
			return "", fmt.Errorf("request Bitbucket Data Center: %w", err)
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
			return "", fmt.Errorf("Bitbucket Data Center request returned %s", response.Status)
		}
		body, err := readBounded(response.Body, c.maxResponseBytes)
		response.Body.Close()
		if err != nil {
			return "", err
		}
		return string(body), nil
	}
	return "", fmt.Errorf("Bitbucket Data Center request retry limit exceeded")
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
		return fmt.Errorf("Data Center token source is not configured")
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
		return fmt.Errorf("Bitbucket Data Center request returned %s", response.Status)
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

func (c *Client) mapPullRequest(repository domain.Repository, payload pullRequestPayload) (domain.PullRequest, error) {
	if payload.ID <= 0 || payload.Title == "" || payload.FromRef.DisplayID == "" || payload.ToRef.DisplayID == "" {
		return domain.PullRequest{}, fmt.Errorf("Data Center pull request is incomplete")
	}
	if repository.DefaultBranch == "" {
		repository.DefaultBranch = payload.ToRef.Repository.DefaultBranch
	}
	if repository.CloneURL == nil {
		cloneURL, err := c.connection.CloneURL(repository)
		if err != nil {
			return domain.PullRequest{}, err
		}
		repository.CloneURL = cloneURL
	}
	sourceRepository, err := c.mapSourceRepository(payload.FromRef.Repository, repository)
	if err != nil {
		return domain.PullRequest{}, err
	}
	return domain.PullRequest{
		Repository:       repository,
		SourceRepository: sourceRepository,
		Number:           payload.ID,
		Version:          payload.Version,
		Title:            payload.Title,
		Description:      payload.Description,
		State:            payload.State,
		Author:           payload.Author.Slug,
		URL:              c.pullRequestURL(repository, payload.ID),
		Source:           domain.Branch{Name: payload.FromRef.DisplayID, Commit: payload.FromRef.LatestCommit},
		Destination:      domain.Branch{Name: payload.ToRef.DisplayID, Commit: payload.ToRef.LatestCommit},
	}, nil
}

func (c *Client) mapSourceRepository(payload *dataCenterRepositoryReference, fallback domain.Repository) (domain.Repository, error) {
	if payload == nil {
		return fallback, nil
	}
	if !isPathSegment(payload.Project.Key) || !isPathSegment(payload.Slug) {
		return domain.Repository{}, fmt.Errorf("Data Center pull request source repository is incomplete")
	}
	repository := domain.Repository{Namespace: payload.Project.Key, Slug: payload.Slug}
	cloneURL, err := c.connection.CloneURL(repository)
	if err != nil {
		return domain.Repository{}, err
	}
	repository.CloneURL = cloneURL
	return repository, nil
}

func (c *Client) pullRequestURL(repository domain.Repository, number int) string {
	endpoint := *c.connection.APIBase
	contextPath := strings.TrimSuffix(endpoint.Path, "/rest/api/latest")
	endpoint.Path = path.Join(contextPath, "projects", repository.Namespace, "repos", repository.Slug, "pull-requests", fmt.Sprint(number))
	endpoint.RawPath = ""
	endpoint.RawQuery = ""
	endpoint.Fragment = ""
	return endpoint.String()
}

func mapParticipants(values []dataCenterParticipantPayload) []domain.Participant {
	participants := make([]domain.Participant, 0, len(values))
	for _, value := range values {
		participants = append(participants, domain.Participant{ID: value.User.Slug, Name: value.User.DisplayName, Role: value.Role, Approved: value.Status == "APPROVED"})
	}
	return participants
}

func mapReviewCommits(page reviewCommitPage) []domain.Commit {
	commits := make([]domain.Commit, 0, len(page.Values))
	for _, commit := range page.Values {
		commits = append(commits, domain.Commit{Hash: commit.ID, Message: commit.Message, Author: commit.Author.Name})
	}
	return commits
}

func mapReviewThreads(comments []reviewComment) []domain.Thread {
	threads := make([]domain.Thread, 0, len(comments))
	byRoot := make(map[string]int, len(comments))
	for _, value := range comments {
		if value.Parent.ID != 0 {
			continue
		}
		id := fmt.Sprint(value.ID)
		byRoot[id] = len(threads)
		threads = append(threads, domain.Thread{ID: id, Comments: []domain.Comment{{ID: id, Author: value.Author.DisplayName, Body: value.Text}}})
	}
	for _, value := range comments {
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
		threads[index].Comments = append(threads[index].Comments, domain.Comment{ID: fmt.Sprint(value.ID), ParentID: parentID, Author: value.Author.DisplayName, Body: value.Text})
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

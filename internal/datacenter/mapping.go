package datacenter

import (
	"fmt"
	"path"
	"strconv"
	"strings"
	"time"

	"kandev-plugin-bitbucket/internal/domain"
)

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
		Repository:        repository,
		SourceRepository:  sourceRepository,
		Number:            payload.ID,
		Version:           payload.Version,
		Title:             payload.Title,
		Description:       payload.Description,
		State:             payload.State,
		Author:            payload.Author.Slug,
		AuthorDisplayName: payload.Author.DisplayName,
		CreatedAt:         dataCenterTimestamp(payload.CreatedDate),
		URL:               c.pullRequestURL(repository, payload.ID),
		Source:            domain.Branch{Name: payload.FromRef.DisplayID, Commit: payload.FromRef.LatestCommit},
		Destination:       domain.Branch{Name: payload.ToRef.DisplayID, Commit: payload.ToRef.LatestCommit},
	}, nil
}

func dataCenterTimestamp(milliseconds int64) time.Time {
	if milliseconds <= 0 {
		return time.Time{}
	}
	return time.UnixMilli(milliseconds).UTC()
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
		verdict := domain.ReviewVerdictPending
		switch strings.ToUpper(value.Status) {
		case "APPROVED":
			verdict = domain.ReviewVerdictApproved
		case "NEEDS_WORK":
			verdict = domain.ReviewVerdictChangesRequested
		}
		participants = append(participants, domain.Participant{
			ID: value.User.Slug, Name: value.User.DisplayName, Role: value.Role,
			Approved: verdict == domain.ReviewVerdictApproved, Verdict: verdict,
		})
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
		threads = append(threads, domain.Thread{ID: id, Comments: []domain.Comment{{ID: id, Author: value.Author.DisplayName, Body: value.Text, When: unixMillis(value.CreatedDate)}}})
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
		threads[index].Comments = append(threads[index].Comments, domain.Comment{ID: fmt.Sprint(value.ID), ParentID: parentID, Author: value.Author.DisplayName, Body: value.Text, When: unixMillis(value.CreatedDate)})
	}
	return threads
}

func unixMillis(value int64) time.Time {
	if value <= 0 {
		return time.Time{}
	}
	return time.UnixMilli(value).UTC()
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

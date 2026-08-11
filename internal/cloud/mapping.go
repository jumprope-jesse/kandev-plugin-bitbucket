package cloud

import (
	"fmt"
	"net/url"
	"path"
	"strconv"
	"strings"

	"kandev-plugin-bitbucket/internal/domain"
)

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
	if strings.TrimSpace(payload.UUID) == "" {
		return domain.Repository{}, fmt.Errorf("Cloud pull request source repository has no immutable UUID")
	}
	return domain.Repository{ID: payload.UUID, ProviderScope: "https://bitbucket.org", Namespace: namespace, Slug: slug, CloneURL: cloneURL}, nil
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
		verdict := domain.ReviewVerdictPending
		switch strings.ToUpper(value.State) {
		case "CHANGES_REQUESTED", "NEEDS_WORK":
			verdict = domain.ReviewVerdictChangesRequested
		case "APPROVED":
			verdict = domain.ReviewVerdictApproved
		default:
			if value.Approved {
				verdict = domain.ReviewVerdictApproved
			}
		}
		participants = append(participants, domain.Participant{
			ID: value.User.AccountID, Name: value.User.DisplayName, Role: value.Role,
			Approved: value.Approved, Verdict: verdict,
		})
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

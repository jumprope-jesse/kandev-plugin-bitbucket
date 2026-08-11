package plugin

import (
	"sort"
	"strconv"
	"strings"
	"time"

	"kandev-plugin-bitbucket/internal/domain"
)

func repositoryViews(repositories []domain.Repository) []map[string]any {
	views := make([]map[string]any, 0, len(repositories))
	for _, repository := range repositories {
		cloneURL := ""
		host := ""
		if repository.CloneURL != nil {
			cloneURL = repository.CloneURL.String()
			host = repositoryProviderHost(repository.CloneURL)
		}
		views = append(views, map[string]any{
			"id": repository.Namespace + "/" + repository.Slug, "name": repository.Slug,
			"owner_or_project": repository.Namespace, "provider_id": "bitbucket", "provider_host": host,
			"provider_repository_id": repository.Namespace + "/" + repository.Slug, "clone_url": cloneURL,
			"default_branch": repository.DefaultBranch,
		})
	}
	return views
}

func branchViews(branches []domain.Branch) []map[string]any {
	views := make([]map[string]any, 0, len(branches))
	for _, branch := range branches {
		views = append(views, map[string]any{"name": branch.Name, "commit": branch.Commit, "is_default": branch.IsDefault})
	}
	return views
}

func pullRequestViews(pullRequests []domain.PullRequest) []map[string]any {
	views := make([]map[string]any, 0, len(pullRequests))
	for _, pullRequest := range pullRequests {
		views = append(views, pullRequestView(pullRequest))
	}
	return views
}

func pullRequestView(pullRequest domain.PullRequest) map[string]any {
	createdAt := ""
	if !pullRequest.CreatedAt.IsZero() {
		createdAt = pullRequest.CreatedAt.UTC().Format(time.RFC3339)
	}
	return map[string]any{
		"id": strconv.Itoa(pullRequest.Number), "review_key": pullRequest.Key(), "number": pullRequest.Number,
		"title": pullRequest.Title, "description": pullRequest.Description, "url": pullRequest.URL,
		"repository_id":   pullRequest.Repository.Namespace + "/" + pullRequest.Repository.Slug,
		"repository_name": pullRequest.Repository.Slug, "repository": repositoryViews([]domain.Repository{pullRequest.Repository})[0],
		"state": pullRequest.State, "source_branch": pullRequest.Source.Name, "destination_branch": pullRequest.Destination.Name,
		"author":              pullRequest.Author,
		"author_display_name": pullRequest.AuthorDisplayName,
		"created_at":          createdAt,
		"capabilities":        actionCapabilities(pullRequest.Capabilities),
	}
}

func reviewView(review domain.Review) map[string]any {
	view := pullRequestView(review.PullRequest)
	files := make([]map[string]any, 0, len(review.Files))
	for _, file := range review.Files {
		files = append(files, map[string]any{
			"path": file.Path, "status": file.Status, "additions": file.Additions, "deletions": file.Deletions, "patch": file.Patch,
		})
	}
	commits := make([]map[string]any, 0, len(review.Commits))
	for _, commit := range review.Commits {
		commits = append(commits, map[string]any{"id": commit.Hash, "hash": commit.Hash, "message": commit.Message, "author": commit.Author})
	}
	participants := make([]map[string]any, 0, len(review.Participants))
	viewerKnown := strings.TrimSpace(review.ViewerID) != ""
	viewerApproved := false
	for _, participant := range review.Participants {
		verdict := participant.Verdict
		if verdict == "" {
			if participant.Approved {
				verdict = domain.ReviewVerdictApproved
			} else {
				verdict = domain.ReviewVerdictPending
			}
		}
		participantView := map[string]any{
			"id": participant.ID, "name": participant.Name, "role": participant.Role,
			"approved": participant.Approved, "verdict": verdict,
		}
		if viewerKnown && strings.EqualFold(participant.ID, review.ViewerID) {
			participantView["is_current_user"] = true
			viewerApproved = participant.Approved
		}
		participants = append(participants, participantView)
	}
	threads := make([]map[string]any, 0, len(review.Threads))
	for _, thread := range review.Threads {
		threadView := map[string]any{"id": thread.ID, "comments": thread.Comments}
		if len(thread.Comments) > 0 {
			threadView["author"] = thread.Comments[0].Author
			threadView["body"] = thread.Comments[0].Body
		}
		threads = append(threads, threadView)
	}
	statuses := make([]map[string]any, 0, len(review.Statuses))
	for _, status := range review.Statuses {
		statuses = append(statuses, map[string]any{"key": status.Key, "name": status.Name, "state": status.State, "url": status.URL, "target": status.Target})
	}
	view["diff"] = review.Diff
	view["files"] = files
	view["commits"] = commits
	view["participants"] = participants
	if viewerKnown {
		view["viewer_approved"] = viewerApproved
	}
	view["threads"] = threads
	view["statuses"] = statuses
	return view
}

func actionCapabilities(capabilities domain.Capabilities) []string {
	values := []string{"link", "launch_task"}
	for capability, enabled := range capabilities {
		if enabled {
			values = append(values, string(capability))
		}
	}
	sort.Strings(values)
	return values
}

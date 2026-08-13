package plugin

import (
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"kandev-plugin-bitbucket/internal/domain"
)

const (
	maxReviewViewDiffBytes        = 64 * 1024
	maxReviewViewDescriptionBytes = 16 * 1024
	maxReviewViewTextBytes        = 1024
	maxReviewViewEntries          = 100
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
			"provider_scope": repository.ProviderScope, "provider_repository_id": repository.ID, "clone_url": cloneURL,
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
		"title":       boundedViewText(pullRequest.Title, maxReviewViewTextBytes),
		"description": boundedViewText(pullRequest.Description, maxReviewViewDescriptionBytes), "url": pullRequest.URL,
		"repository_id":   pullRequest.Repository.ID,
		"provider_scope":  pullRequest.Repository.ProviderScope,
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
	truncated := make(map[string]struct{})
	files := make([]map[string]any, 0, min(len(review.Files), maxReviewViewEntries))
	for _, file := range review.Files[:min(len(review.Files), maxReviewViewEntries)] {
		patch, patchTruncated := boundedViewTextWithFlag(file.Patch, maxReviewViewTextBytes)
		if patchTruncated {
			truncated["files"] = struct{}{}
		}
		files = append(files, map[string]any{
			"path": boundedViewText(file.Path, maxReviewViewTextBytes), "status": file.Status,
			"additions": file.Additions, "deletions": file.Deletions, "patch": patch,
		})
	}
	if len(review.Files) > len(files) {
		truncated["files"] = struct{}{}
	}
	commits := make([]map[string]any, 0, min(len(review.Commits), maxReviewViewEntries))
	for _, commit := range review.Commits[:min(len(review.Commits), maxReviewViewEntries)] {
		message, messageTruncated := boundedViewTextWithFlag(commit.Message, maxReviewViewTextBytes)
		if messageTruncated {
			truncated["commits"] = struct{}{}
		}
		commits = append(commits, map[string]any{
			"id": commit.Hash, "hash": commit.Hash, "message": message,
			"author": boundedViewText(commit.Author, maxReviewViewTextBytes),
		})
	}
	if len(review.Commits) > len(commits) {
		truncated["commits"] = struct{}{}
	}
	participants := make([]map[string]any, 0, min(len(review.Participants), maxReviewViewEntries))
	viewerKnown := strings.TrimSpace(review.ViewerID) != ""
	viewerApproved := false
	for _, participant := range review.Participants[:min(len(review.Participants), maxReviewViewEntries)] {
		verdict := participant.Verdict
		if verdict == "" {
			if participant.Approved {
				verdict = domain.ReviewVerdictApproved
			} else {
				verdict = domain.ReviewVerdictPending
			}
		}
		participantView := map[string]any{
			"id": participant.ID, "name": boundedViewText(participant.Name, maxReviewViewTextBytes), "role": participant.Role,
			"approved": participant.Approved, "verdict": verdict,
		}
		if viewerKnown && strings.EqualFold(participant.ID, review.ViewerID) {
			participantView["is_current_user"] = true
			viewerApproved = participant.Approved
		}
		participants = append(participants, participantView)
	}
	if len(review.Participants) > len(participants) {
		truncated["participants"] = struct{}{}
	}
	threads := make([]map[string]any, 0, min(len(review.Threads), maxReviewViewEntries))
	commentCount := 0
	for _, thread := range review.Threads[:min(len(review.Threads), maxReviewViewEntries)] {
		comments := make([]map[string]any, 0, min(len(thread.Comments), maxReviewViewEntries-commentCount))
		for _, comment := range thread.Comments {
			if commentCount == maxReviewViewEntries {
				truncated["threads"] = struct{}{}
				break
			}
			body, bodyTruncated := boundedViewTextWithFlag(comment.Body, maxReviewViewTextBytes)
			if bodyTruncated {
				truncated["threads"] = struct{}{}
			}
			createdAt := ""
			if !comment.When.IsZero() {
				createdAt = comment.When.UTC().Format(time.RFC3339)
			}
			comments = append(comments, map[string]any{
				"id": comment.ID, "parent_id": comment.ParentID,
				"author": boundedViewText(comment.Author, maxReviewViewTextBytes), "body": body, "created_at": createdAt,
			})
			commentCount++
		}
		threadView := map[string]any{"id": thread.ID, "comments": comments}
		if len(comments) > 0 {
			threadView["author"] = comments[0]["author"]
			threadView["body"] = comments[0]["body"]
		}
		threads = append(threads, threadView)
	}
	if len(review.Threads) > len(threads) {
		truncated["threads"] = struct{}{}
	}
	statuses := make([]map[string]any, 0, min(len(review.Statuses), maxReviewViewEntries))
	for _, status := range review.Statuses[:min(len(review.Statuses), maxReviewViewEntries)] {
		name, nameTruncated := boundedViewTextWithFlag(status.Name, maxReviewViewTextBytes)
		if nameTruncated {
			truncated["statuses"] = struct{}{}
		}
		statuses = append(statuses, map[string]any{
			"key": status.Key, "name": name, "state": status.State, "url": status.URL, "target": status.Target,
		})
	}
	if len(review.Statuses) > len(statuses) {
		truncated["statuses"] = struct{}{}
	}
	diff, diffTruncated := boundedViewTextWithFlag(review.Diff, maxReviewViewDiffBytes)
	if diffTruncated {
		truncated["diff"] = struct{}{}
	}
	view["diff"] = diff
	view["files"] = files
	view["commits"] = commits
	view["participants"] = participants
	if viewerKnown {
		view["viewer_approved"] = viewerApproved
	}
	view["threads"] = threads
	view["statuses"] = statuses
	if review.UnresolvedThreadCount != nil {
		view["unresolved_thread_count"] = *review.UnresolvedThreadCount
	}
	if len(truncated) > 0 {
		sections := make([]string, 0, len(truncated))
		for section := range truncated {
			sections = append(sections, section)
		}
		sort.Strings(sections)
		view["truncated_sections"] = sections
	}
	return view
}

func boundedViewText(value string, maxBytes int) string {
	bounded, _ := boundedViewTextWithFlag(value, maxBytes)
	return bounded
}

func boundedViewTextWithFlag(value string, maxBytes int) (string, bool) {
	if len(value) <= maxBytes {
		return value, false
	}
	value = value[:maxBytes]
	for !utf8.ValidString(value) {
		value = value[:len(value)-1]
	}
	return value, true
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

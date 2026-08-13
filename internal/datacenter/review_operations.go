package datacenter

import (
	"context"
	"fmt"
	"path"
	"strings"

	"kandev-plugin-bitbucket/internal/domain"
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

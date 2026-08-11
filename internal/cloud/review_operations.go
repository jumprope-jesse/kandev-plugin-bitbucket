package cloud

import (
	"context"
	"fmt"
	"net/url"
	"path"
	"strings"

	"kandev-plugin-bitbucket/internal/domain"
)

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

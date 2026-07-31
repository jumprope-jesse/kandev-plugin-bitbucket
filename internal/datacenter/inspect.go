package datacenter

import (
	"fmt"
	"net/url"
	"path"
	"strconv"
	"strings"

	"kandev-plugin-bitbucket/internal/domain"
)

// InspectRepositoryURL parses a credential-free Data Center repository web or clone URL.
func (c *Client) InspectRepositoryURL(raw string) (domain.Repository, error) {
	parts, err := c.inspectURL(raw)
	if err != nil {
		return domain.Repository{}, fmt.Errorf("invalid Bitbucket Data Center repository URL")
	}
	context := c.contextSegments()
	if matchesSegments(parts, append(append([]string{}, context...), "scm"), len(context)+3) {
		namespace, cloneSlug := parts[len(context)+1], parts[len(context)+2]
		if !strings.HasSuffix(cloneSlug, ".git") {
			return domain.Repository{}, fmt.Errorf("invalid Bitbucket Data Center repository URL")
		}
		return c.inspectedRepository(namespace, strings.TrimSuffix(cloneSlug, ".git"))
	}
	if matchesSegments(parts, append(append([]string{}, context...), "projects"), len(context)+4) && parts[len(context)+2] == "repos" {
		return c.inspectedRepository(parts[len(context)+1], parts[len(context)+3])
	}
	return domain.Repository{}, fmt.Errorf("invalid Bitbucket Data Center repository URL")
}

// InspectPullRequestURL parses a credential-free Data Center pull request web URL.
func (c *Client) InspectPullRequestURL(raw string) (domain.PullRequestLocator, error) {
	parts, err := c.inspectURL(raw)
	if err != nil {
		return domain.PullRequestLocator{}, fmt.Errorf("invalid Bitbucket Data Center pull request URL")
	}
	context := c.contextSegments()
	if !matchesSegments(parts, append(append([]string{}, context...), "projects"), len(context)+6) || parts[len(context)+2] != "repos" || parts[len(context)+4] != "pull-requests" {
		return domain.PullRequestLocator{}, fmt.Errorf("invalid Bitbucket Data Center pull request URL")
	}
	repository, err := c.inspectedRepository(parts[len(context)+1], parts[len(context)+3])
	if err != nil {
		return domain.PullRequestLocator{}, err
	}
	number, err := inspectPullRequestNumber(parts[len(context)+5])
	if err != nil {
		return domain.PullRequestLocator{}, fmt.Errorf("invalid Bitbucket Data Center pull request URL")
	}
	return domain.PullRequestLocator{Repository: repository, Number: number}, nil
}

func (c *Client) inspectURL(raw string) ([]string, error) {
	value, err := url.Parse(raw)
	if err != nil || value.User != nil || value.RawQuery != "" || value.Fragment != "" || value.RawPath != "" || value.Path == "/" || value.Path != path.Clean(value.Path) || !sameOrigin(value, c.connection.APIBase) {
		return nil, fmt.Errorf("invalid Data Center URL")
	}
	parts := strings.Split(strings.TrimPrefix(value.Path, "/"), "/")
	for _, part := range parts {
		if !validInspectionSegment(part) {
			return nil, fmt.Errorf("invalid Data Center URL")
		}
	}
	return parts, nil
}

func (c *Client) contextSegments() []string {
	contextPath := strings.TrimSuffix(c.connection.APIBase.Path, "/rest/api/latest")
	if contextPath == "" || contextPath == "/" {
		return nil
	}
	return strings.Split(strings.TrimPrefix(contextPath, "/"), "/")
}

func matchesSegments(parts, prefix []string, total int) bool {
	if len(parts) != total || len(parts) < len(prefix) {
		return false
	}
	for index := range prefix {
		if parts[index] != prefix[index] {
			return false
		}
	}
	return true
}

func (c *Client) inspectedRepository(namespace, slug string) (domain.Repository, error) {
	if !validInspectionSegment(namespace) || !validInspectionSegment(slug) {
		return domain.Repository{}, fmt.Errorf("invalid Bitbucket Data Center repository URL")
	}
	repository := domain.Repository{Namespace: namespace, Slug: slug}
	cloneURL, err := c.connection.CloneURL(repository)
	if err != nil {
		return domain.Repository{}, fmt.Errorf("invalid Bitbucket Data Center repository URL")
	}
	repository.CloneURL = cloneURL
	return repository, nil
}

func validInspectionSegment(value string) bool {
	return isPathSegment(value) && value != "." && value != ".."
}

func inspectPullRequestNumber(value string) (int, error) {
	number, err := strconv.Atoi(value)
	if err != nil || number <= 0 || strconv.Itoa(number) != value {
		return 0, fmt.Errorf("invalid pull request number")
	}
	return number, nil
}

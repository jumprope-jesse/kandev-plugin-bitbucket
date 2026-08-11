package cloud

import (
	"fmt"
	"net/url"
	"path"
	"strconv"
	"strings"

	"kandev-plugin-bitbucket/internal/domain"
)

const cloudWebHost = "bitbucket.org"

// InspectRepositoryURL parses a credential-free Cloud repository web or clone URL.
func (c *Client) InspectRepositoryURL(raw string) (domain.Repository, error) {
	parts, err := inspectCloudURL(raw)
	if err != nil || len(parts) != 2 {
		return domain.Repository{}, fmt.Errorf("invalid Bitbucket Cloud repository URL")
	}
	slug := strings.TrimSuffix(parts[1], ".git")
	if !validInspectionSegment(parts[0]) || !validInspectionSegment(slug) {
		return domain.Repository{}, fmt.Errorf("invalid Bitbucket Cloud repository URL")
	}
	return cloudRepository(parts[0], slug), nil
}

// InspectPullRequestURL parses a credential-free Cloud pull request web URL.
func (c *Client) InspectPullRequestURL(raw string) (domain.PullRequestLocator, error) {
	parts, err := inspectCloudURL(raw)
	if err != nil || len(parts) != 4 || parts[2] != "pull-requests" {
		return domain.PullRequestLocator{}, fmt.Errorf("invalid Bitbucket Cloud pull request URL")
	}
	if !validInspectionSegment(parts[0]) || !validInspectionSegment(parts[1]) {
		return domain.PullRequestLocator{}, fmt.Errorf("invalid Bitbucket Cloud pull request URL")
	}
	number, err := inspectPullRequestNumber(parts[3])
	if err != nil {
		return domain.PullRequestLocator{}, fmt.Errorf("invalid Bitbucket Cloud pull request URL")
	}
	return domain.PullRequestLocator{Repository: cloudRepository(parts[0], parts[1]), Number: number}, nil
}

func inspectCloudURL(raw string) ([]string, error) {
	value, err := url.Parse(raw)
	if err != nil || value.Scheme != "https" || !strings.EqualFold(value.Host, cloudWebHost) || value.User != nil || value.RawQuery != "" || value.Fragment != "" || value.RawPath != "" || value.Path == "/" || value.Path != path.Clean(value.Path) {
		return nil, fmt.Errorf("invalid Cloud URL")
	}
	parts := strings.Split(strings.TrimPrefix(value.Path, "/"), "/")
	for _, part := range parts {
		if !validInspectionSegment(part) {
			return nil, fmt.Errorf("invalid Cloud URL")
		}
	}
	return parts, nil
}

func cloudRepository(namespace, slug string) domain.Repository {
	cloneURL := &url.URL{Scheme: "https", Host: cloudWebHost, Path: path.Join("/", namespace, slug+".git")}
	return domain.Repository{ProviderScope: "https://bitbucket.org", Namespace: namespace, Slug: slug, CloneURL: cloneURL}
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

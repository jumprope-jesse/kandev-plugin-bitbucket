package datacenter

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestDataCenterInspectRepositoryAndPullRequestURLs(t *testing.T) {
	client, err := NewClient(ClientOptions{ConnectionOptions: ConnectionOptions{BaseURL: "https://dc.example.test/bitbucket"}})
	require.NoError(t, err)

	for _, raw := range []string{
		"https://dc.example.test/bitbucket/scm/ENG/widgets.git",
		"https://dc.example.test/bitbucket/projects/ENG/repos/widgets",
	} {
		repository, inspectErr := client.InspectRepositoryURL(raw)
		require.NoError(t, inspectErr)
		require.Equal(t, "ENG", repository.Namespace)
		require.Equal(t, "widgets", repository.Slug)
		require.Equal(t, "https://dc.example.test/bitbucket/scm/ENG/widgets.git", repository.CloneURL.String())
	}

	pullRequest, err := client.InspectPullRequestURL("https://dc.example.test/bitbucket/projects/ENG/repos/widgets/pull-requests/42")
	require.NoError(t, err)
	require.Equal(t, "ENG", pullRequest.Repository.Namespace)
	require.Equal(t, "widgets", pullRequest.Repository.Slug)
	require.Equal(t, 42, pullRequest.Number)
}

func TestDataCenterInspectURLsRejectsUnsafeWrongOriginAndUnknownPaths(t *testing.T) {
	client, err := NewClient(ClientOptions{ConnectionOptions: ConnectionOptions{BaseURL: "https://dc.example.test/bitbucket"}})
	require.NoError(t, err)
	for _, raw := range []string{
		"https://token@dc.example.test/bitbucket/scm/ENG/widgets.git",
		"https://attacker.example/bitbucket/scm/ENG/widgets.git",
		"https://dc.example.test/scm/ENG/widgets.git",
		"https://dc.example.test/bitbucket/scm/ENG/widgets",
		"https://dc.example.test/bitbucket//scm/ENG/widgets.git",
		"https://dc.example.test/bitbucket/projects/ENG/repos/widgets/pull-requests/42",
	} {
		_, inspectErr := client.InspectRepositoryURL(raw)
		require.Error(t, inspectErr, raw)
	}
	for _, raw := range []string{
		"https://token@dc.example.test/bitbucket/projects/ENG/repos/widgets/pull-requests/42",
		"https://attacker.example/bitbucket/projects/ENG/repos/widgets/pull-requests/42",
		"https://dc.example.test/bitbucket/projects/ENG/repos/widgets/pull-requests/0",
		"https://dc.example.test/bitbucket/projects/ENG/repos/widgets/pull-requests/42/",
		"https://dc.example.test/bitbucket/projects/ENG/repos/widgets/issues/42",
	} {
		_, inspectErr := client.InspectPullRequestURL(raw)
		require.Error(t, inspectErr, raw)
	}
}

package cloud

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestCloudInspectRepositoryAndPullRequestURLs(t *testing.T) {
	client := NewClient(ClientOptions{})

	for _, raw := range []string{
		"https://bitbucket.org/acme/widgets",
		"https://bitbucket.org/acme/widgets.git",
	} {
		repository, err := client.InspectRepositoryURL(raw)
		require.NoError(t, err)
		require.Equal(t, "acme", repository.Namespace)
		require.Equal(t, "widgets", repository.Slug)
		require.Equal(t, "https://bitbucket.org/acme/widgets.git", repository.CloneURL.String())
	}

	pullRequest, err := client.InspectPullRequestURL("https://bitbucket.org/acme/widgets/pull-requests/42")
	require.NoError(t, err)
	require.Equal(t, "acme", pullRequest.Repository.Namespace)
	require.Equal(t, "widgets", pullRequest.Repository.Slug)
	require.Equal(t, 42, pullRequest.Number)
}

func TestCloudInspectURLsRejectsUnsafeOrUnknownURLs(t *testing.T) {
	client := NewClient(ClientOptions{})
	for _, raw := range []string{
		"http://bitbucket.org/acme/widgets",
		"https://token@bitbucket.org/acme/widgets",
		"https://attacker.example/acme/widgets",
		"https://bitbucket.org/acme/widgets?redirect=https://attacker.example",
		"https://bitbucket.org/acme//widgets",
		"https://bitbucket.org/acme/widgets/pull-requests/42",
		"https://bitbucket.org/acme/widgets/issues/42",
	} {
		_, err := client.InspectRepositoryURL(raw)
		require.Error(t, err, raw)
	}
	for _, raw := range []string{
		"https://token@bitbucket.org/acme/widgets/pull-requests/42",
		"https://attacker.example/acme/widgets/pull-requests/42",
		"https://bitbucket.org/acme/widgets/pull-requests/0",
		"https://bitbucket.org/acme/widgets/pull-requests/42/",
		"https://bitbucket.org/acme/widgets/issues/42",
	} {
		_, err := client.InspectPullRequestURL(raw)
		require.Error(t, err, raw)
	}
}

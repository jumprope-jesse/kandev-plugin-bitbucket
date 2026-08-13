package domain

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestPullRequestKeyUsesProviderNeutralRepositoryIdentity(t *testing.T) {
	pullRequest := PullRequest{Repository: Repository{Namespace: "ENG", Slug: "widgets"}, Number: 42}

	require.Equal(t, "ENG/widgets#42", pullRequest.Key())
}

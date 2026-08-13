package domain

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestNewCloudConnectionUsesCanonicalAPIV2AndCredentialFreeCloneURLs(t *testing.T) {
	connection, err := NewCloudConnection("acme")
	require.NoError(t, err)

	require.Equal(t, ProductCloud, connection.Product)
	require.Equal(t, "https://api.bitbucket.org/2.0", connection.APIBase.String())
	cloneURL, err := connection.CloneURL(Repository{Slug: "widgets"})
	require.NoError(t, err)
	require.Equal(t, "https://bitbucket.org/acme/widgets.git", cloneURL.String())
	require.True(t, connection.Capabilities.Supports(CapabilityOAuthPKCE))
	require.False(t, connection.Capabilities.Supports(CapabilityIssues))
}

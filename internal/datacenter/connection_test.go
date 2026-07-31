package datacenter

import (
	"testing"

	"github.com/stretchr/testify/require"
	"kandev-plugin-bitbucket/internal/domain"
)

func TestNewConnectionPreservesDataCenterContextPathInAPIAndCloneURLs(t *testing.T) {
	connection, err := NewConnection(ConnectionOptions{BaseURL: "https://bitbucket.example.test/bitbucket/"})
	require.NoError(t, err)

	require.Equal(t, domain.ProductDataCenter, connection.Product)
	require.Equal(t, "https://bitbucket.example.test/bitbucket/rest/api/latest", connection.APIBase.String())
	require.True(t, connection.Capabilities.Supports(domain.CapabilityOAuthPKCE))
	cloneURL, err := connection.CloneURL(domain.Repository{Namespace: "ENG", Slug: "widgets"})
	require.NoError(t, err)
	require.Equal(t, "https://bitbucket.example.test/bitbucket/scm/ENG/widgets.git", cloneURL.String())
}

func TestNewConnectionRejectsUnsafeBaseURLsOutsideExplicitDevelopmentMode(t *testing.T) {
	for _, baseURL := range []string{
		"http://bitbucket.example.test",
		"https://token@bitbucket.example.test",
		"https://bitbucket.example.test/?target=internal",
		"https://bitbucket.example.test/bitbucket/../admin",
		"https://bitbucket.example.test/bitbucket//admin",
	} {
		t.Run(baseURL, func(t *testing.T) {
			_, err := NewConnection(ConnectionOptions{BaseURL: baseURL})
			require.Error(t, err)
		})
	}

	_, err := NewConnection(ConnectionOptions{
		BaseURL:           "http://bitbucket.example.test/bitbucket",
		AllowInsecureHTTP: true,
	})
	require.NoError(t, err)
}

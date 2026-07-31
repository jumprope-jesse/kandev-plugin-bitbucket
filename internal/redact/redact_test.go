package redact

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestRedactorRemovesKnownSecretsAndCredentialBearingURLs(t *testing.T) {
	redactor := New("cloud-secret", "refresh-secret")

	actual := redactor.String("request https://user:cloud-secret@dc.example.test/rest?access_token=cloud-secret&cursor=ok Authorization: Bearer refresh-secret")

	require.NotContains(t, actual, "cloud-secret")
	require.NotContains(t, actual, "refresh-secret")
	require.NotContains(t, actual, "user:")
	require.Contains(t, actual, "access_token=[REDACTED]")
	require.Contains(t, actual, "Authorization: Bearer [REDACTED]")
}

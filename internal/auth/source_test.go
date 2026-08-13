package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestRefreshingTokenSourcePersistsRotatedCredentialForGeneration(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"access_token":"rotated-access","refresh_token":"rotated-refresh","expires_in":3600}`))
	}))
	defer server.Close()
	tokenURL, err := url.Parse(server.URL)
	require.NoError(t, err)
	scope := CredentialScope{WorkspaceID: "workspace-a", Generation: 7}
	credentials := &memoryCredentialRepository{credential: Credential{
		AccessToken: "expired-access", RefreshToken: "old-refresh", ExpiresAt: time.Now().Add(-time.Minute),
	}}
	source := NewRefreshingTokenSource(scope, OAuthRegistration{ClientID: "id", ClientSecret: "secret", TokenURL: tokenURL}, credentials, NewRefresher(server.Client(), time.Now), time.Now)

	token, expiresAt, err := source.AccessTokenCredential(context.Background())
	require.NoError(t, err)
	require.Equal(t, "rotated-access", token)
	require.Equal(t, "rotated-refresh", credentials.credential.RefreshToken)
	require.Equal(t, credentials.credential.ExpiresAt, expiresAt)
}

type memoryCredentialRepository struct {
	credential Credential
}

func (r *memoryCredentialRepository) LoadCredential(context.Context, CredentialScope) (Credential, error) {
	return r.credential, nil
}

func (r *memoryCredentialRepository) SaveCredential(_ context.Context, _ CredentialScope, credential Credential) error {
	r.credential = credential
	return nil
}

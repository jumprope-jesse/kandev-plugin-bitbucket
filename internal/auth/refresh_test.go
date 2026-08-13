package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestRefresherCoalescesWorkspaceGenerationAndRotatesRefreshToken(t *testing.T) {
	var calls atomic.Int32
	started := make(chan struct{})
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			close(started)
		}
		clientID, clientSecret, ok := r.BasicAuth()
		require.True(t, ok)
		require.Equal(t, "client-id", clientID)
		require.Equal(t, "client-secret", clientSecret)
		require.NoError(t, r.ParseForm())
		require.Equal(t, "refresh_token", r.Form.Get("grant_type"))
		require.Equal(t, "old-refresh", r.Form.Get("refresh_token"))
		<-release
		_, _ = w.Write([]byte(`{"access_token":"new-access","refresh_token":"new-refresh","expires_in":3600}`))
	}))
	defer server.Close()

	tokenURL, err := url.Parse(server.URL)
	require.NoError(t, err)
	refresher := NewRefresher(server.Client(), time.Now)
	registration := OAuthRegistration{ClientID: "client-id", ClientSecret: "client-secret", TokenURL: tokenURL}
	scope := CredentialScope{WorkspaceID: "workspace-a", Generation: 3}

	results := make(chan Credential, 8)
	errors := make(chan error, 8)
	var workers sync.WaitGroup
	workers.Add(8)
	for range 8 {
		go func() {
			defer workers.Done()
			credential, refreshErr := refresher.Refresh(context.Background(), scope, registration, "old-refresh")
			if refreshErr != nil {
				errors <- refreshErr
				return
			}
			results <- credential
		}()
	}
	<-started
	close(release)
	workers.Wait()
	close(results)
	close(errors)

	for refreshErr := range errors {
		require.NoError(t, refreshErr)
	}
	for credential := range results {
		require.Equal(t, "new-access", credential.AccessToken)
		require.Equal(t, "new-refresh", credential.RefreshToken)
		require.WithinDuration(t, time.Now().Add(time.Hour), credential.ExpiresAt, 2*time.Second)
	}
	require.Equal(t, int32(1), calls.Load())
}

func TestRefresherReusesCompletedRefreshForSameGenerationAndToken(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = w.Write([]byte(`{"access_token":"new-access","refresh_token":"new-refresh","expires_in":3600}`))
	}))
	defer server.Close()

	tokenURL, err := url.Parse(server.URL)
	require.NoError(t, err)
	refresher := NewRefresher(server.Client(), time.Now)
	registration := OAuthRegistration{ClientID: "client-id", ClientSecret: "client-secret", TokenURL: tokenURL}
	scope := CredentialScope{WorkspaceID: "workspace-a", Generation: 3}

	first, err := refresher.Refresh(context.Background(), scope, registration, "old-refresh")
	require.NoError(t, err)
	second, err := refresher.Refresh(context.Background(), scope, registration, "old-refresh")
	require.NoError(t, err)
	require.Equal(t, first, second)
	require.Equal(t, int32(1), calls.Load())
}

func TestRefresherKeepsCompletedRefreshesGenerationKeyed(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		call := calls.Add(1)
		_, _ = w.Write([]byte(`{"access_token":"access-` + strconv.FormatInt(int64(call), 10) + `","refresh_token":"refresh-` + strconv.FormatInt(int64(call), 10) + `","expires_in":3600}`))
	}))
	defer server.Close()

	tokenURL, err := url.Parse(server.URL)
	require.NoError(t, err)
	refresher := NewRefresher(server.Client(), time.Now)
	registration := OAuthRegistration{ClientID: "client-id", ClientSecret: "client-secret", TokenURL: tokenURL}
	firstScope := CredentialScope{WorkspaceID: "workspace-a", Generation: 3}
	secondScope := CredentialScope{WorkspaceID: "workspace-a", Generation: 4}

	first, err := refresher.Refresh(context.Background(), firstScope, registration, "old-refresh")
	require.NoError(t, err)
	_, err = refresher.Refresh(context.Background(), secondScope, registration, "old-refresh")
	require.NoError(t, err)
	again, err := refresher.Refresh(context.Background(), firstScope, registration, "old-refresh")
	require.NoError(t, err)
	require.Equal(t, first, again)
	require.Equal(t, int32(2), calls.Load())
}

func TestRefresherRejectsRevokedInFlightCredentialGeneration(t *testing.T) {
	var calls atomic.Int32
	started := make(chan struct{})
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if calls.Add(1) == 1 {
			close(started)
			<-release
		}
		_, _ = w.Write([]byte(`{"access_token":"new-access","refresh_token":"new-refresh","expires_in":3600}`))
	}))
	defer server.Close()

	tokenURL, err := url.Parse(server.URL)
	require.NoError(t, err)
	refresher := NewRefresher(server.Client(), time.Now)
	registration := OAuthRegistration{ClientID: "client-id", ClientSecret: "client-secret", TokenURL: tokenURL}
	oldScope := CredentialScope{WorkspaceID: "workspace-a", Generation: 3, ConnectionBinding: "connection-old"}
	result := make(chan error, 1)
	go func() {
		_, refreshErr := refresher.Refresh(context.Background(), oldScope, registration, "old-refresh")
		result <- refreshErr
	}()

	<-started
	refresher.Invalidate(oldScope)
	close(release)
	require.ErrorIs(t, <-result, ErrCredentialRevoked)

	_, err = refresher.Refresh(context.Background(), oldScope, registration, "old-refresh")
	require.ErrorIs(t, err, ErrCredentialRevoked)
	replacementScope := CredentialScope{WorkspaceID: "workspace-a", Generation: 3, ConnectionBinding: "connection-new"}
	_, err = refresher.Refresh(context.Background(), replacementScope, registration, "old-refresh")
	require.NoError(t, err)
	require.Equal(t, int32(2), calls.Load())
}

func TestRefresherPurgesExpiredCompletedCredentials(t *testing.T) {
	now := time.Unix(1_000, 0)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"access_token":"new-access","refresh_token":"new-refresh","expires_in":60}`))
	}))
	defer server.Close()

	tokenURL, err := url.Parse(server.URL)
	require.NoError(t, err)
	refresher := NewRefresher(server.Client(), func() time.Time { return now })
	registration := OAuthRegistration{ClientID: "client-id", ClientSecret: "client-secret", TokenURL: tokenURL}
	_, err = refresher.Refresh(context.Background(), CredentialScope{WorkspaceID: "expired", Generation: 1}, registration, "old-refresh")
	require.NoError(t, err)
	require.Len(t, refresher.completed, 1)

	now = now.Add(2 * time.Minute)
	_, err = refresher.Refresh(context.Background(), CredentialScope{WorkspaceID: "current", Generation: 1}, registration, "old-refresh")
	require.NoError(t, err)
	require.Len(t, refresher.completed, 1)
}

func TestRefresherDoesNotForwardOAuthSecretsThroughRedirects(t *testing.T) {
	var redirectedCalls atomic.Int32
	redirectTarget := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		redirectedCalls.Add(1)
		require.NoError(t, r.ParseForm())
		require.NotEmpty(t, r.Form.Get("refresh_token"), "the default client would forward this secret on a 307")
		_, _ = w.Write([]byte(`{"access_token":"leaked-access","refresh_token":"leaked-refresh","expires_in":3600}`))
	}))
	defer redirectTarget.Close()

	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Redirect(w, &http.Request{}, redirectTarget.URL, http.StatusTemporaryRedirect)
	}))
	defer tokenServer.Close()
	tokenURL, err := url.Parse(tokenServer.URL)
	require.NoError(t, err)

	refresher := NewRefresher(tokenServer.Client(), time.Now)
	_, err = refresher.Refresh(
		context.Background(),
		CredentialScope{WorkspaceID: "workspace-a", Generation: 3},
		OAuthRegistration{ClientID: "client-id", ClientSecret: "client-secret", TokenURL: tokenURL},
		"old-refresh",
	)

	require.ErrorContains(t, err, "307 Temporary Redirect")
	require.Zero(t, redirectedCalls.Load())
}

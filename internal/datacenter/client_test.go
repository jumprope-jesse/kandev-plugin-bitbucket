package datacenter

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"kandev-plugin-bitbucket/internal/domain"
)

func TestListRepositoriesUsesDataCenterStartLimitPagination(t *testing.T) {
	firstPage, err := os.ReadFile("testdata/repositories-first.json")
	require.NoError(t, err)
	secondPage, err := os.ReadFile("testdata/repositories-second.json")
	require.NoError(t, err)

	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/bitbucket/rest/api/latest/repos", r.URL.Path)
		require.Equal(t, "Bearer dc-token", r.Header.Get("Authorization"))
		require.Equal(t, "2", r.URL.Query().Get("limit"))
		switch r.URL.Query().Get("start") {
		case "0":
			_, _ = w.Write([]byte(strings.ReplaceAll(strings.ReplaceAll(string(firstPage), "https://dc.example.test", server.URL), "http://dc.example.test", server.URL)))
		case "1":
			_, _ = w.Write([]byte(strings.ReplaceAll(strings.ReplaceAll(string(secondPage), "https://dc.example.test", server.URL), `"name": "https"`, `"name": "http"`)))
		default:
			t.Fatalf("unexpected page start %q", r.URL.Query().Get("start"))
		}
	}))
	defer server.Close()

	baseURL, err := url.Parse(server.URL + "/bitbucket")
	require.NoError(t, err)
	client, err := NewClient(ClientOptions{
		ConnectionOptions: ConnectionOptions{BaseURL: baseURL.String(), AllowInsecureHTTP: true},
		HTTPClient:        server.Client(),
		TokenSource:       staticTokenSource("dc-token"),
	})
	require.NoError(t, err)

	repositories, err := client.ListRepositories(context.Background(), "", 2)
	require.NoError(t, err)
	require.Len(t, repositories, 2)
	require.Equal(t, "ENG", repositories[0].Namespace)
	require.Equal(t, "widgets", repositories[0].Slug)
	require.Equal(t, server.URL+"/bitbucket/scm/ENG/widgets.git", repositories[0].CloneURL.String())
	require.Equal(t, "main", repositories[0].DefaultBranch)
	require.Equal(t, "dashboard", repositories[1].Slug)
}

func TestSearchRepositoriesSendsDataCenterNameFilter(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/rest/api/latest/repos", r.URL.Path)
		require.Equal(t, "widget api", r.URL.Query().Get("name"))
		require.Equal(t, "3", r.URL.Query().Get("limit"))
		_, _ = w.Write([]byte(`{"isLastPage":true,"values":[]}`))
	}))
	defer server.Close()

	client, err := NewClient(ClientOptions{
		ConnectionOptions: ConnectionOptions{BaseURL: server.URL, AllowInsecureHTTP: true},
		HTTPClient:        server.Client(), TokenSource: staticTokenSource("dc-token"),
	})
	require.NoError(t, err)

	_, err = client.SearchRepositories(context.Background(), "widget api", 3)
	require.NoError(t, err)
}

func TestRepositoryCursorIsBoundToDataCenterScopeAndQuery(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"isLastPage":false,"nextPageStart":25,"values":[]}`))
	}))
	defer server.Close()

	client, err := NewClient(ClientOptions{
		ConnectionOptions: ConnectionOptions{BaseURL: server.URL + "/bitbucket", AllowInsecureHTTP: true},
		HTTPClient:        server.Client(), TokenSource: staticTokenSource("dc-token"),
	})
	require.NoError(t, err)
	page, err := client.ListRepositoriesPage(context.Background(), "", domain.RepositoryQuery{Text: "widgets", Limit: 25})
	require.NoError(t, err)
	require.NotEmpty(t, page.NextCursor)

	_, err = client.ListRepositoriesPage(context.Background(), "", domain.RepositoryQuery{Text: "dashboard", Limit: 25, Cursor: page.NextCursor})
	require.ErrorContains(t, err, "invalid Data Center repository cursor")
	_, err = client.ListRepositoriesPage(context.Background(), "", domain.RepositoryQuery{Text: "widgets", Limit: 50, Cursor: page.NextCursor})
	require.ErrorContains(t, err, "invalid Data Center repository cursor")

	other, err := NewClient(ClientOptions{
		ConnectionOptions: ConnectionOptions{BaseURL: server.URL + "/other", AllowInsecureHTTP: true},
		HTTPClient:        server.Client(), TokenSource: staticTokenSource("dc-token"),
	})
	require.NoError(t, err)
	_, err = other.ListRepositoriesPage(context.Background(), "", domain.RepositoryQuery{Text: "widgets", Limit: 25, Cursor: page.NextCursor})
	require.ErrorContains(t, err, "invalid Data Center repository cursor")
}

func TestListRepositoriesRetriesTransientDataCenterFailures(t *testing.T) {
	var attempts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if attempts.Add(1) == 1 {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		_, _ = w.Write([]byte(`{"isLastPage":true,"values":[]}`))
	}))
	defer server.Close()
	client, err := NewClient(ClientOptions{
		ConnectionOptions: ConnectionOptions{BaseURL: server.URL, AllowInsecureHTTP: true},
		HTTPClient:        server.Client(),
		TokenSource:       staticTokenSource("dc-token"),
		RetryDelay:        func(int, time.Duration) time.Duration { return 0 },
	})
	require.NoError(t, err)

	repositories, err := client.ListRepositories(context.Background(), "", 1)
	require.NoError(t, err)
	require.Empty(t, repositories)
	require.Equal(t, int32(2), attempts.Load())
}

func TestClientRejectsDataCenterRedirectsThatChangeOrigin(t *testing.T) {
	attacker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"isLastPage":true,"values":[]}`))
	}))
	defer attacker.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, attacker.URL, http.StatusFound)
	}))
	defer server.Close()
	client, err := NewClient(ClientOptions{
		ConnectionOptions: ConnectionOptions{BaseURL: server.URL, AllowInsecureHTTP: true},
		HTTPClient:        server.Client(),
		TokenSource:       staticTokenSource("dc-token"),
	})
	require.NoError(t, err)

	_, err = client.ListRepositories(context.Background(), "", 1)
	require.ErrorContains(t, err, "redirect changed Data Center origin")
}

func TestListRepositoriesRejectsCloneURLsOutsideConnectionOrigin(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"isLastPage":true,"values":[{"slug":"widgets","defaultBranch":"main","project":{"key":"ENG"},"links":{"clone":[{"name":"http","href":"http://attacker.example.test/scm/ENG/widgets.git"}]}}]}`))
	}))
	defer server.Close()
	client, err := NewClient(ClientOptions{
		ConnectionOptions: ConnectionOptions{BaseURL: server.URL + "/bitbucket", AllowInsecureHTTP: true},
		HTTPClient:        server.Client(),
		TokenSource:       staticTokenSource("dc-token"),
	})
	require.NoError(t, err)

	_, err = client.ListRepositories(context.Background(), "", 1)
	require.ErrorContains(t, err, "invalid HTTPS clone URL")
}

func TestProbeMakesIncomingOAuthCapabilityExplicitByAuthenticationConfiguration(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/bitbucket/rest/api/latest/application-properties", r.URL.Path)
		_, _ = w.Write([]byte(`{"version":"9.4.0"}`))
	}))
	defer server.Close()

	client, err := NewClient(ClientOptions{
		ConnectionOptions: ConnectionOptions{BaseURL: server.URL + "/bitbucket", AllowInsecureHTTP: true},
		HTTPClient:        server.Client(),
		TokenSource:       staticTokenSource("dc-token"),
		Authentication:    Authentication{Mode: AuthenticationOAuth, Username: "oauth-user"},
	})
	require.NoError(t, err)

	probe, err := client.Probe(context.Background())
	require.NoError(t, err)
	require.Equal(t, "9.4.0", probe.Version)
	require.True(t, probe.Capabilities.Supports(domain.CapabilityIncomingOAuth))
	require.True(t, probe.Capabilities.Supports(domain.CapabilityPullRequests))
	require.True(t, probe.Capabilities.Supports(domain.CapabilityBuildStatuses))
	require.Equal(t, probe.Capabilities, client.Capabilities())
}

func TestDataCenterAuthenticationUsesExactRESTAndConfiguredGitUsername(t *testing.T) {
	tests := []struct {
		name              string
		authentication    Authentication
		wantAuthorization string
		wantGitUsername   string
	}{
		{name: "user token", authentication: Authentication{Mode: AuthenticationUserToken, Username: "dev"}, wantAuthorization: "Basic ZGV2OmRjLXRva2Vu", wantGitUsername: "dev"},
		{name: "legacy pat", authentication: Authentication{Mode: AuthenticationPAT, Username: "dev"}, wantAuthorization: "Basic ZGV2OmRjLXRva2Vu", wantGitUsername: "dev"},
		{name: "project token", authentication: Authentication{Mode: AuthenticationProjectToken}, wantAuthorization: "Bearer dc-token", wantGitUsername: "x-token-auth"},
		{name: "repository token", authentication: Authentication{Mode: AuthenticationRepositoryToken}, wantAuthorization: "Bearer dc-token", wantGitUsername: "x-token-auth"},
		{name: "oauth", authentication: Authentication{Mode: AuthenticationOAuth, Username: "oauth-user"}, wantAuthorization: "Bearer dc-token", wantGitUsername: "oauth-user"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				require.Equal(t, test.wantAuthorization, r.Header.Get("Authorization"))
				_, _ = w.Write([]byte(`{"isLastPage":true,"values":[]}`))
			}))
			defer server.Close()
			client, err := NewClient(ClientOptions{
				ConnectionOptions: ConnectionOptions{BaseURL: server.URL, AllowInsecureHTTP: true},
				HTTPClient:        server.Client(),
				TokenSource:       staticTokenSource("dc-token"),
				Authentication:    test.authentication,
			})
			require.NoError(t, err)

			_, err = client.ListRepositories(context.Background(), "", 1)
			require.NoError(t, err)
			credential, err := client.ResolveGitCredential(context.Background())
			require.NoError(t, err)
			require.Equal(t, test.wantGitUsername, credential.Username)
			require.Equal(t, "dc-token", credential.Secret)
			require.False(t, credential.ExpiresAt.IsZero())
		})
	}
}

func TestDataCenterGitCredentialKeepsOAuthTokenExpiryInMemory(t *testing.T) {
	expiresAt := time.Now().Add(time.Hour).UTC().Round(0)
	client, err := NewClient(ClientOptions{
		ConnectionOptions: ConnectionOptions{BaseURL: "https://bitbucket.example.test"},
		TokenSource:       expiringTokenSource{token: "oauth-token", expiresAt: expiresAt},
		Authentication:    Authentication{Mode: AuthenticationOAuth, Username: "oauth-user"},
	})
	require.NoError(t, err)

	credential, err := client.ResolveGitCredential(context.Background())
	require.NoError(t, err)
	require.Equal(t, expiresAt, credential.ExpiresAt)
}

type staticTokenSource string

func (s staticTokenSource) AccessToken(context.Context) (string, error) {
	return string(s), nil
}

type expiringTokenSource struct {
	token     string
	expiresAt time.Time
}

func (s expiringTokenSource) AccessToken(context.Context) (string, error) {
	return s.token, nil
}

func (s expiringTokenSource) AccessTokenCredential(context.Context) (string, time.Time, error) {
	return s.token, s.expiresAt, nil
}

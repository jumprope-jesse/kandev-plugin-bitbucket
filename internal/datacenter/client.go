package datacenter

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"kandev-plugin-bitbucket/internal/domain"
)

const (
	maxPageLength           = 100
	defaultResponseLimit    = 1 << 20
	repositoryCursorVersion = 1
)

type repositoryCursor struct {
	Version int    `json:"version"`
	Scope   string `json:"scope"`
	Query   string `json:"query"`
	Limit   int    `json:"limit"`
	Start   int    `json:"start"`
}

// TokenSource provides a Data Center PAT or OAuth token without exposing persistence.
type TokenSource interface {
	AccessToken(context.Context) (string, error)
}

type expiryAwareTokenSource interface {
	TokenSource
	AccessTokenCredential(context.Context) (string, time.Time, error)
}

// AuthenticationMode selects one Bitbucket Data Center credential contract.
type AuthenticationMode string

const (
	// AuthenticationPAT preserves compatibility for personal access token callers.
	AuthenticationPAT AuthenticationMode = "pat"
	// AuthenticationUserToken is an HTTP user token using Basic username/token.
	AuthenticationUserToken AuthenticationMode = "user_token"
	// AuthenticationProjectToken and AuthenticationRepositoryToken use Bearer REST
	// authentication and the x-token-auth Git username.
	AuthenticationProjectToken    AuthenticationMode = "project_token"
	AuthenticationRepositoryToken AuthenticationMode = "repository_token"
	AuthenticationOAuth           AuthenticationMode = "oauth"
)

// Authentication contains non-secret Data Center credential data.
// Username is required for HTTPS Git credentials.
type Authentication struct {
	Mode     AuthenticationMode
	Username string
}

// ClientOptions configures one Data Center REST client.
type ClientOptions struct {
	ConnectionOptions
	HTTPClient       *http.Client
	TokenSource      TokenSource
	Authentication   Authentication
	MaxResponseBytes int64
	RetryDelay       func(int, time.Duration) time.Duration
}

// Client calls the normalized Data Center REST API.
type Client struct {
	connection         domain.Connection
	httpClient         *http.Client
	tokenSource        TokenSource
	authentication     Authentication
	maxResponseBytes   int64
	retryDelay         func(int, time.Duration) time.Duration
	capabilitiesMu     sync.RWMutex
	probedCapabilities domain.Capabilities
}

// ProbeResult identifies a Data Center version and its explicit capability set.
type ProbeResult struct {
	Version      string
	Capabilities domain.Capabilities
}

// NewClient creates a hardened Data Center client.
func NewClient(options ClientOptions) (*Client, error) {
	connection, err := NewConnection(options.ConnectionOptions)
	if err != nil {
		return nil, err
	}
	maxResponseBytes := options.MaxResponseBytes
	if maxResponseBytes <= 0 {
		maxResponseBytes = defaultResponseLimit
	}
	retryDelay := options.RetryDelay
	if retryDelay == nil {
		retryDelay = defaultRetryDelay
	}
	authentication := options.Authentication
	if authentication.Mode == "" {
		authentication.Mode = AuthenticationOAuth
	}
	return &Client{
		connection:       connection,
		httpClient:       hardenedHTTPClient(options.HTTPClient, connection.APIBase),
		tokenSource:      options.TokenSource,
		authentication:   authentication,
		maxResponseBytes: maxResponseBytes,
		retryDelay:       retryDelay,
	}, nil
}

func (c *Client) authorize(request *http.Request, token string) error {
	switch c.authentication.Mode {
	case AuthenticationPAT, AuthenticationUserToken:
		username, err := c.gitUsername()
		if err != nil {
			return err
		}
		request.SetBasicAuth(username, token)
	case AuthenticationProjectToken, AuthenticationRepositoryToken, AuthenticationOAuth:
		request.Header.Set("Authorization", "Bearer "+token)
	default:
		return fmt.Errorf("unsupported Data Center authentication mode")
	}
	return nil
}

func (c *Client) gitUsername() (string, error) {
	switch c.authentication.Mode {
	case AuthenticationProjectToken, AuthenticationRepositoryToken:
		return "x-token-auth", nil
	case AuthenticationPAT, AuthenticationUserToken, AuthenticationOAuth:
	default:
		return "", fmt.Errorf("unsupported Data Center authentication mode")
	}
	username := strings.TrimSpace(c.authentication.Username)
	if username == "" {
		return "", fmt.Errorf("Data Center Git username is required")
	}
	return username, nil
}

func (c *Client) accessToken(ctx context.Context) (string, time.Time, error) {
	if source, ok := c.tokenSource.(expiryAwareTokenSource); ok {
		return source.AccessTokenCredential(ctx)
	}
	token, err := c.tokenSource.AccessToken(ctx)
	if err != nil {
		return "", time.Time{}, err
	}
	return token, time.Now().Add(5 * time.Minute), nil
}

// ListRepositories follows Data Center start/limit pagination until limit results exist.
func (c *Client) ListRepositories(ctx context.Context, _ string, limit int) ([]domain.Repository, error) {
	return c.searchRepositories(ctx, "", limit)
}

func (c *Client) ListRepositoriesPage(ctx context.Context, _ string, query domain.RepositoryQuery) (domain.RepositoryPage, error) {
	if query.Limit <= 0 {
		return domain.RepositoryPage{}, fmt.Errorf("repository limit must be positive")
	}
	search := strings.TrimSpace(query.Text)
	start := 0
	if query.Cursor != "" {
		parsed, err := c.parseRepositoryCursor(query.Cursor, search, min(query.Limit, maxPageLength))
		if err != nil {
			return domain.RepositoryPage{}, fmt.Errorf("invalid Data Center repository cursor")
		}
		start = parsed
	}
	endpoint := *c.connection.APIBase
	endpoint.Path = path.Join(endpoint.Path, "repos")
	endpoint.RawPath = ""
	payload, err := c.repositoryPage(ctx, &endpoint, search, start, min(query.Limit, maxPageLength))
	if err != nil {
		return domain.RepositoryPage{}, err
	}
	repositories := make([]domain.Repository, 0, len(payload.Values))
	for _, value := range payload.Values {
		repository, err := c.mapRepository(value)
		if err != nil {
			return domain.RepositoryPage{}, err
		}
		repositories = append(repositories, repository)
	}
	nextCursor := ""
	if !payload.IsLastPage {
		if payload.NextPageStart <= start {
			return domain.RepositoryPage{}, fmt.Errorf("Data Center repository pagination did not advance")
		}
		nextCursor = c.encodeRepositoryCursor(search, min(query.Limit, maxPageLength), payload.NextPageStart)
	}
	return domain.RepositoryPage{Repositories: repositories, NextCursor: nextCursor}, nil
}

func (c *Client) encodeRepositoryCursor(query string, limit, start int) string {
	payload, _ := json.Marshal(repositoryCursor{
		Version: repositoryCursorVersion, Scope: c.connection.Scope,
		Query: query, Limit: limit, Start: start,
	})
	return base64.RawURLEncoding.EncodeToString(payload)
}

func (c *Client) parseRepositoryCursor(raw, query string, limit int) (int, error) {
	if len(raw) > 8192 {
		return 0, fmt.Errorf("invalid repository cursor")
	}
	payload, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return 0, err
	}
	var cursor repositoryCursor
	if err := json.Unmarshal(payload, &cursor); err != nil ||
		cursor.Version != repositoryCursorVersion || cursor.Start < 0 ||
		cursor.Scope != c.connection.Scope || cursor.Query != query || cursor.Limit != limit {
		return 0, fmt.Errorf("invalid repository cursor")
	}
	return cursor.Start, nil
}

// SearchRepositories uses Data Center's case-insensitive name filter before
// paging so matches outside the first repository page remain discoverable.
func (c *Client) SearchRepositories(ctx context.Context, query string, limit int) ([]domain.Repository, error) {
	return c.searchRepositories(ctx, strings.TrimSpace(query), limit)
}

func (c *Client) searchRepositories(ctx context.Context, query string, limit int) ([]domain.Repository, error) {
	if limit <= 0 {
		return nil, fmt.Errorf("repository limit must be positive")
	}
	var repositories []domain.Repository
	cursor := ""
	for len(repositories) < limit {
		page, err := c.ListRepositoriesPage(ctx, "", domain.RepositoryQuery{
			Text: query, Limit: min(limit, maxPageLength), Cursor: cursor,
		})
		if err != nil {
			return nil, err
		}
		for _, repository := range page.Repositories {
			repositories = append(repositories, repository)
			if len(repositories) == limit {
				break
			}
		}
		if page.NextCursor == "" || len(repositories) == limit {
			break
		}
		cursor = page.NextCursor
	}
	return repositories, nil
}

// Probe reads the server version and exposes version-gated capabilities explicitly.
func (c *Client) Probe(ctx context.Context) (ProbeResult, error) {
	if c.tokenSource == nil {
		return ProbeResult{}, fmt.Errorf("Data Center token source is not configured")
	}
	token, _, err := c.accessToken(ctx)
	if err != nil {
		return ProbeResult{}, fmt.Errorf("resolve Data Center access token: %w", err)
	}
	endpoint := *c.connection.APIBase
	endpoint.Path = path.Join(endpoint.Path, "application-properties")
	endpoint.RawPath = ""
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return ProbeResult{}, err
	}
	request.Header.Set("Accept", "application/json")
	if err := c.authorize(request, token); err != nil {
		return ProbeResult{}, err
	}
	response, err := c.httpClient.Do(request)
	if err != nil {
		return ProbeResult{}, fmt.Errorf("probe Bitbucket Data Center: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return ProbeResult{}, providerResponseError(response)
	}
	body, err := readBounded(response.Body, c.maxResponseBytes)
	if err != nil {
		return ProbeResult{}, err
	}
	var payload struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return ProbeResult{}, fmt.Errorf("decode Bitbucket Data Center version probe: %w", err)
	}
	if payload.Version == "" {
		return ProbeResult{}, fmt.Errorf("Bitbucket Data Center version probe did not return a version")
	}
	capabilities := c.capabilitiesForVersion(payload.Version)
	c.capabilitiesMu.Lock()
	c.probedCapabilities = cloneCapabilities(capabilities)
	c.capabilitiesMu.Unlock()
	return ProbeResult{Version: payload.Version, Capabilities: capabilities}, nil
}

func (c *Client) capabilitiesForVersion(version string) domain.Capabilities {
	capabilities := cloneCapabilities(c.connection.Capabilities)
	capabilities[domain.CapabilityBranches] = true
	capabilities[domain.CapabilityPullRequests] = true
	capabilities[domain.CapabilityReview] = true
	capabilities[domain.CapabilityApprove] = true
	capabilities[domain.CapabilityMerge] = true
	capabilities[domain.CapabilityDecline] = true
	capabilities[domain.CapabilityComments] = true
	capabilities[domain.CapabilityThreadReplies] = true
	capabilities[domain.CapabilityBuildStatuses] = true
	capabilities[domain.CapabilityBuildActions] = false
	capabilities[domain.CapabilityIssues] = false
	// An incoming application link is configured by selecting OAuth. Its support
	// is not a server-version proxy: OAuth scopes control the individual actions.
	capabilities[domain.CapabilityIncomingOAuth] = c.authentication.Mode == AuthenticationOAuth
	return capabilities
}

type repositoryPage struct {
	IsLastPage    bool                `json:"isLastPage"`
	NextPageStart int                 `json:"nextPageStart"`
	Values        []repositoryPayload `json:"values"`
}

type repositoryPayload struct {
	ID            int    `json:"id"`
	Slug          string `json:"slug"`
	DefaultBranch string `json:"defaultBranch"`
	Project       struct {
		Key string `json:"key"`
	} `json:"project"`
	Links struct {
		Clone []struct {
			Name string `json:"name"`
			Href string `json:"href"`
		} `json:"clone"`
	} `json:"links"`
}

func (c *Client) repositoryPage(ctx context.Context, endpoint *url.URL, name string, start, pageLength int) (repositoryPage, error) {
	if c.tokenSource == nil {
		return repositoryPage{}, fmt.Errorf("Data Center token source is not configured")
	}
	token, _, err := c.accessToken(ctx)
	if err != nil {
		return repositoryPage{}, fmt.Errorf("resolve Data Center access token: %w", err)
	}
	requestURL := *endpoint
	query := requestURL.Query()
	query.Set("start", fmt.Sprint(start))
	query.Set("limit", fmt.Sprint(pageLength))
	if name != "" {
		query.Set("name", name)
	}
	requestURL.RawQuery = query.Encode()
	for attempt := 0; attempt < 3; attempt++ {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL.String(), nil)
		if err != nil {
			return repositoryPage{}, err
		}
		request.Header.Set("Accept", "application/json")
		if err := c.authorize(request, token); err != nil {
			return repositoryPage{}, err
		}
		response, err := c.httpClient.Do(request)
		if err != nil {
			return repositoryPage{}, fmt.Errorf("request Bitbucket Data Center: %w", err)
		}
		if (response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= http.StatusInternalServerError) && attempt < 2 {
			delay := c.retryDelay(attempt, retryAfter(response.Header.Get("Retry-After")))
			response.Body.Close()
			if err := wait(ctx, delay); err != nil {
				return repositoryPage{}, err
			}
			continue
		}
		if response.StatusCode != http.StatusOK {
			responseErr := providerResponseError(response)
			response.Body.Close()
			return repositoryPage{}, responseErr
		}
		body, err := readBounded(response.Body, c.maxResponseBytes)
		response.Body.Close()
		if err != nil {
			return repositoryPage{}, err
		}
		var page repositoryPage
		if err := json.Unmarshal(body, &page); err != nil {
			return repositoryPage{}, fmt.Errorf("decode Bitbucket Data Center repositories: %w", err)
		}
		return page, nil
	}
	return repositoryPage{}, fmt.Errorf("Bitbucket Data Center repository retry limit exceeded")
}

func (c *Client) mapRepository(payload repositoryPayload) (domain.Repository, error) {
	if !isPathSegment(payload.Project.Key) || !isPathSegment(payload.Slug) {
		return domain.Repository{}, fmt.Errorf("Data Center repository project and slug must be URL path segments")
	}
	repository := domain.Repository{Namespace: payload.Project.Key, Slug: payload.Slug, DefaultBranch: payload.DefaultBranch}
	expectedCloneURL, err := c.connection.CloneURL(repository)
	if err != nil {
		return domain.Repository{}, err
	}
	for _, clone := range payload.Links.Clone {
		if clone.Name != expectedCloneURL.Scheme {
			continue
		}
		cloneURL, err := url.Parse(clone.Href)
		if err != nil || cloneURL.User != nil || cloneURL.RawQuery != "" || cloneURL.Fragment != "" || !sameOrigin(cloneURL, expectedCloneURL) || cloneURL.Path != expectedCloneURL.Path {
			return domain.Repository{}, fmt.Errorf("Data Center repository has invalid HTTPS clone URL")
		}
		if payload.ID <= 0 {
			return domain.Repository{}, fmt.Errorf("Data Center repository has no immutable ID")
		}
		repository.ID = strconv.Itoa(payload.ID)
		repository.ProviderScope = c.connection.Scope
		repository.CloneURL = expectedCloneURL
		return repository, nil
	}
	return domain.Repository{}, fmt.Errorf("Data Center repository has no HTTPS clone URL")
}

func hardenedHTTPClient(base *http.Client, origin *url.URL) *http.Client {
	if base == nil {
		base = &http.Client{}
	}
	client := *base
	if client.Timeout == 0 {
		client.Timeout = 15 * time.Second
	}
	client.CheckRedirect = func(request *http.Request, _ []*http.Request) error {
		if !sameOrigin(request.URL, origin) {
			return fmt.Errorf("redirect changed Data Center origin")
		}
		return nil
	}
	return &client
}

func readBounded(body io.Reader, maxBytes int64) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(body, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("Bitbucket response exceeds %d-byte limit", maxBytes)
	}
	return data, nil
}

func sameOrigin(left, right *url.URL) bool {
	return strings.EqualFold(left.Scheme, right.Scheme) && strings.EqualFold(left.Host, right.Host)
}

func isPathSegment(value string) bool {
	return value != "" && !strings.ContainsAny(value, "/\\?#")
}

func min(left, right int) int {
	if left < right {
		return left
	}
	return right
}

func cloneCapabilities(capabilities domain.Capabilities) domain.Capabilities {
	copy := make(domain.Capabilities, len(capabilities)+1)
	for capability, supported := range capabilities {
		copy[capability] = supported
	}
	return copy
}

func defaultRetryDelay(attempt int, retryAfterDelay time.Duration) time.Duration {
	if retryAfterDelay > 0 {
		return retryAfterDelay
	}
	return time.Duration(1<<attempt) * 100 * time.Millisecond
}

func retryAfter(value string) time.Duration {
	seconds, err := strconv.Atoi(value)
	if err != nil || seconds < 0 {
		return 0
	}
	return time.Duration(seconds) * time.Second
}

func wait(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		return nil
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

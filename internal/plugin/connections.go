package plugin

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"path"
	"strings"
	"sync"
	"time"

	"kandev-plugin-bitbucket/internal/auth"
	"kandev-plugin-bitbucket/internal/cloud"
	"kandev-plugin-bitbucket/internal/datacenter"
	"kandev-plugin-bitbucket/internal/domain"

	"github.com/kandev/kandev/pkg/pluginsdk"
)

const connectionStateKey = "bitbucket.connection.v1"

const maxOAuthFlowsPerWorkspace = 32

// ConnectionInput accepts a credential only for the duration of the action.
// Token is deliberately excluded from ConnectionSettings and host state.
type ConnectionInput struct {
	Product           domain.Product `json:"product"`
	BaseURL           string         `json:"base_url"`
	CloudWorkspace    string         `json:"cloud_workspace"`
	AuthMethod        string         `json:"auth_method"`
	AuthIdentity      string         `json:"auth_identity"`
	Token             string         `json:"token"`
	OAuthClientID     string         `json:"oauth_client_id"`
	OAuthClientSecret string         `json:"oauth_client_secret"`
	OAuthRedirectURL  string         `json:"oauth_redirect_url"`
}

// ConnectionSettings is the credential-free workspace connection record.
type ConnectionSettings struct {
	Product              domain.Product `json:"product"`
	BaseURL              string         `json:"base_url,omitempty"`
	CloudWorkspace       string         `json:"cloud_workspace,omitempty"`
	AuthMethod           string         `json:"auth_method,omitempty"`
	AuthIdentity         string         `json:"auth_identity,omitempty"`
	OAuthClientID        string         `json:"oauth_client_id,omitempty"`
	OAuthRedirectURL     string         `json:"oauth_redirect_url,omitempty"`
	OAuthGeneration      uint64         `json:"oauth_generation,omitempty"`
	CredentialGeneration uint64         `json:"credential_generation,omitempty"`
}

// ConnectionSettingsStore is the optional mutable part of ProviderResolver.
// Test resolvers can stay read-only while production resolver owns settings.
type ConnectionSettingsStore interface {
	Load(context.Context, string) (ConnectionSettings, bool, error)
	Save(context.Context, string, ConnectionInput) (ConnectionSettings, error)
}

// ConnectionResolver builds short-lived provider clients from host-owned
// connection state and secrets. It never caches or persists plaintext tokens.
type ConnectionResolver struct {
	host       pluginsdk.Host
	httpClient *http.Client

	// Test-only seams. Production action input cannot override provider endpoints.
	cloudAPIBaseOverride  *url.URL
	oauthEndpointOverride *oauthEndpointPair

	refresherMu  sync.Mutex
	refresher    *auth.Refresher
	connectionMu sync.Mutex
	oauthMu      sync.Mutex
	oauthState   map[string]*auth.StateManager
	oauthFlows   map[string]oauthFlow
	oauthEpoch   map[string]uint64
}

type oauthEndpointPair struct {
	authorization *url.URL
	token         *url.URL
}

type oauthFlow struct {
	registration auth.OAuthRegistration
	scope        auth.CredentialScope
	states       *auth.StateManager
	epoch        uint64
	expiresAt    time.Time
}

type oauthRegistrationSecret struct {
	ClientSecret string `json:"client_secret"`
}

type secretWrite struct {
	key   string
	value string
}

type secretSnapshot struct {
	key   string
	value string
	found bool
}

func NewConnectionResolver(host pluginsdk.Host) (*ConnectionResolver, error) {
	if host == nil {
		return nil, fmt.Errorf("connection host is required")
	}
	return &ConnectionResolver{
		host: host, oauthState: make(map[string]*auth.StateManager), oauthFlows: make(map[string]oauthFlow), oauthEpoch: make(map[string]uint64),
	}, nil
}

func (r *ConnectionResolver) Load(ctx context.Context, workspaceID string) (ConnectionSettings, bool, error) {
	if workspaceID == "" {
		return ConnectionSettings{}, false, fmt.Errorf("workspace id is required")
	}
	value, found, err := r.host.GetState(ctx, "workspace", workspaceID, connectionStateKey)
	if err != nil {
		return ConnectionSettings{}, false, fmt.Errorf("load Bitbucket connection: %w", err)
	}
	if !found {
		return ConnectionSettings{}, false, nil
	}
	var settings ConnectionSettings
	if err := decodeState(value, &settings); err != nil {
		return ConnectionSettings{}, false, fmt.Errorf("decode Bitbucket connection: %w", err)
	}
	if err := validateConnection(settings); err != nil {
		return ConnectionSettings{}, false, fmt.Errorf("stored Bitbucket connection is invalid: %w", err)
	}
	return settings, true, nil
}

func (r *ConnectionResolver) Save(ctx context.Context, workspaceID string, input ConnectionInput) (ConnectionSettings, error) {
	if workspaceID == "" {
		return ConnectionSettings{}, fmt.Errorf("workspace id is required")
	}
	r.connectionMu.Lock()
	defer r.connectionMu.Unlock()
	previous, found, err := r.Load(ctx, workspaceID)
	if err != nil {
		return ConnectionSettings{}, err
	}
	credentialGeneration, err := nextCredentialGeneration(previous, found)
	if err != nil {
		return ConnectionSettings{}, err
	}
	settings := ConnectionSettings{
		Product: input.Product, BaseURL: strings.TrimSpace(input.BaseURL),
		CloudWorkspace: strings.TrimSpace(input.CloudWorkspace), AuthMethod: normalizedAuthMethod(input.AuthMethod), AuthIdentity: strings.TrimSpace(input.AuthIdentity),
		CredentialGeneration: credentialGeneration,
	}
	if settings.AuthMethod == "oauth" {
		if strings.TrimSpace(input.Token) != "" {
			return ConnectionSettings{}, fmt.Errorf("Bitbucket OAuth does not accept a token credential")
		}
		if err := r.configureOAuthSettings(ctx, workspaceID, &settings, previous, found, input); err != nil {
			return ConnectionSettings{}, err
		}
	}
	if settings.CloudWorkspace == "" && settings.Product == domain.ProductCloud {
		return ConnectionSettings{}, fmt.Errorf("Bitbucket Cloud workspace is required")
	}
	if err := validateConnection(settings); err != nil {
		return ConnectionSettings{}, err
	}
	if err := r.validateTokenCredential(ctx, workspaceID, settings, previous, found, input.Token); err != nil {
		return ConnectionSettings{}, err
	}
	writes := connectionSecretWrites(workspaceID, settings, input)
	deleteKeys := supersededCredentialKeys(workspaceID, previous, found, settings)
	snapshots, err := r.snapshotSecrets(ctx, mutationSecretKeys(writes, deleteKeys))
	if err != nil {
		return ConnectionSettings{}, err
	}
	if err := r.writeSecrets(ctx, writes); err != nil {
		_ = r.restoreSecrets(ctx, snapshots)
		return ConnectionSettings{}, err
	}
	value, err := encodeState(settings)
	if err != nil {
		_ = r.restoreSecrets(ctx, snapshots)
		return ConnectionSettings{}, fmt.Errorf("encode Bitbucket connection: %w", err)
	}
	if err := r.host.SetState(ctx, "workspace", workspaceID, connectionStateKey, value); err != nil {
		_ = r.restoreSecrets(ctx, snapshots)
		return ConnectionSettings{}, fmt.Errorf("save Bitbucket connection: %w", err)
	}
	if err := r.revokeSupersededCredentials(ctx, workspaceID, previous, found, settings); err != nil {
		_ = r.restoreSecrets(ctx, snapshots)
		_ = r.restoreConnectionState(ctx, workspaceID, previous, found)
		return ConnectionSettings{}, err
	}
	return settings, nil
}

func (r *ConnectionResolver) restoreConnectionState(ctx context.Context, workspaceID string, previous ConnectionSettings, found bool) error {
	if !found {
		return r.host.DeleteState(ctx, "workspace", workspaceID, connectionStateKey)
	}
	value, err := encodeState(previous)
	if err != nil {
		return err
	}
	return r.host.SetState(ctx, "workspace", workspaceID, connectionStateKey, value)
}

func (r *ConnectionResolver) validateTokenCredential(
	ctx context.Context,
	workspaceID string,
	settings, previous ConnectionSettings,
	found bool,
	token string,
) error {
	if settings.AuthMethod == "oauth" || strings.TrimSpace(token) != "" {
		return nil
	}
	if !found || previous.Product != settings.Product || previous.AuthMethod != settings.AuthMethod || previous.AuthIdentity != settings.AuthIdentity {
		return fmt.Errorf("Bitbucket token credential is required")
	}
	stored, present, err := r.host.GetSecret(ctx, connectionSecretKey(workspaceID))
	if err != nil {
		return fmt.Errorf("load Bitbucket credential: %w", err)
	}
	if !present || strings.TrimSpace(stored) == "" {
		return fmt.Errorf("Bitbucket token credential is required")
	}
	return nil
}

// Disconnect removes every workspace-scoped connection artifact. Connection
// state is deleted first, so all fresh provider and broker resolution fails
// closed even if a later best-effort secret deletion reports an error.
func (r *ConnectionResolver) Disconnect(ctx context.Context, workspaceID string) error {
	if workspaceID == "" {
		return fmt.Errorf("workspace id is required")
	}
	r.connectionMu.Lock()
	defer r.connectionMu.Unlock()
	value, found, err := r.host.GetState(ctx, "workspace", workspaceID, connectionStateKey)
	if err != nil {
		return fmt.Errorf("load Bitbucket connection: %w", err)
	}
	var settings ConnectionSettings
	if found {
		_ = decodeState(value, &settings)
	}
	r.invalidateOAuthWorkspace(workspaceID)
	if err := r.host.DeleteState(ctx, "workspace", workspaceID, connectionStateKey); err != nil {
		return fmt.Errorf("delete Bitbucket connection: %w", err)
	}
	keys := []string{
		connectionSecretKey(workspaceID), oauthRegistrationSecretKey(workspaceID), oauthStateSecretKey(workspaceID),
	}
	if settings.OAuthGeneration != 0 {
		keys = append(keys, oauthCredentialSecretKey(workspaceID, settings.OAuthGeneration))
	}
	return r.deleteSecrets(ctx, keys...)
}

func nextCredentialGeneration(previous ConnectionSettings, found bool) (uint64, error) {
	if !found || previous.CredentialGeneration == 0 {
		return 1, nil
	}
	if previous.CredentialGeneration == ^uint64(0) {
		return 0, fmt.Errorf("Bitbucket credential generation exhausted")
	}
	return previous.CredentialGeneration + 1, nil
}

func (r *ConnectionResolver) Provider(ctx context.Context, workspaceID string) (domain.Provider, error) {
	settings, found, err := r.Load(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, fmt.Errorf("Bitbucket connection is not configured")
	}
	tokens, err := r.tokenSource(ctx, workspaceID, settings)
	if err != nil {
		return nil, err
	}
	switch settings.Product {
	case domain.ProductCloud:
		authentication, authErr := cloudAuthentication(settings)
		if authErr != nil {
			return nil, authErr
		}
		options := cloud.ClientOptions{TokenSource: tokens, HTTPClient: r.httpClient, Authentication: authentication, APIBase: r.cloudAPIBaseOverride}
		return repositorySearchProvider{Provider: cloud.NewClient(options), workspace: settings.CloudWorkspace}, nil
	case domain.ProductDataCenter:
		authentication, authErr := dataCenterAuthentication(settings)
		if authErr != nil {
			return nil, authErr
		}
		provider, clientErr := datacenter.NewClient(datacenter.ClientOptions{
			ConnectionOptions: datacenter.ConnectionOptions{BaseURL: settings.BaseURL}, HTTPClient: r.httpClient, TokenSource: tokens, Authentication: authentication,
		})
		if clientErr != nil {
			return nil, clientErr
		}
		return repositorySearchProvider{Provider: provider}, nil
	default:
		return nil, fmt.Errorf("unsupported Bitbucket product")
	}
}

func (r *ConnectionResolver) tokenSource(ctx context.Context, workspaceID string, settings ConnectionSettings) (interface {
	AccessToken(context.Context) (string, error)
}, error) {
	if settings.AuthMethod != "oauth" {
		return hostTokenSource{host: r.host, key: connectionSecretKey(workspaceID)}, nil
	}
	registration, err := r.oauthRegistration(ctx, workspaceID, settings)
	if err != nil {
		return nil, err
	}
	scope := auth.CredentialScope{WorkspaceID: workspaceID, Generation: settings.OAuthGeneration}
	return auth.NewRefreshingTokenSource(scope, registration, hostOAuthCredentialRepository{host: r.host}, r.oauthRefresher(), time.Now), nil
}

func (r *ConnectionResolver) oauthRefresher() *auth.Refresher {
	r.refresherMu.Lock()
	defer r.refresherMu.Unlock()
	if r.refresher == nil {
		r.refresher = auth.NewRefresher(r.httpClient, time.Now)
	}
	return r.refresher
}

// StartOAuth begins a BYO OAuth authorization-code flow. Credentials
// are exchanged only by the callback and are kept in host secret storage.
func (r *ConnectionResolver) StartOAuth(ctx context.Context, workspaceID string) (*url.URL, error) {
	settings, found, err := r.Load(ctx, workspaceID)
	if err != nil || !found || settings.AuthMethod != "oauth" {
		return nil, fmt.Errorf("Bitbucket OAuth is not configured")
	}
	registration, err := r.oauthRegistration(ctx, workspaceID, settings)
	if err != nil {
		return nil, err
	}
	states, err := r.oauthStateManager(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	scope := auth.CredentialScope{WorkspaceID: workspaceID, Generation: settings.OAuthGeneration}
	r.oauthMu.Lock()
	epoch := r.oauthEpoch[workspaceID]
	r.oauthMu.Unlock()
	request, err := auth.StartAuthorization(ctx, states, scope, registration, oauthScopes(settings.Product))
	if err != nil {
		return nil, err
	}
	r.oauthMu.Lock()
	if epoch != r.oauthEpoch[workspaceID] {
		r.oauthMu.Unlock()
		return nil, fmt.Errorf("Bitbucket OAuth connection was revoked")
	}
	r.purgeOAuthFlowsLocked(time.Now())
	r.evictOAuthFlowLocked(workspaceID)
	r.oauthFlows[request.State] = oauthFlow{registration: registration, scope: scope, states: states, epoch: epoch, expiresAt: request.ExpiresAt}
	r.oauthMu.Unlock()
	return request.URL, nil
}

// HandleOAuthCallback validates and consumes a PKCE state exactly once before
// exchanging the code and saving a generation-bound rotating credential.
func (r *ConnectionResolver) HandleOAuthCallback(ctx context.Context, state, code string) (*pluginsdk.WebhookResponse, error) {
	r.oauthMu.Lock()
	flow, found := r.oauthFlows[state]
	if found {
		delete(r.oauthFlows, state)
	}
	if found && (flow.epoch != r.oauthEpoch[flow.scope.WorkspaceID] || !flow.expiresAt.After(time.Now())) {
		found = false
	}
	r.oauthMu.Unlock()
	if !found || flow.states == nil || code == "" {
		return nil, fmt.Errorf("invalid Bitbucket OAuth callback")
	}
	credential, err := r.oauthRefresher().ExchangeAuthorizationCode(ctx, flow.states, state, code, flow.registration)
	if err != nil {
		return nil, fmt.Errorf("complete Bitbucket OAuth: %w", err)
	}
	r.oauthMu.Lock()
	defer r.oauthMu.Unlock()
	if flow.epoch != r.oauthEpoch[flow.scope.WorkspaceID] {
		return nil, fmt.Errorf("Bitbucket OAuth connection was revoked")
	}
	if err := (hostOAuthCredentialRepository{host: r.host}).SaveCredential(ctx, flow.scope, credential); err != nil {
		return nil, err
	}
	return &pluginsdk.WebhookResponse{Status: http.StatusOK, Headers: map[string]string{"Content-Type": "text/plain; charset=utf-8"}, Body: []byte("Bitbucket connected. You can close this window.")}, nil
}

// ValidateGitCredentialScope proves that a host-verified broker request still
// targets this workspace's configured Bitbucket clone endpoint. The adapter
// token is never returned until this check succeeds.
func (r *ConnectionResolver) ValidateGitCredentialScope(ctx context.Context, scope GitCredentialScope) error {
	settings, found, err := r.Load(ctx, scope.WorkspaceID)
	if err != nil || !found || scope.TaskID == "" || scope.RepositoryID == "" || scope.Host == "" ||
		!strings.HasPrefix(scope.Path, "/") || strings.ContainsAny(scope.Path, "?#\\") {
		return ErrCredentialUnavailable
	}
	hostURL, err := url.Parse("https://" + scope.Host)
	if err != nil || hostURL.Host != scope.Host || hostURL.Path != "" || hostURL.RawQuery != "" || hostURL.Fragment != "" {
		return ErrCredentialUnavailable
	}
	if r.matchesTaskRepositoryScope(ctx, settings, scope) {
		return nil
	}
	return ErrCredentialUnavailable
}

// GitCredentialBinding returns the current non-secret connection generation
// only after the exact task/repository clone scope remains valid. It never
// constructs a provider client or reads a credential secret.
func (r *ConnectionResolver) GitCredentialBinding(ctx context.Context, scope GitCredentialScope) (string, error) {
	settings, found, err := r.Load(ctx, scope.WorkspaceID)
	if err != nil || !found || settings.CredentialGeneration == 0 {
		return "", ErrCredentialUnavailable
	}
	if err := r.ValidateGitCredentialScope(ctx, scope); err != nil {
		return "", ErrCredentialUnavailable
	}
	return fmt.Sprintf("bitbucket-credential:%d", settings.CredentialGeneration), nil
}

// matchesTaskRepositoryScope permits a fork only when the host-verified task
// points at one exact Bitbucket repository and its credential-free clone URL
// is the requested host/path. It never trusts a browser repository value.
func (r *ConnectionResolver) matchesTaskRepositoryScope(ctx context.Context, settings ConnectionSettings, scope GitCredentialScope) bool {
	task, err := r.host.Tasks().Get(ctx, scope.TaskID)
	if err != nil || task == nil || task.ID != scope.TaskID || task.WorkspaceID != scope.WorkspaceID {
		return false
	}
	matched := false
	for _, taskRepository := range task.Repositories {
		if taskRepository.RepositoryID == scope.RepositoryID {
			if matched {
				return false
			}
			matched = true
		}
	}
	if !matched {
		return false
	}
	page := pluginsdk.Page{Limit: 100}
	for {
		repositories, info, listErr := r.host.Repositories().List(ctx, scope.WorkspaceID, page)
		if listErr != nil {
			return false
		}
		for _, repository := range repositories {
			if repository.ID != scope.RepositoryID || repository.SourceType != "provider" || repository.ProviderID != "bitbucket" ||
				repository.ProviderRepositoryID == "" || repository.ProviderHost == "" || repository.OwnerOrProject == "" ||
				repository.ProviderName == "" || repository.RemoteURL == "" {
				continue
			}
			cloneURL, parseErr := url.Parse(repository.RemoteURL)
			if parseErr != nil || cloneURL.Scheme != "https" || cloneURL.User != nil || cloneURL.RawPath != "" ||
				cloneURL.RawQuery != "" || cloneURL.Fragment != "" || !strings.EqualFold(cloneURL.Host, scope.Host) ||
				!providerHostMatches(repository.ProviderHost, cloneURL) {
				return false
			}
			owner, name, valid := repositoryIdentity(settings, cloneURL)
			if !valid || !strings.EqualFold(repository.OwnerOrProject, owner) || repository.ProviderName != name {
				return false
			}
			return normalizedClonePath(cloneURL.Path) == normalizedClonePath(scope.Path)
		}
		if info == nil || !info.HasMore || info.NextCursor == "" {
			return false
		}
		page.Cursor = info.NextCursor
	}
}

// providerHostMatches accepts the current host contract (an HTTPS origin)
// plus the pre-origin legacy hostname while rejecting paths and credentials.
func providerHostMatches(raw string, cloneURL *url.URL) bool {
	value := strings.TrimSpace(raw)
	if value == "" || cloneURL == nil {
		return false
	}
	if !strings.Contains(value, "://") {
		return strings.EqualFold(value, cloneURL.Host)
	}
	origin, err := url.Parse(value)
	if err != nil || origin.Scheme != "https" || origin.User != nil || origin.Host == "" ||
		(origin.Path != "" && origin.Path != "/") || origin.RawPath != "" || origin.RawQuery != "" || origin.Fragment != "" {
		return false
	}
	return strings.EqualFold(origin.Host, cloneURL.Host)
}

func repositoryIdentity(settings ConnectionSettings, cloneURL *url.URL) (string, string, bool) {
	if cloneURL == nil {
		return "", "", false
	}
	var relative string
	switch settings.Product {
	case domain.ProductCloud:
		if !strings.EqualFold(cloneURL.Host, "bitbucket.org") {
			return "", "", false
		}
		relative = strings.Trim(cloneURL.Path, "/")
	case domain.ProductDataCenter:
		base, err := url.Parse(settings.BaseURL)
		if err != nil || !strings.EqualFold(base.Host, cloneURL.Host) {
			return "", "", false
		}
		prefix := strings.TrimSuffix(base.Path, "/") + "/scm/"
		if !strings.HasPrefix(cloneURL.Path, prefix) {
			return "", "", false
		}
		relative = strings.TrimPrefix(cloneURL.Path, prefix)
	default:
		return "", "", false
	}
	parts := strings.Split(strings.Trim(relative, "/"), "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", "", false
	}
	name := strings.TrimSuffix(parts[1], ".git")
	if name == "" {
		return "", "", false
	}
	return parts[0], name, true
}

func normalizedClonePath(value string) string {
	return strings.TrimSuffix(strings.TrimSuffix(value, "/"), ".git")
}

func validateConnection(settings ConnectionSettings) error {
	if err := validateConnectionAuthentication(settings); err != nil {
		return err
	}
	switch settings.Product {
	case domain.ProductCloud:
		if settings.CloudWorkspace == "" {
			return fmt.Errorf("Bitbucket Cloud workspace is required")
		}
		if settings.BaseURL != "" {
			return fmt.Errorf("Bitbucket Cloud API endpoint is fixed")
		}
	case domain.ProductDataCenter:
		if settings.BaseURL == "" {
			return fmt.Errorf("Bitbucket Data Center URL is required")
		}
		if _, err := datacenter.NewConnection(datacenter.ConnectionOptions{BaseURL: settings.BaseURL}); err != nil {
			return err
		}
	default:
		return fmt.Errorf("Bitbucket product must be cloud or data_center")
	}
	return nil
}

func normalizedAuthMethod(method string) string {
	method = strings.ToLower(strings.TrimSpace(method))
	return method
}

func oauthScopes(product domain.Product) []string {
	if product == domain.ProductDataCenter {
		return []string{"REPO_READ", "REPO_WRITE"}
	}
	return []string{"account", "repository", "repository:write", "pullrequest", "pullrequest:write"}
}

func validateConnectionAuthentication(settings ConnectionSettings) error {
	switch normalizedAuthMethod(settings.AuthMethod) {
	case "":
		return fmt.Errorf("Bitbucket authentication method is required")
	case "oauth":
		if settings.OAuthGeneration == 0 || settings.OAuthClientID == "" || settings.OAuthRedirectURL == "" {
			return fmt.Errorf("Bitbucket OAuth client registration is required")
		}
		if settings.Product == domain.ProductDataCenter && strings.TrimSpace(settings.AuthIdentity) == "" {
			return fmt.Errorf("Bitbucket Data Center OAuth Git username is required")
		}
		return nil
	case "api_token":
		if settings.Product != domain.ProductCloud {
			return fmt.Errorf("Bitbucket Data Center authentication method must be user_pat, project_token, repository_token, or oauth")
		}
		if strings.TrimSpace(settings.AuthIdentity) == "" {
			return fmt.Errorf("Bitbucket Cloud API-token email is required")
		}
		return nil
	case "user_pat":
		if settings.Product != domain.ProductDataCenter {
			return fmt.Errorf("Bitbucket Cloud authentication method must be api_token or oauth")
		}
		if strings.TrimSpace(settings.AuthIdentity) == "" {
			return fmt.Errorf("Bitbucket Data Center user PAT username is required")
		}
		return nil
	case "project_token", "repository_token":
		if settings.Product != domain.ProductDataCenter {
			return fmt.Errorf("Bitbucket Cloud authentication method must be api_token or oauth")
		}
		return nil
	default:
		return fmt.Errorf("unsupported Bitbucket authentication method")
	}
}

func cloudAuthentication(settings ConnectionSettings) (cloud.Authentication, error) {
	switch normalizedAuthMethod(settings.AuthMethod) {
	case "oauth":
		return cloud.Authentication{Mode: cloud.AuthenticationOAuth}, nil
	case "api_token":
		return cloud.Authentication{Mode: cloud.AuthenticationAPIToken, Email: settings.AuthIdentity}, nil
	default:
		return cloud.Authentication{}, fmt.Errorf("unsupported Bitbucket Cloud authentication method")
	}
}

func dataCenterAuthentication(settings ConnectionSettings) (datacenter.Authentication, error) {
	switch normalizedAuthMethod(settings.AuthMethod) {
	case "oauth":
		return datacenter.Authentication{Mode: datacenter.AuthenticationOAuth, Username: settings.AuthIdentity}, nil
	case "user_pat":
		return datacenter.Authentication{Mode: datacenter.AuthenticationPAT, Username: settings.AuthIdentity}, nil
	case "project_token":
		return datacenter.Authentication{Mode: datacenter.AuthenticationProjectToken}, nil
	case "repository_token":
		return datacenter.Authentication{Mode: datacenter.AuthenticationRepositoryToken}, nil
	default:
		return datacenter.Authentication{}, fmt.Errorf("unsupported Bitbucket Data Center authentication method")
	}
}

func (r *ConnectionResolver) configureOAuthSettings(
	ctx context.Context,
	workspaceID string,
	settings *ConnectionSettings,
	previous ConnectionSettings,
	found bool,
	input ConnectionInput,
) error {
	clientID := strings.TrimSpace(input.OAuthClientID)
	clientSecret := strings.TrimSpace(input.OAuthClientSecret)
	redirectURL := strings.TrimSpace(input.OAuthRedirectURL)
	canReuse := found && previous.AuthMethod == "oauth" && previous.Product == settings.Product && clientSecret == ""
	if canReuse {
		if (clientID != "" && clientID != previous.OAuthClientID) || (redirectURL != "" && redirectURL != previous.OAuthRedirectURL) {
			return fmt.Errorf("Bitbucket OAuth client secret is required when registration changes")
		}
		configured, err := r.oauthRegistrationConfigured(ctx, workspaceID)
		if err != nil {
			return err
		}
		if !configured {
			return fmt.Errorf("Bitbucket OAuth client registration is required")
		}
		settings.OAuthClientID = previous.OAuthClientID
		settings.OAuthRedirectURL = previous.OAuthRedirectURL
		settings.OAuthGeneration = previous.OAuthGeneration
		return nil
	}
	if clientID == "" || clientSecret == "" || redirectURL == "" {
		return fmt.Errorf("Bitbucket OAuth client id, client secret, and redirect URL are required")
	}
	settings.OAuthClientID = clientID
	settings.OAuthRedirectURL = redirectURL
	if err := validateHTTPSURL(settings.OAuthRedirectURL, "Bitbucket OAuth redirect URL"); err != nil {
		return err
	}
	settings.OAuthGeneration = previous.OAuthGeneration + 1
	if settings.OAuthGeneration == 0 {
		settings.OAuthGeneration = 1
	}
	return nil
}

func (r *ConnectionResolver) oauthRegistrationConfigured(ctx context.Context, workspaceID string) (bool, error) {
	secret, found, err := r.host.GetSecret(ctx, oauthRegistrationSecretKey(workspaceID))
	if err != nil {
		return false, fmt.Errorf("load Bitbucket OAuth client registration: %w", err)
	}
	if !found {
		return false, nil
	}
	var registration oauthRegistrationSecret
	if err := json.Unmarshal([]byte(secret), &registration); err != nil {
		return false, nil
	}
	return strings.TrimSpace(registration.ClientSecret) != "", nil
}

func (r *ConnectionResolver) revokeSupersededCredentials(ctx context.Context, workspaceID string, previous ConnectionSettings, found bool, next ConnectionSettings) error {
	if !found {
		return nil
	}
	previousOAuth := previous.AuthMethod == "oauth"
	nextOAuth := next.AuthMethod == "oauth"
	if previousOAuth && (!nextOAuth || previous.OAuthGeneration != next.OAuthGeneration) {
		r.invalidateOAuthWorkspace(workspaceID)
	}
	return r.deleteSecrets(ctx, supersededCredentialKeys(workspaceID, previous, found, next)...)
}

func supersededCredentialKeys(workspaceID string, previous ConnectionSettings, found bool, next ConnectionSettings) []string {
	if !found {
		return nil
	}
	previousOAuth := previous.AuthMethod == "oauth"
	nextOAuth := next.AuthMethod == "oauth"
	keys := make([]string, 0, 3)
	if previousOAuth && (!nextOAuth || previous.OAuthGeneration != next.OAuthGeneration) {
		keys = append(keys, oauthStateSecretKey(workspaceID))
		if previous.OAuthGeneration != 0 {
			keys = append(keys, oauthCredentialSecretKey(workspaceID, previous.OAuthGeneration))
		}
		if !nextOAuth {
			keys = append(keys, oauthRegistrationSecretKey(workspaceID))
		}
	}
	if !previousOAuth && nextOAuth {
		keys = append(keys, connectionSecretKey(workspaceID))
	}
	return keys
}

func (r *ConnectionResolver) invalidateOAuthWorkspace(workspaceID string) {
	r.oauthMu.Lock()
	defer r.oauthMu.Unlock()
	r.oauthEpoch[workspaceID]++
	delete(r.oauthState, workspaceID)
	for state, flow := range r.oauthFlows {
		if flow.scope.WorkspaceID == workspaceID {
			delete(r.oauthFlows, state)
		}
	}
}

func (r *ConnectionResolver) purgeOAuthFlowsLocked(now time.Time) {
	for state, flow := range r.oauthFlows {
		if !flow.expiresAt.After(now) {
			delete(r.oauthFlows, state)
		}
	}
}

func (r *ConnectionResolver) evictOAuthFlowLocked(workspaceID string) {
	count := 0
	var oldestState string
	var oldest time.Time
	for state, flow := range r.oauthFlows {
		if flow.scope.WorkspaceID != workspaceID {
			continue
		}
		count++
		if oldestState == "" || flow.expiresAt.Before(oldest) {
			oldestState = state
			oldest = flow.expiresAt
		}
	}
	if count >= maxOAuthFlowsPerWorkspace && oldestState != "" {
		delete(r.oauthFlows, oldestState)
	}
}

func (r *ConnectionResolver) deleteSecrets(ctx context.Context, keys ...string) error {
	var firstErr error
	for _, key := range keys {
		if err := r.host.DeleteSecret(ctx, key); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	if firstErr != nil {
		return fmt.Errorf("delete Bitbucket credential: %w", firstErr)
	}
	return nil
}

func (r *ConnectionResolver) oauthRegistration(ctx context.Context, workspaceID string, settings ConnectionSettings) (auth.OAuthRegistration, error) {
	secret, found, err := r.host.GetSecret(ctx, oauthRegistrationSecretKey(workspaceID))
	if err != nil || !found {
		return auth.OAuthRegistration{}, fmt.Errorf("Bitbucket OAuth client registration is unavailable")
	}
	var stored oauthRegistrationSecret
	if err := json.Unmarshal([]byte(secret), &stored); err != nil || strings.TrimSpace(stored.ClientSecret) == "" {
		return auth.OAuthRegistration{}, fmt.Errorf("Bitbucket OAuth client registration is unavailable")
	}
	authorization, token, endpointErr := r.oauthEndpoints(settings)
	redirect, redirectErr := url.Parse(settings.OAuthRedirectURL)
	if endpointErr != nil || redirectErr != nil {
		return auth.OAuthRegistration{}, fmt.Errorf("Bitbucket OAuth endpoints are invalid")
	}
	return auth.OAuthRegistration{ClientID: settings.OAuthClientID, ClientSecret: stored.ClientSecret, AuthorizationURL: authorization, TokenURL: token, RedirectURL: redirect}, nil
}

func (r *ConnectionResolver) oauthEndpoints(settings ConnectionSettings) (*url.URL, *url.URL, error) {
	if override := r.oauthEndpointOverride; override != nil {
		if override.authorization == nil || override.token == nil {
			return nil, nil, fmt.Errorf("OAuth endpoint test override is incomplete")
		}
		if err := validateHTTPSURL(override.authorization.String(), "Bitbucket OAuth authorization URL"); err != nil {
			return nil, nil, err
		}
		if err := validateHTTPSURL(override.token.String(), "Bitbucket OAuth token URL"); err != nil {
			return nil, nil, err
		}
		authorization := *override.authorization
		token := *override.token
		return &authorization, &token, nil
	}
	if settings.Product == domain.ProductCloud {
		authorization, _ := url.Parse("https://bitbucket.org/site/oauth2/authorize")
		token, _ := url.Parse("https://bitbucket.org/site/oauth2/access_token")
		return authorization, token, nil
	}
	if settings.Product != domain.ProductDataCenter {
		return nil, nil, fmt.Errorf("unsupported Bitbucket product")
	}
	if _, err := datacenter.NewConnection(datacenter.ConnectionOptions{BaseURL: settings.BaseURL}); err != nil {
		return nil, nil, err
	}
	base, err := url.Parse(settings.BaseURL)
	if err != nil {
		return nil, nil, err
	}
	base.Path = strings.TrimSuffix(path.Clean("/"+strings.TrimPrefix(base.Path, "/")), "/")
	if base.Path == "." || base.Path == "/" {
		base.Path = ""
	}
	base.RawPath = ""
	authorization := *base
	authorization.Path = path.Join(base.Path, "rest", "oauth2", "latest", "authorize")
	token := *base
	token.Path = path.Join(base.Path, "rest", "oauth2", "latest", "token")
	return &authorization, &token, nil
}

func connectionSecretWrites(workspaceID string, settings ConnectionSettings, input ConnectionInput) []secretWrite {
	writes := make([]secretWrite, 0, 2)
	if settings.AuthMethod == "oauth" && strings.TrimSpace(input.OAuthClientSecret) != "" {
		encoded, _ := json.Marshal(oauthRegistrationSecret{ClientSecret: input.OAuthClientSecret})
		writes = append(writes, secretWrite{key: oauthRegistrationSecretKey(workspaceID), value: string(encoded)})
	}
	if settings.AuthMethod != "oauth" {
		token := strings.TrimSpace(input.Token)
		if token == "" {
			return writes
		}
		writes = append(writes, secretWrite{key: connectionSecretKey(workspaceID), value: token})
	}
	return writes
}

func mutationSecretKeys(writes []secretWrite, deletes []string) []string {
	keys := make([]string, 0, len(writes)+len(deletes))
	seen := make(map[string]struct{}, cap(keys))
	for _, write := range writes {
		if _, exists := seen[write.key]; !exists {
			seen[write.key] = struct{}{}
			keys = append(keys, write.key)
		}
	}
	for _, key := range deletes {
		if _, exists := seen[key]; !exists {
			seen[key] = struct{}{}
			keys = append(keys, key)
		}
	}
	return keys
}

func (r *ConnectionResolver) snapshotSecrets(ctx context.Context, keys []string) ([]secretSnapshot, error) {
	snapshots := make([]secretSnapshot, 0, len(keys))
	for _, key := range keys {
		value, found, err := r.host.GetSecret(ctx, key)
		if err != nil {
			return nil, fmt.Errorf("load Bitbucket credential: %w", err)
		}
		snapshots = append(snapshots, secretSnapshot{key: key, value: value, found: found})
	}
	return snapshots, nil
}

func (r *ConnectionResolver) writeSecrets(ctx context.Context, writes []secretWrite) error {
	for _, write := range writes {
		if err := r.host.SetSecret(ctx, write.key, write.value); err != nil {
			return fmt.Errorf("store Bitbucket credential: %w", err)
		}
	}
	return nil
}

func (r *ConnectionResolver) restoreSecrets(ctx context.Context, snapshots []secretSnapshot) error {
	var firstErr error
	for _, snapshot := range snapshots {
		var err error
		if snapshot.found {
			err = r.host.SetSecret(ctx, snapshot.key, snapshot.value)
		} else {
			err = r.host.DeleteSecret(ctx, snapshot.key)
		}
		if err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func (r *ConnectionResolver) saveOAuthRegistration(ctx context.Context, workspaceID, clientSecret string) error {
	encoded, err := json.Marshal(oauthRegistrationSecret{ClientSecret: clientSecret})
	if err != nil {
		return err
	}
	if err := r.host.SetSecret(ctx, oauthRegistrationSecretKey(workspaceID), string(encoded)); err != nil {
		return fmt.Errorf("store Bitbucket OAuth client secret: %w", err)
	}
	return nil
}

func (r *ConnectionResolver) oauthStateManager(ctx context.Context, workspaceID string) (*auth.StateManager, error) {
	r.oauthMu.Lock()
	defer r.oauthMu.Unlock()
	if manager := r.oauthState[workspaceID]; manager != nil {
		return manager, nil
	}
	key, found, err := r.host.GetSecret(ctx, oauthStateSecretKey(workspaceID))
	if err != nil {
		return nil, err
	}
	if !found {
		value := make([]byte, 32)
		if _, err := rand.Read(value); err != nil {
			return nil, err
		}
		key = base64.RawURLEncoding.EncodeToString(value)
		if err := r.host.SetSecret(ctx, oauthStateSecretKey(workspaceID), key); err != nil {
			return nil, err
		}
	}
	manager, err := auth.NewStateManager([]byte(key), auth.NewMemoryPendingStore(), time.Now)
	if err != nil {
		return nil, err
	}
	r.oauthState[workspaceID] = manager
	return manager, nil
}

func oauthRegistrationSecretKey(workspaceID string) string {
	return workspaceSecretKey("bitbucket.oauth.registration.", workspaceID)
}
func oauthStateSecretKey(workspaceID string) string {
	return workspaceSecretKey("bitbucket.oauth.state.", workspaceID)
}
func oauthCredentialSecretKey(workspaceID string, generation uint64) string {
	return fmt.Sprintf("%s.%d", workspaceSecretKey("bitbucket.oauth.credential.", workspaceID), generation)
}

func workspaceSecretKey(prefix, workspaceID string) string {
	digest := sha256.Sum256([]byte(workspaceID))
	return prefix + hex.EncodeToString(digest[:16])
}

type hostOAuthCredentialRepository struct{ host pluginsdk.Host }

func (r hostOAuthCredentialRepository) LoadCredential(ctx context.Context, scope auth.CredentialScope) (auth.Credential, error) {
	encoded, found, err := r.host.GetSecret(ctx, oauthCredentialSecretKey(scope.WorkspaceID, scope.Generation))
	if err != nil || !found {
		return auth.Credential{}, fmt.Errorf("Bitbucket OAuth credential is unavailable")
	}
	var credential auth.Credential
	if err := json.Unmarshal([]byte(encoded), &credential); err != nil {
		return auth.Credential{}, fmt.Errorf("Bitbucket OAuth credential is unavailable")
	}
	return credential, nil
}

func (r hostOAuthCredentialRepository) SaveCredential(ctx context.Context, scope auth.CredentialScope, credential auth.Credential) error {
	encoded, err := json.Marshal(credential)
	if err != nil {
		return err
	}
	if err := r.host.SetSecret(ctx, oauthCredentialSecretKey(scope.WorkspaceID, scope.Generation), string(encoded)); err != nil {
		return fmt.Errorf("store Bitbucket OAuth credential: %w", err)
	}
	return nil
}

func validateHTTPSURL(raw, label string) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return fmt.Errorf("%s must be a credential-free HTTPS URL", label)
	}
	return nil
}

func connectionSecretKey(workspaceID string) string {
	digest := sha256.Sum256([]byte(workspaceID))
	return "bitbucket.token." + hex.EncodeToString(digest[:16])
}

type hostTokenSource struct {
	host pluginsdk.Host
	key  string
}

// repositorySearchProvider supplies the Cloud workspace internally and
// applies the optional generic repository query locally. Data Center ignores
// the workspace argument, so the same wrapper keeps the provider contract
// uniform across products.
type repositorySearchProvider struct {
	domain.Provider
	workspace string
}

func (p repositorySearchProvider) SearchPullRequestsPage(ctx context.Context, query domain.PullRequestQuery) (domain.PullRequestPage, error) {
	if pager, ok := p.Provider.(domain.PullRequestPager); ok {
		return pager.SearchPullRequestsPage(ctx, query)
	}
	pullRequests, err := p.Provider.SearchPullRequests(ctx, query)
	return domain.PullRequestPage{PullRequests: pullRequests}, err
}

func (p repositorySearchProvider) ListRepositories(ctx context.Context, query string, limit int) ([]domain.Repository, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return p.Provider.ListRepositories(ctx, p.workspace, limit)
	}
	if searcher, ok := p.Provider.(interface {
		SearchRepositories(context.Context, string, string, int) ([]domain.Repository, error)
	}); ok {
		return searcher.SearchRepositories(ctx, p.workspace, query, limit)
	}
	if searcher, ok := p.Provider.(interface {
		SearchRepositories(context.Context, string, int) ([]domain.Repository, error)
	}); ok {
		return searcher.SearchRepositories(ctx, query, limit)
	}

	repositories, err := p.Provider.ListRepositories(ctx, p.workspace, limit)
	if err != nil {
		return repositories, err
	}
	needle := strings.ToLower(query)
	filtered := make([]domain.Repository, 0, len(repositories))
	for _, repository := range repositories {
		if strings.Contains(strings.ToLower(repository.Namespace+"/"+repository.Slug), needle) {
			filtered = append(filtered, repository)
		}
	}
	return filtered, nil
}

func (s hostTokenSource) AccessToken(ctx context.Context) (string, error) {
	token, found, err := s.host.GetSecret(ctx, s.key)
	if err != nil || !found || strings.TrimSpace(token) == "" {
		return "", fmt.Errorf("Bitbucket authentication is required")
	}
	return token, nil
}

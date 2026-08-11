package plugin

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
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

var ErrInvalidConnectionInput = errors.New("invalid Bitbucket connection input")

func invalidConnectionInput(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalidConnectionInput, fmt.Sprintf(format, args...))
}

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
	// ConnectionBinding is a non-secret epoch used to fence persisted watches
	// from a later account, tenant, or server connection.
	ConnectionBinding string `json:"connection_binding,omitempty"`
	// Secret identifiers pending best-effort deletion after a committed
	// generation switch. Keeping this with the credential-free pointer makes
	// revocation retryable across process restarts without exposing plaintext.
	PendingSecretRevocations []string `json:"pending_secret_revocations,omitempty"`
	// Disconnected marks a fail-closed tombstone while secret revocation is
	// pending. Load hides tombstones from providers, while Disconnect and Save
	// retain enough generation metadata to finish cleanup after a restart.
	Disconnected bool `json:"disconnected,omitempty"`
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

func NewConnectionResolver(host pluginsdk.Host) (*ConnectionResolver, error) {
	if host == nil {
		return nil, fmt.Errorf("connection host is required")
	}
	return &ConnectionResolver{
		host: host, oauthState: make(map[string]*auth.StateManager), oauthFlows: make(map[string]oauthFlow), oauthEpoch: make(map[string]uint64),
	}, nil
}

func (r *ConnectionResolver) Load(ctx context.Context, workspaceID string) (ConnectionSettings, bool, error) {
	settings, found, err := r.loadConnectionRecord(ctx, workspaceID)
	if err != nil || !found {
		return settings, found, err
	}
	if settings.Disconnected {
		return ConnectionSettings{}, false, nil
	}
	if settings.ConnectionBinding == "" {
		settings, err = r.migrateConnectionBinding(ctx, workspaceID)
		if err != nil {
			return ConnectionSettings{}, false, err
		}
	}
	return settings, true, nil
}

func (r *ConnectionResolver) migrateConnectionBinding(ctx context.Context, workspaceID string) (ConnectionSettings, error) {
	r.connectionMu.Lock()
	defer r.connectionMu.Unlock()
	settings, found, err := r.loadConnectionRecord(ctx, workspaceID)
	if err != nil {
		return ConnectionSettings{}, err
	}
	if !found || settings.Disconnected {
		return ConnectionSettings{}, fmt.Errorf("Bitbucket connection is not configured")
	}
	if settings.ConnectionBinding != "" {
		return settings, nil
	}
	settings.ConnectionBinding, err = newConnectionBinding()
	if err != nil {
		return ConnectionSettings{}, err
	}
	value, err := encodeState(settings)
	if err != nil {
		return ConnectionSettings{}, fmt.Errorf("encode Bitbucket connection migration: %w", err)
	}
	if err := r.host.SetState(ctx, "workspace", workspaceID, connectionStateKey, value); err != nil {
		return ConnectionSettings{}, fmt.Errorf("save Bitbucket connection migration: %w", err)
	}
	return settings, nil
}

func (r *ConnectionResolver) loadConnectionRecord(ctx context.Context, workspaceID string) (ConnectionSettings, bool, error) {
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
	if settings.Disconnected {
		return settings, true, nil
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
	previous, found, err := r.loadConnectionRecord(ctx, workspaceID)
	if err != nil {
		return ConnectionSettings{}, err
	}
	if found && previous.Disconnected {
		if err := r.finishDisconnect(ctx, workspaceID, previous); err != nil {
			return ConnectionSettings{}, err
		}
		previous, found = ConnectionSettings{}, false
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
	if found && sameConnectionTarget(previous, settings) && previous.ConnectionBinding != "" {
		settings.ConnectionBinding = previous.ConnectionBinding
	} else {
		settings.ConnectionBinding, err = newConnectionBinding()
		if err != nil {
			return ConnectionSettings{}, err
		}
	}
	if settings.AuthMethod == "oauth" {
		if strings.TrimSpace(input.Token) != "" {
			return ConnectionSettings{}, invalidConnectionInput("Bitbucket OAuth does not accept a token credential")
		}
		if err := r.configureOAuthSettings(ctx, workspaceID, &settings, previous, found, input); err != nil {
			return ConnectionSettings{}, err
		}
	}
	if settings.CloudWorkspace == "" && settings.Product == domain.ProductCloud {
		return ConnectionSettings{}, invalidConnectionInput("Bitbucket Cloud workspace is required")
	}
	if err := validateConnection(settings); err != nil {
		return ConnectionSettings{}, invalidConnectionInput("%v", err)
	}
	if err := r.validateTokenCredential(ctx, workspaceID, settings, previous, found, input.Token); err != nil {
		return ConnectionSettings{}, err
	}
	writes, err := r.connectionSecretWrites(ctx, workspaceID, settings, previous, found, input)
	if err != nil {
		return ConnectionSettings{}, err
	}
	deleteKeys := supersededCredentialKeys(workspaceID, previous, found, settings)
	settings.PendingSecretRevocations = uniqueSecretKeys(append(previous.PendingSecretRevocations, deleteKeys...))
	if err := r.writeSecrets(ctx, writes); err != nil {
		r.compensateStagedSecrets(ctx, writes)
		return ConnectionSettings{}, err
	}
	value, err := encodeState(settings)
	if err != nil {
		r.compensateStagedSecrets(ctx, writes)
		return ConnectionSettings{}, fmt.Errorf("encode Bitbucket connection: %w", err)
	}
	if err := r.host.SetState(ctx, "workspace", workspaceID, connectionStateKey, value); err != nil {
		r.compensateStagedSecrets(ctx, writes)
		return ConnectionSettings{}, fmt.Errorf("save Bitbucket connection: %w", err)
	}
	r.invalidateSupersededOAuth(workspaceID, previous, found, settings)
	r.cleanupCommittedSecrets(ctx, workspaceID, settings)
	settings.PendingSecretRevocations = nil
	return settings, nil
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
		return invalidConnectionInput("Bitbucket token credential is required")
	}
	stored, present, err := r.loadTokenCredential(ctx, workspaceID, previous.CredentialGeneration)
	if err != nil {
		return fmt.Errorf("load Bitbucket credential: %w", err)
	}
	if !present || strings.TrimSpace(stored) == "" {
		return invalidConnectionInput("Bitbucket token credential is required")
	}
	return nil
}

// Disconnect removes every workspace-scoped connection artifact. It first
// commits a fail-closed tombstone so a secret deletion failure remains
// retryable without allowing fresh provider or broker resolution.
func (r *ConnectionResolver) Disconnect(ctx context.Context, workspaceID string) error {
	if workspaceID == "" {
		return fmt.Errorf("workspace id is required")
	}
	r.connectionMu.Lock()
	defer r.connectionMu.Unlock()
	settings, found, err := r.loadConnectionRecord(ctx, workspaceID)
	if err != nil {
		return err
	}
	r.invalidateOAuthWorkspace(workspaceID, settings, found)
	if found && settings.Disconnected {
		return r.finishDisconnect(ctx, workspaceID, settings)
	}
	keys := []string{
		legacyConnectionSecretKey(workspaceID), legacyOAuthRegistrationSecretKey(workspaceID),
		oauthStateSecretKey(workspaceID),
	}
	if found {
		keys = append(keys, settings.PendingSecretRevocations...)
		keys = append(keys,
			connectionSecretKey(workspaceID, settings.CredentialGeneration),
			oauthRegistrationSecretKey(workspaceID, settings.OAuthGeneration),
		)
		if settings.OAuthGeneration != 0 {
			keys = append(keys, oauthCredentialSecretKey(workspaceID, settings.OAuthGeneration))
		}
	}
	tombstone := ConnectionSettings{Disconnected: true, PendingSecretRevocations: uniqueSecretKeys(keys)}
	value, err := encodeState(tombstone)
	if err != nil {
		return fmt.Errorf("encode Bitbucket disconnect state: %w", err)
	}
	if err := r.host.SetState(ctx, "workspace", workspaceID, connectionStateKey, value); err != nil {
		return fmt.Errorf("save Bitbucket disconnect state: %w", err)
	}
	return r.finishDisconnect(ctx, workspaceID, tombstone)
}

func (r *ConnectionResolver) finishDisconnect(ctx context.Context, workspaceID string, tombstone ConnectionSettings) error {
	if err := r.deleteSecrets(ctx, tombstone.PendingSecretRevocations...); err != nil {
		return err
	}
	if err := r.host.DeleteState(ctx, "workspace", workspaceID, connectionStateKey); err != nil {
		return fmt.Errorf("delete Bitbucket connection: %w", err)
	}
	return nil
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

func sameConnectionTarget(previous, next ConnectionSettings) bool {
	return previous.Product == next.Product &&
		strings.TrimSpace(previous.BaseURL) == strings.TrimSpace(next.BaseURL) &&
		strings.EqualFold(strings.TrimSpace(previous.CloudWorkspace), strings.TrimSpace(next.CloudWorkspace)) &&
		previous.AuthMethod == next.AuthMethod &&
		strings.EqualFold(strings.TrimSpace(previous.AuthIdentity), strings.TrimSpace(next.AuthIdentity))
}

func newConnectionBinding() (string, error) {
	value := make([]byte, 18)
	if _, err := rand.Read(value); err != nil {
		return "", fmt.Errorf("create Bitbucket connection binding: %w", err)
	}
	return "bitbucket-connection:v1:" + base64.RawURLEncoding.EncodeToString(value), nil
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
		return hostTokenSource{
			host: r.host,
			keys: []string{
				connectionSecretKey(workspaceID, settings.CredentialGeneration),
				legacyConnectionSecretKey(workspaceID),
			},
		}, nil
	}
	registration, err := r.oauthRegistration(ctx, workspaceID, settings)
	if err != nil {
		return nil, err
	}
	scope := oauthCredentialScope(workspaceID, settings)
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
	scope := oauthCredentialScope(workspaceID, settings)
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
			return invalidConnectionInput("Bitbucket OAuth client secret is required when registration changes")
		}
		configured, err := r.oauthRegistrationConfiguredForGeneration(
			ctx,
			workspaceID,
			previous.OAuthGeneration,
		)
		if err != nil {
			return err
		}
		if !configured {
			return invalidConnectionInput("Bitbucket OAuth client registration is required")
		}
		settings.OAuthClientID = previous.OAuthClientID
		settings.OAuthRedirectURL = previous.OAuthRedirectURL
		settings.OAuthGeneration = previous.OAuthGeneration
		return nil
	}
	if clientID == "" || clientSecret == "" || redirectURL == "" {
		return invalidConnectionInput("Bitbucket OAuth client id, client secret, and redirect URL are required")
	}
	settings.OAuthClientID = clientID
	settings.OAuthRedirectURL = redirectURL
	if err := validateHTTPSURL(settings.OAuthRedirectURL, "Bitbucket OAuth redirect URL"); err != nil {
		return invalidConnectionInput("%v", err)
	}
	settings.OAuthGeneration = previous.OAuthGeneration + 1
	if settings.OAuthGeneration == 0 {
		settings.OAuthGeneration = 1
	}
	return nil
}

func (r *ConnectionResolver) oauthRegistrationConfigured(ctx context.Context, workspaceID string) (bool, error) {
	settings, found, err := r.Load(ctx, workspaceID)
	if err != nil {
		return false, err
	}
	generation := uint64(0)
	if found {
		generation = settings.OAuthGeneration
	}
	return r.oauthRegistrationConfiguredForGeneration(ctx, workspaceID, generation)
}

func (r *ConnectionResolver) oauthRegistrationConfiguredForGeneration(
	ctx context.Context,
	workspaceID string,
	generation uint64,
) (bool, error) {
	secret, found, err := r.loadOAuthRegistrationSecret(ctx, workspaceID, generation)
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

func (r *ConnectionResolver) invalidateSupersededOAuth(workspaceID string, previous ConnectionSettings, found bool, next ConnectionSettings) {
	if !found {
		return
	}
	previousOAuth := previous.AuthMethod == "oauth"
	nextOAuth := next.AuthMethod == "oauth"
	if previousOAuth && (!nextOAuth || previous.OAuthGeneration != next.OAuthGeneration || previous.ConnectionBinding != next.ConnectionBinding) {
		r.invalidateOAuthWorkspace(workspaceID, previous, true)
	}
}

func supersededCredentialKeys(workspaceID string, previous ConnectionSettings, found bool, next ConnectionSettings) []string {
	if !found {
		return nil
	}
	previousOAuth := previous.AuthMethod == "oauth"
	nextOAuth := next.AuthMethod == "oauth"
	keys := make([]string, 0, 8)
	if previousOAuth && (!nextOAuth || previous.OAuthGeneration != next.OAuthGeneration) {
		keys = append(keys, oauthStateSecretKey(workspaceID))
		if previous.OAuthGeneration != 0 {
			keys = append(keys, oauthCredentialSecretKey(workspaceID, previous.OAuthGeneration))
			keys = append(keys, oauthRegistrationSecretKey(workspaceID, previous.OAuthGeneration))
		}
		keys = append(keys, legacyOAuthRegistrationSecretKey(workspaceID))
		if !nextOAuth {
			keys = append(keys, legacyOAuthRegistrationSecretKey(workspaceID))
		}
	}
	if !previousOAuth && (nextOAuth || previous.CredentialGeneration != next.CredentialGeneration) {
		keys = append(
			keys,
			connectionSecretKey(workspaceID, previous.CredentialGeneration),
			legacyConnectionSecretKey(workspaceID),
		)
	}
	return uniqueSecretKeys(keys)
}

func (r *ConnectionResolver) invalidateOAuthWorkspace(workspaceID string, settings ConnectionSettings, hasSettings bool) {
	r.oauthMu.Lock()
	r.oauthEpoch[workspaceID]++
	delete(r.oauthState, workspaceID)
	for state, flow := range r.oauthFlows {
		if flow.scope.WorkspaceID == workspaceID {
			delete(r.oauthFlows, state)
		}
	}
	r.oauthMu.Unlock()
	if !hasSettings || settings.AuthMethod != "oauth" || settings.OAuthGeneration == 0 {
		return
	}
	r.refresherMu.Lock()
	refresher := r.refresher
	r.refresherMu.Unlock()
	if refresher != nil {
		refresher.Invalidate(oauthCredentialScope(workspaceID, settings))
	}
}

func oauthCredentialScope(workspaceID string, settings ConnectionSettings) auth.CredentialScope {
	return auth.CredentialScope{
		WorkspaceID: workspaceID, Generation: settings.OAuthGeneration,
		ConnectionBinding: settings.ConnectionBinding,
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

func validateHTTPSURL(raw, label string) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return fmt.Errorf("%s must be a credential-free HTTPS URL", label)
	}
	return nil
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

func (p repositorySearchProvider) ListRepositoriesPage(
	ctx context.Context,
	_ string,
	query domain.RepositoryQuery,
) (domain.RepositoryPage, error) {
	if pager, ok := p.Provider.(domain.RepositoryPager); ok {
		return pager.ListRepositoriesPage(ctx, p.workspace, query)
	}
	repositories, err := p.ListRepositories(ctx, query.Text, query.Limit)
	return domain.RepositoryPage{Repositories: repositories}, err
}

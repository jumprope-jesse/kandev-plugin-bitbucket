package auth

import (
	"context"
	"fmt"
	"sync"
	"time"
)

const refreshSkew = 30 * time.Second

// CredentialRepository persists a workspace generation's encrypted credential.
type CredentialRepository interface {
	LoadCredential(context.Context, CredentialScope) (Credential, error)
	SaveCredential(context.Context, CredentialScope, Credential) error
}

// RefreshingTokenSource exposes a current OAuth access token to either adapter.
type RefreshingTokenSource struct {
	scope        CredentialScope
	registration OAuthRegistration
	credentials  CredentialRepository
	refresher    *Refresher
	now          func() time.Time

	mu sync.Mutex
}

// NewRefreshingTokenSource creates a generation-bound adapter token source.
func NewRefreshingTokenSource(scope CredentialScope, registration OAuthRegistration, credentials CredentialRepository, refresher *Refresher, now func() time.Time) *RefreshingTokenSource {
	if now == nil {
		now = time.Now
	}
	return &RefreshingTokenSource{
		scope:        scope,
		registration: registration,
		credentials:  credentials,
		refresher:    refresher,
		now:          now,
	}
}

// AccessToken returns an unexpired token, persisting a rotated refresh result.
func (s *RefreshingTokenSource) AccessToken(ctx context.Context) (string, error) {
	token, _, err := s.AccessTokenCredential(ctx)
	return token, err
}

// AccessTokenCredential returns an unexpired token and its in-memory expiry.
func (s *RefreshingTokenSource) AccessTokenCredential(ctx context.Context) (string, time.Time, error) {
	if s.credentials == nil || s.refresher == nil {
		return "", time.Time{}, fmt.Errorf("OAuth credential source is incomplete")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	credential, err := s.credentials.LoadCredential(ctx, s.scope)
	if err != nil {
		return "", time.Time{}, err
	}
	if credential.AccessToken != "" && credential.ExpiresAt.After(s.now().Add(refreshSkew)) {
		return credential.AccessToken, credential.ExpiresAt, nil
	}
	rotated, err := s.refresher.Refresh(ctx, s.scope, s.registration, credential.RefreshToken)
	if err != nil {
		return "", time.Time{}, err
	}
	if err := s.credentials.SaveCredential(ctx, s.scope, rotated); err != nil {
		return "", time.Time{}, err
	}
	return rotated.AccessToken, rotated.ExpiresAt, nil
}

// StaticTokenSource exposes an API token, PAT, or HTTP access token without logging it.
type StaticTokenSource struct {
	token string
}

// NewStaticTokenSource creates a token source for a non-rotating API token or PAT.
func NewStaticTokenSource(token string) (*StaticTokenSource, error) {
	if token == "" {
		return nil, fmt.Errorf("access token is required")
	}
	return &StaticTokenSource{token: token}, nil
}

// AccessToken returns the configured non-rotating credential.
func (s *StaticTokenSource) AccessToken(context.Context) (string, error) {
	return s.token, nil
}

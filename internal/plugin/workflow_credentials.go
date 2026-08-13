package plugin

import (
	"context"
	"time"
)

type providerCredentialSource struct{ resolver ProviderResolver }

func (s providerCredentialSource) GetGitCredentialBinding(ctx context.Context, scope GitCredentialScope) (string, error) {
	binder, ok := s.resolver.(interface {
		GitCredentialBinding(context.Context, GitCredentialScope) (string, error)
	})
	if !ok {
		return "", ErrCredentialUnavailable
	}
	return binder.GitCredentialBinding(ctx, scope)
}

func (s providerCredentialSource) ResolveGitCredential(ctx context.Context, scope GitCredentialScope) (GitCredential, error) {
	if validator, ok := s.resolver.(interface {
		ValidateGitCredentialScope(context.Context, GitCredentialScope) error
	}); ok {
		if err := validator.ValidateGitCredentialScope(ctx, scope); err != nil {
			return GitCredential{}, ErrCredentialUnavailable
		}
	}
	provider, err := s.resolver.Provider(ctx, scope.WorkspaceID)
	if err != nil {
		return GitCredential{}, err
	}
	credential, err := provider.ResolveGitCredential(ctx)
	if err != nil {
		return GitCredential{}, err
	}
	expiresAt := credential.ExpiresAt
	if expiresAt.IsZero() {
		expiresAt = time.Now().Add(5 * time.Minute)
	}
	return GitCredential{Username: credential.Username, Secret: credential.Secret, ExpiresAt: expiresAt}, nil
}

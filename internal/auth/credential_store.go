package auth

import (
	"context"
	"encoding/json"
	"fmt"

	"kandev-plugin-bitbucket/internal/store"
)

// EncryptedCredentialRepository persists OAuth tokens through a generation-bound SecretStore.
type EncryptedCredentialRepository struct {
	secrets *store.SecretStore
}

// NewEncryptedCredentialRepository adapts encrypted plugin state to OAuth credentials.
func NewEncryptedCredentialRepository(secrets *store.SecretStore) *EncryptedCredentialRepository {
	return &EncryptedCredentialRepository{secrets: secrets}
}

// LoadCredential reads one workspace's current encrypted credential generation.
func (r *EncryptedCredentialRepository) LoadCredential(ctx context.Context, scope CredentialScope) (Credential, error) {
	if r == nil || r.secrets == nil {
		return Credential{}, fmt.Errorf("encrypted credential store is not configured")
	}
	value, err := r.secrets.Load(ctx, scope.WorkspaceID, scope.Generation)
	if err != nil {
		return Credential{}, err
	}
	var credential Credential
	if err := json.Unmarshal(value, &credential); err != nil {
		return Credential{}, fmt.Errorf("decode encrypted OAuth credential: %w", err)
	}
	return credential, nil
}

// SaveCredential encrypts one workspace's new credential generation.
func (r *EncryptedCredentialRepository) SaveCredential(ctx context.Context, scope CredentialScope, credential Credential) error {
	if r == nil || r.secrets == nil {
		return fmt.Errorf("encrypted credential store is not configured")
	}
	value, err := json.Marshal(credential)
	if err != nil {
		return fmt.Errorf("encode OAuth credential: %w", err)
	}
	return r.secrets.Save(ctx, scope.WorkspaceID, scope.Generation, value)
}

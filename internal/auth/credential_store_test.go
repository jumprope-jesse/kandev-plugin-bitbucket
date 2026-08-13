package auth

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"kandev-plugin-bitbucket/internal/store"
)

func TestEncryptedCredentialRepositoryStoresOAuthTokensWithoutPlaintext(t *testing.T) {
	backend := &memoryEncryptedBackend{records: make(map[string]store.EncryptedRecord)}
	secrets, err := store.NewSecretStore([]byte("01234567890123456789012345678901"), backend)
	require.NoError(t, err)
	repository := NewEncryptedCredentialRepository(secrets)
	scope := CredentialScope{WorkspaceID: "workspace-a", Generation: 3}

	require.NoError(t, repository.SaveCredential(context.Background(), scope, Credential{AccessToken: "access-secret", RefreshToken: "refresh-secret", ExpiresAt: time.Unix(10, 0)}))
	require.NotContains(t, string(backend.records[scope.WorkspaceID].Ciphertext), "access-secret")

	credential, err := repository.LoadCredential(context.Background(), scope)
	require.NoError(t, err)
	require.Equal(t, "refresh-secret", credential.RefreshToken)
}

type memoryEncryptedBackend struct {
	records map[string]store.EncryptedRecord
}

func (b *memoryEncryptedBackend) LoadSecret(_ context.Context, workspaceID string) (store.EncryptedRecord, bool, error) {
	record, found := b.records[workspaceID]
	return record, found, nil
}

func (b *memoryEncryptedBackend) SaveSecret(_ context.Context, workspaceID string, record store.EncryptedRecord) error {
	b.records[workspaceID] = record
	return nil
}

package store

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestSecretStoreEncryptsByWorkspaceAndGeneration(t *testing.T) {
	repository := newMemorySecretRepository()
	secrets, err := NewSecretStore([]byte("01234567890123456789012345678901"), repository)
	require.NoError(t, err)

	require.NoError(t, secrets.Save(context.Background(), "workspace-a", 4, []byte("rotating-refresh-token")))
	require.NotContains(t, string(repository.records["workspace-a"].Ciphertext), "rotating-refresh-token")

	value, err := secrets.Load(context.Background(), "workspace-a", 4)
	require.NoError(t, err)
	require.Equal(t, []byte("rotating-refresh-token"), value)

	_, err = secrets.Load(context.Background(), "workspace-a", 5)
	require.ErrorIs(t, err, ErrGenerationMismatch)
}

type memorySecretRepository struct {
	records map[string]EncryptedRecord
}

func newMemorySecretRepository() *memorySecretRepository {
	return &memorySecretRepository{records: make(map[string]EncryptedRecord)}
}

func (r *memorySecretRepository) LoadSecret(_ context.Context, workspaceID string) (EncryptedRecord, bool, error) {
	record, found := r.records[workspaceID]
	return record, found, nil
}

func (r *memorySecretRepository) SaveSecret(_ context.Context, workspaceID string, record EncryptedRecord) error {
	if workspaceID == "write-error" {
		return errors.New("write failed")
	}
	r.records[workspaceID] = record
	return nil
}

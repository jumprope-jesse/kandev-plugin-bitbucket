package auth

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestStateManagerConsumesSignedPKCEStateExactlyOnce(t *testing.T) {
	manager, err := NewStateManager([]byte("01234567890123456789012345678901"), NewMemoryPendingStore(), time.Now)
	require.NoError(t, err)

	pending, err := manager.Start(context.Background(), "workspace-a", 9)
	require.NoError(t, err)
	require.NotEmpty(t, pending.State)
	require.Len(t, pending.CodeVerifier, 64)
	require.NotEmpty(t, pending.CodeChallenge)

	consumed, err := manager.Consume(context.Background(), pending.State)
	require.NoError(t, err)
	require.Equal(t, "workspace-a", consumed.WorkspaceID)
	require.Equal(t, uint64(9), consumed.Generation)
	require.Equal(t, pending.CodeVerifier, consumed.CodeVerifier)

	_, err = manager.Consume(context.Background(), pending.State)
	require.ErrorIs(t, err, ErrStateReplay)
}

func TestMemoryPendingStoreBoundsAndPurgesExpiredStates(t *testing.T) {
	store := NewMemoryPendingStore()
	require.NoError(t, store.SavePendingState(context.Background(), "expired", PendingState{ExpiresAt: time.Now().Add(-time.Minute)}))
	for index := range maxPendingStates + 4 {
		require.NoError(t, store.SavePendingState(context.Background(), string(rune('a'+index)), PendingState{ExpiresAt: time.Now().Add(time.Hour)}))
	}

	store.mu.Lock()
	defer store.mu.Unlock()
	require.NotContains(t, store.pending, "expired")
	require.Len(t, store.pending, maxPendingStates)
}

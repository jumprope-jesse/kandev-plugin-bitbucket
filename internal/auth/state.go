// Package auth owns workspace-scoped Bitbucket authentication flows.
package auth

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"
)

const stateTTL = 10 * time.Minute

const maxPendingStates = 64

var (
	// ErrStateReplay means a callback state was already consumed or revoked.
	ErrStateReplay = errors.New("OAuth state was already consumed")
	// ErrStateInvalid means the callback did not carry a valid signed state.
	ErrStateInvalid = errors.New("invalid OAuth state")
)

// PendingState contains one server-side OAuth PKCE flow.
type PendingState struct {
	State         string
	WorkspaceID   string
	Generation    uint64
	CodeVerifier  string
	CodeChallenge string
	ExpiresAt     time.Time
}

// PendingStateStore atomically consumes OAuth callback state.
type PendingStateStore interface {
	SavePendingState(context.Context, string, PendingState) error
	TakePendingState(context.Context, string) (PendingState, bool, error)
}

// StateManager creates signed, one-time PKCE callback states.
type StateManager struct {
	key   []byte
	store PendingStateStore
	now   func() time.Time
}

// NewStateManager creates a callback-state manager.
func NewStateManager(key []byte, store PendingStateStore, now func() time.Time) (*StateManager, error) {
	if len(key) < 32 {
		return nil, fmt.Errorf("OAuth state key must contain at least 32 bytes")
	}
	if store == nil {
		return nil, fmt.Errorf("OAuth pending-state store is required")
	}
	if now == nil {
		now = time.Now
	}
	return &StateManager{key: append([]byte(nil), key...), store: store, now: now}, nil
}

// Start creates a server-side PKCE verifier and a signed browser state value.
func (m *StateManager) Start(ctx context.Context, workspaceID string, generation uint64) (PendingState, error) {
	if workspaceID == "" || generation == 0 {
		return PendingState{}, fmt.Errorf("workspace and credential generation are required")
	}
	stateID, err := randomURLValue(32)
	if err != nil {
		return PendingState{}, err
	}
	verifier, err := randomURLValue(48)
	if err != nil {
		return PendingState{}, err
	}
	digest := sha256.Sum256([]byte(verifier))
	pending := PendingState{
		WorkspaceID:   workspaceID,
		Generation:    generation,
		CodeVerifier:  verifier,
		CodeChallenge: base64.RawURLEncoding.EncodeToString(digest[:]),
		ExpiresAt:     m.now().Add(stateTTL),
	}
	if err := m.store.SavePendingState(ctx, stateID, pending); err != nil {
		return PendingState{}, err
	}
	payload := stateID + "." + strconv.FormatInt(pending.ExpiresAt.Unix(), 10)
	pending.State = m.sign(payload)
	return pending, nil
}

// Consume validates and atomically removes a callback state.
func (m *StateManager) Consume(ctx context.Context, state string) (PendingState, error) {
	payload, err := m.verify(state)
	if err != nil {
		return PendingState{}, err
	}
	parts := strings.Split(payload, ".")
	if len(parts) != 2 {
		return PendingState{}, ErrStateInvalid
	}
	expiresAt, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || m.now().After(time.Unix(expiresAt, 0)) {
		return PendingState{}, ErrStateInvalid
	}
	pending, found, err := m.store.TakePendingState(ctx, parts[0])
	if err != nil {
		return PendingState{}, err
	}
	if !found {
		return PendingState{}, ErrStateReplay
	}
	if m.now().After(pending.ExpiresAt) {
		return PendingState{}, ErrStateInvalid
	}
	return pending, nil
}

func (m *StateManager) sign(payload string) string {
	mac := hmac.New(sha256.New, m.key)
	_, _ = mac.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString([]byte(payload)) + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (m *StateManager) verify(state string) (string, error) {
	parts := strings.Split(state, ".")
	if len(parts) != 2 {
		return "", ErrStateInvalid
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", ErrStateInvalid
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", ErrStateInvalid
	}
	mac := hmac.New(sha256.New, m.key)
	_, _ = mac.Write(payload)
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return "", ErrStateInvalid
	}
	return string(payload), nil
}

func randomURLValue(size int) (string, error) {
	value := make([]byte, size)
	if _, err := rand.Read(value); err != nil {
		return "", fmt.Errorf("generate OAuth state: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

// MemoryPendingStore is a concurrency-safe implementation for the plugin runtime.
type MemoryPendingStore struct {
	mu      sync.Mutex
	pending map[string]PendingState
}

// NewMemoryPendingStore creates a store whose Take operation is one-time.
func NewMemoryPendingStore() *MemoryPendingStore {
	return &MemoryPendingStore{pending: make(map[string]PendingState)}
}

// SavePendingState saves a state until its matching callback consumes it.
func (s *MemoryPendingStore) SavePendingState(_ context.Context, stateID string, pending PendingState) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.purgeExpiredLocked(time.Now())
	if len(s.pending) >= maxPendingStates {
		s.deleteOldestLocked()
	}
	s.pending[stateID] = pending
	return nil
}

// TakePendingState removes and returns a pending state atomically.
func (s *MemoryPendingStore) TakePendingState(_ context.Context, stateID string) (PendingState, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	pending, found := s.pending[stateID]
	if found {
		delete(s.pending, stateID)
	}
	return pending, found, nil
}

func (s *MemoryPendingStore) purgeExpiredLocked(now time.Time) {
	for stateID, pending := range s.pending {
		if !pending.ExpiresAt.After(now) {
			delete(s.pending, stateID)
		}
	}
}

func (s *MemoryPendingStore) deleteOldestLocked() {
	var oldestID string
	var oldest time.Time
	for stateID, pending := range s.pending {
		if oldestID == "" || pending.ExpiresAt.Before(oldest) {
			oldestID = stateID
			oldest = pending.ExpiresAt
		}
	}
	if oldestID != "" {
		delete(s.pending, oldestID)
	}
}

// Package store contains plugin-owned encrypted persistence primitives.
package store

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
)

var (
	// ErrSecretNotFound means this workspace has no stored credential.
	ErrSecretNotFound = errors.New("secret not found")
	// ErrGenerationMismatch prevents using a credential after rotation.
	ErrGenerationMismatch = errors.New("credential generation mismatch")
)

// EncryptedRecord is safe to persist in plugin state; it never contains plaintext.
type EncryptedRecord struct {
	Generation uint64
	Nonce      []byte
	Ciphertext []byte
}

// SecretRepository persists encrypted records independently of their cipher key.
type SecretRepository interface {
	LoadSecret(context.Context, string) (EncryptedRecord, bool, error)
	SaveSecret(context.Context, string, EncryptedRecord) error
}

// SecretStore encrypts each workspace generation under a derived AES-GCM key.
type SecretStore struct {
	masterKey  []byte
	repository SecretRepository
}

// NewSecretStore creates a workspace/generation-bound encryption store.
func NewSecretStore(masterKey []byte, repository SecretRepository) (*SecretStore, error) {
	if len(masterKey) < 32 {
		return nil, fmt.Errorf("secret-store master key must contain at least 32 bytes")
	}
	if repository == nil {
		return nil, fmt.Errorf("secret-store repository is required")
	}
	key := append([]byte(nil), masterKey...)
	return &SecretStore{masterKey: key, repository: repository}, nil
}

// Save encrypts a plaintext value for exactly one workspace credential generation.
func (s *SecretStore) Save(ctx context.Context, workspaceID string, generation uint64, value []byte) error {
	if workspaceID == "" || generation == 0 {
		return fmt.Errorf("workspace and credential generation are required")
	}
	aead, err := s.aead(workspaceID, generation)
	if err != nil {
		return err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return fmt.Errorf("generate secret nonce: %w", err)
	}
	ciphertext := aead.Seal(nil, nonce, value, associatedData(workspaceID, generation))
	return s.repository.SaveSecret(ctx, workspaceID, EncryptedRecord{
		Generation: generation,
		Nonce:      nonce,
		Ciphertext: ciphertext,
	})
}

// Load decrypts only the current workspace credential generation.
func (s *SecretStore) Load(ctx context.Context, workspaceID string, generation uint64) ([]byte, error) {
	record, found, err := s.repository.LoadSecret(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, ErrSecretNotFound
	}
	if record.Generation != generation {
		return nil, ErrGenerationMismatch
	}
	aead, err := s.aead(workspaceID, generation)
	if err != nil {
		return nil, err
	}
	value, err := aead.Open(nil, record.Nonce, record.Ciphertext, associatedData(workspaceID, generation))
	if err != nil {
		return nil, fmt.Errorf("decrypt workspace secret: %w", err)
	}
	return value, nil
}

func (s *SecretStore) aead(workspaceID string, generation uint64) (cipher.AEAD, error) {
	mac := hmac.New(sha256.New, s.masterKey)
	_, _ = mac.Write([]byte("kandev-plugin-bitbucket/secret/v1\x00" + workspaceID))
	_, _ = mac.Write([]byte(fmt.Sprintf("\x00%d", generation)))
	block, err := aes.NewCipher(mac.Sum(nil))
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func associatedData(workspaceID string, generation uint64) []byte {
	return []byte(fmt.Sprintf("%s\x00%d", workspaceID, generation))
}

package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"
)

// PullRequestIdentity is the immutable persistence identity for a provider
// pull request. Human-readable repository paths remain display keys only.
type PullRequestIdentity struct {
	ProviderID    string
	ProviderScope string
	RepositoryID  string
	Number        int64
}

// StorageKey returns an opaque, versioned key only when every immutable
// identity component is present.
func (i PullRequestIdentity) StorageKey() (string, bool) {
	providerID := strings.TrimSpace(i.ProviderID)
	providerScope := strings.TrimSpace(i.ProviderScope)
	repositoryID := strings.TrimSpace(i.RepositoryID)
	if providerID == "" || providerScope == "" || repositoryID == "" || i.Number <= 0 {
		return "", false
	}
	payload := providerID + "\x00" + providerScope + "\x00" + repositoryID + "\x00" + strconv.FormatInt(i.Number, 10)
	sum := sha256.Sum256([]byte(payload))
	return "pull-request:v1:" + hex.EncodeToString(sum[:]), true
}

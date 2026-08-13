package plugin

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"sync"

	"kandev-plugin-bitbucket/internal/domain"
)

const (
	taskLinkStateKey          = "bitbucket.pull-request-links.v1"
	maxSuppressedPullRequests = 100
)

// PullRequestLink is a user-created task association. It is deliberately
// separate from watch-owned links and has no deletion path for Kandev tasks.
type PullRequestLink struct {
	Key          string `json:"key"`
	RepositoryID string `json:"repository_id"`
	URL          string `json:"url"`
	Number       int64  `json:"number"`
	// Product and Host pin a manual link to the original Bitbucket connection.
	// Older records are upgraded from their canonical pull request URL on read.
	Product domain.Product `json:"product,omitempty"`
	Host    string         `json:"host,omitempty"`
	// ConnectionScope includes the Data Center context path. Host alone is
	// insufficient when one origin serves multiple Bitbucket installations.
	ConnectionScope string `json:"connection_scope,omitempty"`
}

type LinkStore struct {
	host StateHost
	mu   sync.Mutex
}

type linkState struct {
	Links                []PullRequestLink `json:"links"`
	SuppressedIdentities []string          `json:"suppressed_identities,omitempty"`
	LegacySuppressedKeys []string          `json:"suppressed_keys,omitempty"`
}

func NewLinkStore(host StateHost) (*LinkStore, error) {
	if host == nil {
		return nil, fmt.Errorf("link state host is required")
	}
	return &LinkStore{host: host}, nil
}

func (s *LinkStore) List(ctx context.Context, taskID string) ([]PullRequestLink, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state, changed, err := s.load(ctx, taskID)
	if err != nil || !changed {
		return state.Links, err
	}
	if err := s.save(ctx, taskID, state); err != nil {
		return nil, err
	}
	return state.Links, nil
}

func (s *LinkStore) load(ctx context.Context, taskID string) (linkState, bool, error) {
	if taskID == "" {
		return linkState{}, false, fmt.Errorf("task id is required")
	}
	value, found, err := s.host.GetState(ctx, "task", taskID, taskLinkStateKey)
	if err != nil {
		return linkState{}, false, fmt.Errorf("load pull request links: %w", err)
	}
	if !found {
		return linkState{}, false, nil
	}
	var stored linkState
	if err := decodeState(value, &stored); err != nil {
		return linkState{}, false, fmt.Errorf("decode pull request links: %w", err)
	}
	changed := false
	for index, link := range stored.Links {
		normalized, linkChanged, err := normalizePullRequestLink(link)
		if err != nil {
			return linkState{}, false, fmt.Errorf("invalid stored pull request link: %w", err)
		}
		stored.Links[index] = normalized
		changed = changed || linkChanged
	}
	return stored, changed, nil
}

func (s *LinkStore) Link(ctx context.Context, taskID string, link PullRequestLink) ([]PullRequestLink, error) {
	if taskID == "" || link.Key == "" || link.RepositoryID == "" || link.URL == "" || link.Number <= 0 {
		return nil, fmt.Errorf("task and complete pull request link are required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	normalized, _, err := normalizePullRequestLink(link)
	if err != nil {
		return nil, err
	}
	state, _, err := s.load(ctx, taskID)
	if err != nil {
		return nil, err
	}
	identity := pullRequestLinkStorageKey(normalized)
	wasSuppressed := containsKey(state.SuppressedIdentities, identity) || containsKey(state.LegacySuppressedKeys, normalized.Key)
	state.SuppressedIdentities = removeKey(state.SuppressedIdentities, identity)
	state.LegacySuppressedKeys = removeKey(state.LegacySuppressedKeys, normalized.Key)
	for index, existing := range state.Links {
		if pullRequestLinkStorageKey(existing) == identity {
			if existing != normalized {
				state.Links[index] = normalized
			}
			if wasSuppressed || existing != normalized {
				if err := s.save(ctx, taskID, state); err != nil {
					return nil, err
				}
			}
			return state.Links, nil
		}
	}
	state.Links = append(state.Links, normalized)
	if err := s.save(ctx, taskID, state); err != nil {
		return nil, err
	}
	return state.Links, nil
}

// AutoLink records a branch-discovered association unless the user explicitly
// unlinked the same pull request. A later explicit Link clears that suppression.
func (s *LinkStore) AutoLink(ctx context.Context, taskID string, link PullRequestLink) ([]PullRequestLink, error) {
	if taskID == "" || link.Key == "" || link.RepositoryID == "" || link.URL == "" || link.Number <= 0 {
		return nil, fmt.Errorf("task and complete pull request link are required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	normalized, _, err := normalizePullRequestLink(link)
	if err != nil {
		return nil, err
	}
	state, _, err := s.load(ctx, taskID)
	if err != nil {
		return nil, err
	}
	identity := pullRequestLinkStorageKey(normalized)
	legacyIdentity := strings.HasPrefix(identity, "legacy:")
	if containsKey(state.SuppressedIdentities, identity) ||
		(legacyIdentity && containsKey(state.LegacySuppressedKeys, normalized.Key)) {
		return state.Links, nil
	}
	for _, existing := range state.Links {
		if pullRequestLinkStorageKey(existing) == identity {
			return state.Links, nil
		}
	}
	state.Links = append(state.Links, normalized)
	if err := s.save(ctx, taskID, state); err != nil {
		return nil, err
	}
	return state.Links, nil
}

func (s *LinkStore) Unlink(
	ctx context.Context,
	taskID, providerScope, repositoryID string,
	number int64,
) ([]PullRequestLink, error) {
	target, complete := (domain.PullRequestIdentity{
		ProviderID: "bitbucket", ProviderScope: providerScope,
		RepositoryID: repositoryID, Number: number,
	}).StorageKey()
	if taskID == "" || !complete {
		return nil, fmt.Errorf("task id and complete pull request identity are required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state, _, err := s.load(ctx, taskID)
	if err != nil {
		return nil, err
	}
	kept := state.Links[:0]
	suppressed := make([]string, 0)
	for _, link := range state.Links {
		if pullRequestLinkStorageKey(link) != target {
			kept = append(kept, link)
			continue
		}
		if identity := pullRequestLinkStorageKey(link); identity != "" {
			suppressed = append(suppressed, identity)
		}
	}
	state.Links = kept
	for _, identity := range suppressed {
		if !containsKey(state.SuppressedIdentities, identity) {
			state.SuppressedIdentities = append(state.SuppressedIdentities, identity)
		}
	}
	if len(state.SuppressedIdentities) > maxSuppressedPullRequests {
		state.SuppressedIdentities = state.SuppressedIdentities[len(state.SuppressedIdentities)-maxSuppressedPullRequests:]
	}
	if err := s.save(ctx, taskID, state); err != nil {
		return nil, err
	}
	return state.Links, nil
}

func (s *LinkStore) save(ctx context.Context, taskID string, state linkState) error {
	value, err := encodeState(state)
	if err != nil {
		return fmt.Errorf("encode pull request links: %w", err)
	}
	if err := s.host.SetState(ctx, "task", taskID, taskLinkStateKey, value); err != nil {
		return fmt.Errorf("save pull request links: %w", err)
	}
	return nil
}

func containsKey(keys []string, key string) bool {
	for _, candidate := range keys {
		if candidate == key {
			return true
		}
	}
	return false
}

func removeKey(keys []string, key string) []string {
	kept := keys[:0]
	for _, candidate := range keys {
		if candidate != key {
			kept = append(kept, candidate)
		}
	}
	return kept
}

func normalizePullRequestLink(link PullRequestLink) (PullRequestLink, bool, error) {
	if link.Key == "" || link.RepositoryID == "" || link.URL == "" || link.Number <= 0 {
		return PullRequestLink{}, false, fmt.Errorf("complete pull request link is required")
	}
	parsed, err := url.Parse(link.URL)
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.Host == "" {
		return PullRequestLink{}, false, fmt.Errorf("pull request URL must be credential-free HTTPS")
	}
	host := strings.ToLower(parsed.Host)
	changed := false
	if link.Host == "" {
		link.Host = host
		changed = true
	} else if !strings.EqualFold(link.Host, host) {
		return PullRequestLink{}, false, fmt.Errorf("pull request host does not match URL")
	} else if link.Host != host {
		link.Host = host
		changed = true
	}
	if link.Product == "" {
		if host == "bitbucket.org" {
			link.Product = domain.ProductCloud
		} else {
			link.Product = domain.ProductDataCenter
		}
		changed = true
	}
	if link.Product != domain.ProductCloud && link.Product != domain.ProductDataCenter {
		return PullRequestLink{}, false, fmt.Errorf("unsupported Bitbucket product")
	}
	if link.ConnectionScope == "" && link.Product == domain.ProductCloud {
		link.ConnectionScope = "https://bitbucket.org"
		changed = true
	}
	if link.ConnectionScope != "" {
		scope, err := normalizeConnectionScope(link.ConnectionScope)
		if err != nil || !urlWithinConnectionScope(link.URL, scope) {
			return PullRequestLink{}, false, fmt.Errorf("pull request URL is outside its Bitbucket connection scope")
		}
		if link.ConnectionScope != scope {
			link.ConnectionScope = scope
			changed = true
		}
	}
	return link, changed, nil
}

func pullRequestLinkStorageKey(link PullRequestLink) string {
	scope := link.ConnectionScope
	if scope == "" && link.Product == domain.ProductCloud {
		scope = "https://bitbucket.org"
	}
	identity, complete := (domain.PullRequestIdentity{
		ProviderID: "bitbucket", ProviderScope: scope, RepositoryID: link.RepositoryID, Number: link.Number,
	}).StorageKey()
	if complete {
		return identity
	}
	// Legacy records without a verifiable provider scope remain isolated by
	// their old display key until they can be explicitly replaced.
	return "legacy:" + link.Key
}

package plugin

import (
	"context"
	"fmt"
	"net/url"
	"strings"

	"kandev-plugin-bitbucket/internal/domain"
	"sync"
)

const taskLinkStateKey = "bitbucket.pull-request-links.v1"

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
}

type LinkStore struct {
	host StateHost
	mu   sync.Mutex
}

type linkState struct {
	Links []PullRequestLink `json:"links"`
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
	links, changed, err := s.list(ctx, taskID)
	if err != nil || !changed {
		return links, err
	}
	if err := s.save(ctx, taskID, links); err != nil {
		return nil, err
	}
	return links, nil
}

func (s *LinkStore) list(ctx context.Context, taskID string) ([]PullRequestLink, bool, error) {
	if taskID == "" {
		return nil, false, fmt.Errorf("task id is required")
	}
	value, found, err := s.host.GetState(ctx, "task", taskID, taskLinkStateKey)
	if err != nil {
		return nil, false, fmt.Errorf("load pull request links: %w", err)
	}
	if !found {
		return nil, false, nil
	}
	var stored linkState
	if err := decodeState(value, &stored); err != nil {
		return nil, false, fmt.Errorf("decode pull request links: %w", err)
	}
	changed := false
	for index, link := range stored.Links {
		normalized, linkChanged, err := normalizePullRequestLink(link)
		if err != nil {
			return nil, false, fmt.Errorf("invalid stored pull request link: %w", err)
		}
		stored.Links[index] = normalized
		changed = changed || linkChanged
	}
	return stored.Links, changed, nil
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
	links, _, err := s.list(ctx, taskID)
	if err != nil {
		return nil, err
	}
	for _, existing := range links {
		if existing.Key == normalized.Key {
			return links, nil
		}
	}
	links = append(links, normalized)
	if err := s.save(ctx, taskID, links); err != nil {
		return nil, err
	}
	return links, nil
}

func (s *LinkStore) Unlink(ctx context.Context, taskID, key string) ([]PullRequestLink, error) {
	if taskID == "" || key == "" {
		return nil, fmt.Errorf("task id and pull request key are required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	links, _, err := s.list(ctx, taskID)
	if err != nil {
		return nil, err
	}
	kept := links[:0]
	for _, link := range links {
		if link.Key != key {
			kept = append(kept, link)
		}
	}
	if err := s.save(ctx, taskID, kept); err != nil {
		return nil, err
	}
	return kept, nil
}

func (s *LinkStore) save(ctx context.Context, taskID string, links []PullRequestLink) error {
	value, err := encodeState(linkState{Links: links})
	if err != nil {
		return fmt.Errorf("encode pull request links: %w", err)
	}
	if err := s.host.SetState(ctx, "task", taskID, taskLinkStateKey, value); err != nil {
		return fmt.Errorf("save pull request links: %w", err)
	}
	return nil
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
	return link, changed, nil
}

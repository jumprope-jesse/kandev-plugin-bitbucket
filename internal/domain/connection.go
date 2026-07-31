// Package domain defines Bitbucket-neutral connection state and capabilities.
package domain

import (
	"fmt"
	"net/url"
	"path"
	"strings"
)

// Capability identifies a product feature available for a connection.
type Capability string

// Product selects one isolated Bitbucket API adapter.
type Product string

const (
	ProductCloud      Product = "cloud"
	ProductDataCenter Product = "data_center"
)

const (
	CapabilityOAuthPKCE Capability = "oauth_pkce"
	CapabilityIssues    Capability = "issues"
	// CapabilityIncomingOAuth requires a Data Center incoming application link.
	CapabilityIncomingOAuth Capability = "incoming_oauth"
)

// Capabilities is an immutable set of explicitly probed product features.
type Capabilities map[Capability]bool

// Supports reports whether a capability is available for this connection.
func (c Capabilities) Supports(capability Capability) bool {
	return c[capability]
}

// Connection contains only credential-free provider endpoints.
type Connection struct {
	Product      Product
	APIBase      *url.URL
	CloneBase    *url.URL
	Workspace    string
	Capabilities Capabilities
}

// Repository identifies a repository without embedding provider credentials.
type Repository struct {
	Namespace     string
	Slug          string
	CloneURL      *url.URL
	DefaultBranch string
}

// NewCloudConnection creates a Bitbucket Cloud v2 connection for a workspace.
func NewCloudConnection(workspace string) (Connection, error) {
	apiBase, err := url.Parse("https://api.bitbucket.org/2.0")
	if err != nil {
		return Connection{}, err
	}
	cloneBase, err := url.Parse("https://bitbucket.org")
	if err != nil {
		return Connection{}, err
	}
	return Connection{
		Product:   ProductCloud,
		APIBase:   apiBase,
		CloneBase: cloneBase,
		Workspace: workspace,
		Capabilities: Capabilities{
			CapabilityOAuthPKCE: true,
			CapabilityIssues:    false,
		},
	}, nil
}

// CloneURL returns a credential-free HTTPS clone URL.
func (c Connection) CloneURL(repository Repository) (*url.URL, error) {
	namespace := repository.Namespace
	if namespace == "" {
		namespace = c.Workspace
	}
	if !isPathSegment(namespace) || !isPathSegment(repository.Slug) {
		return nil, fmt.Errorf("repository namespace and slug must be URL path segments")
	}
	cloneURL := *c.CloneBase
	cloneURL.Path = path.Join("/", cloneURL.Path, namespace, repository.Slug+".git")
	cloneURL.RawPath = ""
	cloneURL.User = nil
	return &cloneURL, nil
}

func isPathSegment(value string) bool {
	return value != "" && !strings.ContainsAny(value, "/\\?#")
}

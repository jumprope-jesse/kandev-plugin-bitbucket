package plugin

import (
	"context"
	"fmt"
	"net/url"
	pathpkg "path"
	"strings"

	"kandev-plugin-bitbucket/internal/domain"
)

// connectionIdentity distinguishes products and Data Center context paths.
// Host remains for legacy link migration; Scope is authoritative for new data.
type connectionIdentity struct {
	Product domain.Product
	Host    string
	Scope   string
	Binding string
}

func connectionIdentityForResolver(
	ctx context.Context,
	resolver ProviderResolver,
	workspaceID string,
) (connectionIdentity, bool, error) {
	connections, ok := resolver.(interface {
		Load(context.Context, string) (ConnectionSettings, bool, error)
	})
	if !ok {
		return connectionIdentity{}, false, nil
	}
	settings, found, err := connections.Load(ctx, workspaceID)
	if err != nil {
		return connectionIdentity{}, true, fmt.Errorf("load Bitbucket connection: %w", err)
	}
	if !found {
		return connectionIdentity{}, true, nil
	}
	identity := connectionIdentity{Product: settings.Product, Binding: settings.ConnectionBinding}
	if settings.Product == domain.ProductCloud {
		identity.Host = "bitbucket.org"
		identity.Scope = "https://bitbucket.org"
		return identity, true, nil
	}
	if settings.Product != domain.ProductDataCenter {
		return connectionIdentity{}, true, nil
	}
	scope, err := normalizeConnectionScope(settings.BaseURL)
	if err != nil {
		return connectionIdentity{}, true, nil
	}
	parsed, _ := url.Parse(scope)
	identity.Host = strings.ToLower(parsed.Host)
	identity.Scope = scope
	return identity, true, nil
}

func normalizeConnectionScope(raw string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.Host == "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", fmt.Errorf("connection scope must be a credential-free HTTPS URL")
	}
	parsed.Scheme = "https"
	parsed.Host = strings.ToLower(parsed.Host)
	parsed.RawPath = ""
	if parsed.Path == "" || parsed.Path == "/" {
		parsed.Path = ""
	} else {
		parsed.Path = strings.TrimSuffix(pathpkg.Clean("/"+strings.TrimPrefix(parsed.Path, "/")), "/")
	}
	return parsed.String(), nil
}

func urlWithinConnectionScope(rawURL, rawScope string) bool {
	value, err := url.Parse(rawURL)
	if err != nil || value.Scheme != "https" || value.User != nil || value.Host == "" {
		return false
	}
	scope, err := normalizeConnectionScope(rawScope)
	if err != nil {
		return false
	}
	base, _ := url.Parse(scope)
	if !strings.EqualFold(value.Scheme, base.Scheme) || !strings.EqualFold(value.Host, base.Host) {
		return false
	}
	basePath := strings.TrimSuffix(base.Path, "/")
	return basePath == "" || value.Path == basePath || strings.HasPrefix(value.Path, basePath+"/")
}

func sameConnectionScope(left, right string) bool {
	leftScope, leftErr := normalizeConnectionScope(left)
	rightScope, rightErr := normalizeConnectionScope(right)
	return leftErr == nil && rightErr == nil && leftScope == rightScope
}

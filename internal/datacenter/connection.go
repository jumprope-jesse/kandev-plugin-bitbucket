// Package datacenter owns Bitbucket Data Center endpoint normalization.
package datacenter

import (
	"fmt"
	"net/url"
	"path"
	"strings"

	"kandev-plugin-bitbucket/internal/domain"
)

// ConnectionOptions configures one Bitbucket Data Center installation.
type ConnectionOptions struct {
	BaseURL           string
	AllowInsecureHTTP bool
}

// NewConnection creates credential-free REST and clone endpoints.
func NewConnection(options ConnectionOptions) (domain.Connection, error) {
	base, err := url.Parse(options.BaseURL)
	if err != nil {
		return domain.Connection{}, fmt.Errorf("parse Data Center base URL: %w", err)
	}
	if err := validateBaseURL(base, options.AllowInsecureHTTP); err != nil {
		return domain.Connection{}, err
	}
	base.Path = cleanContextPath(base.Path)
	base.RawPath = ""

	apiBase := *base
	apiBase.Path = path.Join(base.Path, "rest", "api", "latest")
	cloneBase := *base
	cloneBase.Path = path.Join(base.Path, "scm")

	return domain.Connection{
		Product:   domain.ProductDataCenter,
		Scope:     base.String(),
		APIBase:   &apiBase,
		CloneBase: &cloneBase,
		Capabilities: domain.Capabilities{
			domain.CapabilityOAuthPKCE: true,
			domain.CapabilityIssues:    false,
		},
	}, nil
}

func validateBaseURL(base *url.URL, allowInsecureHTTP bool) error {
	if base.User != nil {
		return fmt.Errorf("Data Center base URL must not include credentials")
	}
	if base.Hostname() == "" {
		return fmt.Errorf("Data Center base URL must include a host")
	}
	if base.RawQuery != "" || base.Fragment != "" {
		return fmt.Errorf("Data Center base URL must not include query or fragment")
	}
	if !validContextPath(base) {
		return fmt.Errorf("Data Center base URL has an invalid context path")
	}
	if base.Scheme != "https" && !(allowInsecureHTTP && base.Scheme == "http") {
		return fmt.Errorf("Data Center base URL must use HTTPS")
	}
	return nil
}

func validContextPath(base *url.URL) bool {
	if base.Path == "" || base.Path == "/" {
		return base.RawPath == ""
	}
	if base.RawPath != "" || !strings.HasPrefix(base.Path, "/") || strings.Contains(base.Path, "\\") || strings.Contains(base.Path, "//") {
		return false
	}
	for _, segment := range strings.Split(strings.Trim(base.Path, "/"), "/") {
		if segment == "" || segment == "." || segment == ".." {
			return false
		}
	}
	return true
}

func cleanContextPath(contextPath string) string {
	if contextPath == "" || contextPath == "/" {
		return ""
	}
	return strings.TrimSuffix(path.Clean("/"+contextPath), "/")
}

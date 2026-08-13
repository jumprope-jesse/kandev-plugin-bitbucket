// Package redact removes credential material from errors and diagnostics.
package redact

import (
	"regexp"
	"sort"
	"strings"
)

var (
	credentialURL = regexp.MustCompile(`(?i)(https?://)[^/@\s]+@`)
	secretQuery   = regexp.MustCompile(`(?i)([?&](?:access_token|refresh_token|token|client_secret|code|password)=)[^&#\s]*`)
	authorization = regexp.MustCompile(`(?i)(authorization:\s*(?:bearer|basic|token)\s+)[^,\s]+`)
)

// Redactor removes all configured secret values and common credential formats.
type Redactor struct {
	secrets []string
}

// New builds a redactor. Longer values are replaced first.
func New(secrets ...string) Redactor {
	filtered := make([]string, 0, len(secrets))
	for _, secret := range secrets {
		if secret != "" {
			filtered = append(filtered, secret)
		}
	}
	sort.Slice(filtered, func(left, right int) bool {
		return len(filtered[left]) > len(filtered[right])
	})
	return Redactor{secrets: filtered}
}

// String returns a safe diagnostic string.
func (r Redactor) String(value string) string {
	for _, secret := range r.secrets {
		value = strings.ReplaceAll(value, secret, "[REDACTED]")
	}
	value = credentialURL.ReplaceAllString(value, "$1[REDACTED]@")
	value = secretQuery.ReplaceAllString(value, "$1[REDACTED]")
	return authorization.ReplaceAllString(value, "$1[REDACTED]")
}

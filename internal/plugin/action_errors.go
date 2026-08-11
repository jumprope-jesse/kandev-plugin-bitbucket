package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"kandev-plugin-bitbucket/internal/domain"

	"github.com/kandev/kandev/pkg/pluginsdk"
)

func actionFailureResponse(err error) (*pluginsdk.PluginActionResponse, error) {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return nil, err
	}
	status, code, message, retryAfter := classifyActionFailure(err)
	body, _ := json.Marshal(map[string]string{"error": message, "code": code})
	headers := map[string]string{"Content-Type": "application/json"}
	if retryAfter != "" {
		headers["Retry-After"] = retryAfter
	}
	return &pluginsdk.PluginActionResponse{Status: status, Headers: headers, Body: body}, nil
}

func classifyActionFailure(err error) (status int, code, message, retryAfter string) {
	var upstream *domain.ProviderHTTPError
	if errors.As(err, &upstream) {
		status = upstream.Status
		if status < 400 || status > 499 {
			status = http.StatusBadGateway
		}
		return actionFailureMetadata(status, upstream.RetryAfter)
	}
	value := strings.ToLower(err.Error())
	switch {
	case strings.Contains(value, "not associated"), strings.Contains(value, "authorization"):
		status = http.StatusForbidden
	case strings.Contains(value, "conflict"), strings.Contains(value, "changed; refresh"):
		status = http.StatusConflict
	case strings.Contains(value, "invalid"), strings.Contains(value, "required"),
		strings.Contains(value, "unsupported"), strings.Contains(value, "unknown"),
		strings.Contains(value, "must be"):
		status = http.StatusBadRequest
	case strings.Contains(value, "unavailable"), strings.Contains(value, "not configured"):
		status = http.StatusServiceUnavailable
	default:
		status = http.StatusBadGateway
	}
	return actionFailureMetadata(status, "")
}

func actionFailureMetadata(status int, retryAfter string) (int, string, string, string) {
	switch status {
	case http.StatusBadRequest:
		return status, "invalid_request", "Invalid Bitbucket action request.", ""
	case http.StatusUnauthorized, http.StatusForbidden:
		return status, "authorization_failed", "Bitbucket authorization failed.", ""
	case http.StatusNotFound:
		return status, "not_found", "Bitbucket resource was not found.", ""
	case http.StatusConflict:
		return status, "conflict", "Bitbucket resource changed. Refresh and retry.", ""
	case http.StatusTooManyRequests:
		return status, "rate_limited", "Bitbucket rate limit reached. Retry later.", retryAfter
	case http.StatusServiceUnavailable:
		return status, "unavailable", "Bitbucket connection is unavailable.", retryAfter
	default:
		return status, "upstream_failure", "Bitbucket request failed.", retryAfter
	}
}

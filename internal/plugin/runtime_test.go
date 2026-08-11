package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"

	"kandev-plugin-bitbucket/internal/domain"
	"kandev-plugin-bitbucket/internal/watches"

	"github.com/kandev/kandev/pkg/pluginsdk"
	"github.com/stretchr/testify/require"
)

func TestRuntime_MapsExpectedActionFailuresToDomainResponses(t *testing.T) {
	provider := &workflowProvider{pullRequest: testPullRequest()}
	workflows, err := NewWorkflows(newConnectionHost(), staticResolver{provider: provider})
	require.NoError(t, err)
	runtime := &Runtime{workflows: workflows}

	response, err := runtime.HandleAction(context.Background(), &pluginsdk.PluginActionRequest{
		ActionKey: "repositories.inspect",
		Context:   pluginsdk.VerifiedActionContext{WorkspaceID: "workspace-1"},
		Body:      []byte(`{"url":42}`),
	})

	require.NoError(t, err)
	require.Equal(t, http.StatusBadRequest, response.Status)
	var body map[string]any
	require.NoError(t, json.Unmarshal(response.Body, &body))
	require.Equal(t, string(pluginsdk.ActionErrorInvalidArgument), body["code"])
	require.NotContains(t, string(response.Body), "cannot unmarshal")
}

func TestRuntime_PreservesProviderRateLimitWithoutLeakingDetails(t *testing.T) {
	provider := &workflowProvider{
		pullRequest: testPullRequest(),
		reviewErr: &domain.ProviderHTTPError{
			Status: http.StatusTooManyRequests, RetryAfter: "30",
			Err: errors.New("secret upstream body"),
		},
	}
	workflows, err := NewWorkflows(newConnectionHost(), staticResolver{provider: provider})
	require.NoError(t, err)
	runtime := &Runtime{workflows: workflows}

	response, err := runtime.HandleAction(context.Background(), &pluginsdk.PluginActionRequest{
		ActionKey: "pullrequests.inspect",
		Context:   pluginsdk.VerifiedActionContext{WorkspaceID: "workspace-1"},
		Body:      []byte(`{"review_key":"workspace/repo#42"}`),
	})

	require.NoError(t, err)
	require.Equal(t, http.StatusTooManyRequests, response.Status)
	require.Equal(t, "30", response.Headers["Retry-After"])
	var body map[string]any
	require.NoError(t, json.Unmarshal(response.Body, &body))
	require.Equal(t, string(pluginsdk.ActionErrorRateLimited), body["code"])
	require.NotContains(t, string(response.Body), "secret upstream body")
}

func TestActionFailureClassificationUsesTypedWatchErrors(t *testing.T) {
	status, code, _, _ := classifyActionFailure(categorizeWatchActionError(watches.ErrWatchNotFound))
	require.Equal(t, http.StatusNotFound, status)
	require.Equal(t, "not_found", code)

	status, code, _, _ = classifyActionFailure(errors.New("watch not found"))
	require.Equal(t, http.StatusBadGateway, status, "message text must not define transport semantics")
	require.Equal(t, string(pluginsdk.ActionErrorUpstream), code)
}

func TestConnectionHealthUsesTypedProviderAuthenticationStatus(t *testing.T) {
	settings := ConnectionSettings{Product: domain.ProductCloud}
	auth := connectionResponse(settings, false, &domain.ProviderHTTPError{Status: http.StatusUnauthorized})
	unavailable := connectionResponse(settings, false, &domain.ProviderHTTPError{Status: http.StatusServiceUnavailable, Err: errors.New("authorization service")})

	require.Equal(t, "auth_required", auth["state"])
	require.Equal(t, "unavailable", unavailable["state"], "error wording must not masquerade as authentication failure")
}

package cloud

import (
	"fmt"
	"net/http"

	"kandev-plugin-bitbucket/internal/domain"
)

func providerResponseError(response *http.Response) error {
	return &domain.ProviderHTTPError{
		Status: response.StatusCode, RetryAfter: response.Header.Get("Retry-After"),
		Err: fmt.Errorf("Bitbucket Cloud returned %s", response.Status),
	}
}

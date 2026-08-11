package cloud

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"path"

	"kandev-plugin-bitbucket/internal/domain"
)

func (c *Client) repositoryEndpoint(repository domain.Repository, elements ...string) url.URL {
	endpoint := *c.apiBase
	segments := append([]string{endpoint.Path, "repositories", repository.Namespace, repository.Slug}, elements...)
	endpoint.Path = path.Join(segments...)
	endpoint.RawPath = ""
	return endpoint
}

func (c *Client) getJSON(ctx context.Context, endpoint *url.URL, target any) error {
	if c.tokenSource == nil {
		return fmt.Errorf("Cloud token source is not configured")
	}
	token, _, err := c.accessToken(ctx)
	if err != nil {
		return fmt.Errorf("resolve Cloud access token: %w", err)
	}
	for attempt := 0; attempt < 3; attempt++ {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
		if err != nil {
			return err
		}
		request.Header.Set("Accept", "application/json")
		if err := c.authorize(request, token); err != nil {
			return err
		}
		response, err := c.httpClient.Do(request)
		if err != nil {
			return fmt.Errorf("request Bitbucket Cloud: %w", err)
		}
		if (response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= http.StatusInternalServerError) && attempt < 2 {
			delay := c.retryDelay(attempt, retryAfter(response.Header.Get("Retry-After")))
			response.Body.Close()
			if err := wait(ctx, delay); err != nil {
				return err
			}
			continue
		}
		if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
			responseErr := providerResponseError(response)
			response.Body.Close()
			return responseErr
		}
		body, err := readBounded(response.Body, c.maxResponseBytes)
		response.Body.Close()
		if err != nil {
			return err
		}
		if err := json.Unmarshal(body, target); err != nil {
			return fmt.Errorf("decode Bitbucket Cloud response: %w", err)
		}
		return nil
	}
	return fmt.Errorf("Bitbucket Cloud request retry limit exceeded")
}

func (c *Client) getText(ctx context.Context, endpoint *url.URL) (string, error) {
	if c.tokenSource == nil {
		return "", fmt.Errorf("Cloud token source is not configured")
	}
	token, _, err := c.accessToken(ctx)
	if err != nil {
		return "", fmt.Errorf("resolve Cloud access token: %w", err)
	}
	for attempt := 0; attempt < 3; attempt++ {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
		if err != nil {
			return "", err
		}
		request.Header.Set("Accept", "text/plain")
		if err := c.authorize(request, token); err != nil {
			return "", err
		}
		response, err := c.httpClient.Do(request)
		if err != nil {
			return "", fmt.Errorf("request Bitbucket Cloud: %w", err)
		}
		if (response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= http.StatusInternalServerError) && attempt < 2 {
			delay := c.retryDelay(attempt, retryAfter(response.Header.Get("Retry-After")))
			response.Body.Close()
			if err := wait(ctx, delay); err != nil {
				return "", err
			}
			continue
		}
		if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
			responseErr := providerResponseError(response)
			response.Body.Close()
			return "", responseErr
		}
		body, err := readBounded(response.Body, c.maxResponseBytes)
		response.Body.Close()
		if err != nil {
			return "", err
		}
		return string(body), nil
	}
	return "", fmt.Errorf("Bitbucket Cloud request retry limit exceeded")
}

func (c *Client) json(ctx context.Context, method string, endpoint *url.URL, input any, target any) error {
	var body []byte
	var err error
	if input != nil {
		body, err = json.Marshal(input)
		if err != nil {
			return err
		}
	}
	if c.tokenSource == nil {
		return fmt.Errorf("Cloud token source is not configured")
	}
	token, _, err := c.accessToken(ctx)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	if err := c.authorize(request, token); err != nil {
		return err
	}
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return providerResponseError(response)
	}
	if target == nil {
		return nil
	}
	data, err := readBounded(response.Body, c.maxResponseBytes)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, target)
}

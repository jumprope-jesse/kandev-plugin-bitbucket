package domain

import "fmt"

// ProviderHTTPError preserves actionable upstream status metadata without
// making response bodies or secrets part of the plugin's public error text.
type ProviderHTTPError struct {
	Status     int
	RetryAfter string
	Err        error
}

func (e *ProviderHTTPError) Error() string {
	if e == nil {
		return "Bitbucket provider request failed"
	}
	return fmt.Sprintf("Bitbucket provider request returned HTTP %d", e.Status)
}

func (e *ProviderHTTPError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

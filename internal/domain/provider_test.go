package domain_test

import (
	"testing"

	"kandev-plugin-bitbucket/internal/cloud"
	"kandev-plugin-bitbucket/internal/datacenter"
	"kandev-plugin-bitbucket/internal/domain"
)

func TestCloudAndDataCenterImplementProviderBoundary(t *testing.T) {
	var _ domain.Provider = (*cloud.Client)(nil)
	var _ domain.Provider = (*datacenter.Client)(nil)
}

package main

import (
	"os"
	"testing"

	"github.com/stretchr/testify/require"
	"gopkg.in/yaml.v3"
)

func TestManifestParses(t *testing.T) {
	contents, err := os.ReadFile("../manifest.yaml")
	require.NoError(t, err)

	var manifest map[string]any
	require.NoError(t, yaml.Unmarshal(contents, &manifest))
}

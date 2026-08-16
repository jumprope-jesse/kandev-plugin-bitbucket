package main

import (
	"encoding/xml"
	"os"
	"path/filepath"
	"strings"
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

func TestManifestIncludesPackagedMarketplaceIcon(t *testing.T) {
	contents, err := os.ReadFile("../manifest.yaml")
	require.NoError(t, err)

	var manifest struct {
		Icon string `yaml:"icon"`
	}
	require.NoError(t, yaml.Unmarshal(contents, &manifest))
	require.Equal(t, "assets/icon.svg", manifest.Icon)

	icon, err := os.ReadFile(filepath.Join("..", filepath.FromSlash(manifest.Icon)))
	require.NoError(t, err)
	assertMarketplaceSVG(t, icon)
}

func assertMarketplaceSVG(t *testing.T, icon []byte) {
	t.Helper()

	var root struct {
		XMLName xml.Name
		Width   string `xml:"width,attr"`
		Height  string `xml:"height,attr"`
		ViewBox string `xml:"viewBox,attr"`
	}
	require.NoError(t, xml.Unmarshal(icon, &root))
	require.Equal(t, "svg", root.XMLName.Local)
	require.Equal(t, "128", root.Width)
	require.Equal(t, "128", root.Height)
	require.Equal(t, "0 0 128 128", root.ViewBox)

	lower := strings.ToLower(string(icon))
	for _, forbidden := range []string{"<script", "<foreignobject", "href=", "url(", "currentcolor"} {
		require.NotContains(t, lower, forbidden)
	}
}

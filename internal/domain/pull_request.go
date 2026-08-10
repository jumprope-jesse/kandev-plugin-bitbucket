package domain

import (
	"fmt"
	"time"
)

// Branch is a provider-neutral Git branch.
type Branch struct {
	Name      string
	Commit    string
	IsDefault bool
}

// PullRequest is a provider-neutral pull request summary and inspection result.
type PullRequest struct {
	Repository       Repository
	SourceRepository Repository
	Number           int
	// Version is the optimistic-lock value required by Data Center merge APIs.
	Version     int
	Title       string
	Description string
	State       string
	// Author is the provider's canonical PR author identity (Cloud account id
	// or Data Center user slug), not a display label.
	Author            string
	AuthorDisplayName string
	CreatedAt         time.Time
	Source            Branch
	Destination       Branch
	URL               string
	Capabilities      Capabilities
}

// Key returns the stable external identity used for links and watch deduplication.
func (p PullRequest) Key() string {
	return fmt.Sprintf("%s/%s#%d", p.Repository.Namespace, p.Repository.Slug, p.Number)
}

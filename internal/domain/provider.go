package domain

import (
	"context"
	"fmt"
	"time"
)

const (
	CapabilityBranches      Capability = "branches"
	CapabilityPullRequests  Capability = "pull_requests"
	CapabilityReview        Capability = "review"
	CapabilityApprove       Capability = "approve"
	CapabilityMerge         Capability = "merge"
	CapabilityDecline       Capability = "decline"
	CapabilityComments      Capability = "comments"
	CapabilityThreadReplies Capability = "thread_replies"
	CapabilityBuildStatuses Capability = "build_statuses"
	CapabilityBuildActions  Capability = "build_actions"
)

// CreatePullRequestInput carries only provider-neutral create fields.
type CreatePullRequestInput struct {
	Repository         Repository
	Title              string
	Description        string
	Source             string
	Destination        string
	CloseSourceOnMerge bool
}

// Commit is a review commit summary.
type Commit struct {
	Hash    string
	Message string
	Author  string
	When    time.Time
}

// Participant captures a review participant and approval state.
type Participant struct {
	ID       string
	Name     string
	Role     string
	Approved bool
}

// Comment is a provider-neutral review comment.
type Comment struct {
	ID       string
	ParentID string
	Author   string
	Body     string
	When     time.Time
}

// Thread groups a root review comment and replies.
type Thread struct {
	ID       string
	Comments []Comment
}

// BuildStatus preserves provider-specific pipeline/build state without equating APIs.
type BuildStatus struct {
	Key    string
	Name   string
	State  string
	URL    string
	Target string
}

// ReviewFile is a provider-neutral changed file with a bounded display patch.
// Status is one of added, modified, deleted, or renamed.
type ReviewFile struct {
	Path      string
	Status    string
	Additions int
	Deletions int
	Patch     string
}

// Review contains provider-rendered data used by native review panels.
type Review struct {
	PullRequest  PullRequest
	Diff         string
	Files        []ReviewFile
	Commits      []Commit
	Participants []Participant
	Threads      []Thread
	Statuses     []BuildStatus
}

// Mutation names capability-gated provider actions.
type Mutation string

const (
	MutationApprove      Mutation = "approve"
	MutationUnapprove    Mutation = "unapprove"
	MutationMerge        Mutation = "merge"
	MutationDecline      Mutation = "decline"
	MutationAddComment   Mutation = "add_comment"
	MutationReply        Mutation = "reply"
	MutationTriggerBuild Mutation = "trigger_build"
)

// MutationInput carries the bounded action data accepted by a provider adapter.
type MutationInput struct {
	Kind            Mutation
	Comment         string
	ParentCommentID string
	BuildKey        string
}

type PullRequestQuery struct {
	Repository Repository
	Text       string
	// State is OPEN, MERGED, DECLINED, or ALL. An empty state preserves the
	// provider's open-pull-request default.
	State string
	Limit int
	// Cursor is an opaque provider-issued page cursor. Callers must only reuse
	// a value returned by PullRequestPager for the same query.
	Cursor string
}

// PullRequestPage carries a bounded page and an opaque continuation token.
// Empty NextCursor means the query is exhausted.
type PullRequestPage struct {
	PullRequests []PullRequest
	NextCursor   string
}

// PullRequestPager is optional while older adapters continue to implement
// Provider. Watches require it so they can resume without lexical cursors.
type PullRequestPager interface {
	SearchPullRequestsPage(context.Context, PullRequestQuery) (PullRequestPage, error)
}

// PullRequestLocator identifies a pull request parsed from a credential-free URL.
type PullRequestLocator struct {
	Repository Repository
	Number     int
}

type ReviewAction = MutationInput
type GitCredential struct {
	Username, Secret string
	ExpiresAt        time.Time
}

// Capability returns the required provider capability for a mutation.
func (m Mutation) Capability() (Capability, error) {
	switch m {
	case MutationApprove, MutationUnapprove:
		return CapabilityApprove, nil
	case MutationMerge:
		return CapabilityMerge, nil
	case MutationDecline:
		return CapabilityDecline, nil
	case MutationAddComment:
		return CapabilityComments, nil
	case MutationReply:
		return CapabilityThreadReplies, nil
	case MutationTriggerBuild:
		return CapabilityBuildActions, nil
	default:
		return "", fmt.Errorf("unsupported pull request mutation %q", m)
	}
}

// Provider is the adapter contract consumed by plugin workflows, watches, and reviews.
type Provider interface {
	Capabilities() Capabilities
	InspectRepositoryURL(string) (Repository, error)
	InspectPullRequestURL(string) (PullRequestLocator, error)
	ListRepositories(context.Context, string, int) ([]Repository, error)
	ListBranches(context.Context, Repository) ([]Branch, error)
	SearchPullRequests(context.Context, PullRequestQuery) ([]PullRequest, error)
	GetPullRequest(context.Context, Repository, int) (PullRequest, error)
	CreatePullRequest(context.Context, CreatePullRequestInput) (PullRequest, error)
	GetReview(context.Context, Repository, int) (Review, error)
	ApplyReviewAction(context.Context, PullRequest, ReviewAction) (PullRequest, error)
	Health(context.Context) error
	ResolveGitCredential(context.Context) (GitCredential, error)
}

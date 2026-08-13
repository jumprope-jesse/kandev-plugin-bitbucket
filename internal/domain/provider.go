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

type ReviewVerdict string

const (
	ReviewVerdictPending          ReviewVerdict = "pending"
	ReviewVerdictApproved         ReviewVerdict = "approved"
	ReviewVerdictChangesRequested ReviewVerdict = "changes_requested"
)

// Participant captures a provider-neutral review verdict. Approved remains
// for source compatibility; Verdict preserves Data Center NEEDS_WORK.
type Participant struct {
	ID       string
	Name     string
	Role     string
	Approved bool
	Verdict  ReviewVerdict
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
	ViewerID     string
	Diff         string
	Files        []ReviewFile
	Commits      []Commit
	Participants []Participant
	Threads      []Thread
	Statuses     []BuildStatus
	// UnresolvedThreadCount is populated by lightweight projections when the
	// provider can report it without downloading comment bodies.
	UnresolvedThreadCount *int
}

// ReviewProjection declares exactly which potentially expensive review
// sections a caller needs. PullRequest is always returned.
type ReviewProjection struct {
	Diff         bool
	Files        bool
	Commits      bool
	Participants bool
	Threads      bool
	Statuses     bool
	Viewer       bool
	ThreadCount  bool
}

func FullReviewProjection() ReviewProjection {
	return ReviewProjection{
		Diff: true, Files: true, Commits: true, Participants: true,
		Threads: true, Statuses: true, Viewer: true,
	}
}

// ProjectedReviewProvider is an additive adapter capability. Callers retain a
// bounded fallback for older Provider implementations.
type ProjectedReviewProvider interface {
	GetReviewProjected(context.Context, Repository, int, ReviewProjection) (Review, error)
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

// RepositoryQuery carries server-side search and an opaque continuation.
type RepositoryQuery struct {
	Text   string
	Limit  int
	Cursor string
}

// RepositoryPage is a bounded provider page. Empty NextCursor is terminal.
type RepositoryPage struct {
	Repositories []Repository
	NextCursor   string
}

// RepositoryPager is optional for adapter compatibility. Rich repository
// discovery requires it so large installations are never silently truncated.
type RepositoryPager interface {
	ListRepositoriesPage(context.Context, string, RepositoryQuery) (RepositoryPage, error)
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

// Package watches persists and reconciles Bitbucket pull-request watches.
package watches

import (
	"context"
	"errors"
	"time"
)

var (
	ErrWatchNotFound = errors.New("watch not found")
	ErrWatchPaused   = errors.New("watch is paused")
)

type Status string

const (
	StatusRunning Status = "running"
	StatusPaused  Status = "paused"
)

type ReservationState string

const (
	ReservationCreating ReservationState = "creating"
	ReservationCreated  ReservationState = "created"
)

// Filter is the provider-neutral subset used to select pull requests.
type Filter struct {
	RepositoryIDs []string           `json:"repository_ids,omitempty"`
	Repositories  []RemoteRepository `json:"repositories,omitempty"`
	States        []string           `json:"states,omitempty"`
	Authors       []string           `json:"authors,omitempty"`
	Query         string             `json:"query,omitempty"`
}

// Launch configures tasks created by a watch.
type Launch struct {
	WorkflowID        string `json:"workflow_id,omitempty"`
	WorkflowStepID    string `json:"workflow_step_id,omitempty"`
	AgentProfileID    string `json:"agent_profile_id,omitempty"`
	ExecutorProfileID string `json:"executor_profile_id,omitempty"`
	Prompt            string `json:"prompt,omitempty"`
	StartAgent        bool   `json:"start_agent,omitempty"`
}

type Preset struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Filter Filter `json:"filter"`
}

// PullRequest is a canonical provider item. Key must be stable across polls.
type PullRequest struct {
	Key             string           `json:"key"`
	RepositoryID    string           `json:"repository_id"`
	Repository      RemoteRepository `json:"repository"`
	Number          int64            `json:"number"`
	Title           string           `json:"title"`
	URL             string           `json:"url"`
	State           string           `json:"state"`
	Author          string           `json:"author"`
	UpdatedAt       time.Time        `json:"updated_at"`
	Attributes      map[string]any   `json:"attributes,omitempty"`
	ConnectionScope string           `json:"connection_scope,omitempty"`
}

// RemoteRepository is the complete, credential-free descriptor Kandev needs
// to create an externally backed task without parsing provider URLs itself.
type RemoteRepository struct {
	ProviderID           string `json:"provider_id"`
	ProviderHost         string `json:"provider_host"`
	ProviderScope        string `json:"provider_scope"`
	OwnerOrProject       string `json:"owner_or_project"`
	ProviderRepositoryID string `json:"provider_repository_id"`
	Name                 string `json:"name"`
	CloneURL             string `json:"clone_url"`
	DefaultBranch        string `json:"default_branch,omitempty"`
	BaseBranch           string `json:"base_branch,omitempty"`
	HeadBranch           string `json:"head_branch,omitempty"`
}

type Reservation struct {
	Token     string           `json:"token"`
	State     ReservationState `json:"state"`
	TaskID    string           `json:"task_id,omitempty"`
	CreatedAt time.Time        `json:"created_at"`
	// Link preserves provider identity across a crash after task creation.
	Link TaskLink `json:"link,omitempty"`
}

// TaskLink records a task associated with a watch. Only owned links are
// eligible for reset/delete cascade cleanup.
type TaskLink struct {
	PullRequestKey  string `json:"pull_request_key"`
	TaskID          string `json:"task_id"`
	Owned           bool   `json:"owned"`
	ProviderID      string `json:"provider_id,omitempty"`
	ProviderHost    string `json:"provider_host,omitempty"`
	ConnectionScope string `json:"connection_scope,omitempty"`
	PullRequestURL  string `json:"pull_request_url,omitempty"`
}

type Watch struct {
	ID           string                 `json:"id"`
	WorkspaceID  string                 `json:"workspace_id"`
	Status       Status                 `json:"status"`
	Filter       Filter                 `json:"filter"`
	Launch       Launch                 `json:"launch"`
	Presets      map[string]Preset      `json:"presets,omitempty"`
	Cursor       string                 `json:"cursor,omitempty"`
	LastPolled   time.Time              `json:"last_polled,omitempty"`
	Failures     int                    `json:"failures,omitempty"`
	Links        map[string]TaskLink    `json:"links,omitempty"`
	Reservations map[string]Reservation `json:"reservations,omitempty"`
}

type Snapshot struct {
	Watches map[string]Watch `json:"watches"`
}

type Repository interface {
	Load(context.Context, string) (Snapshot, error)
	Save(context.Context, string, Snapshot) error
}

type Provider interface {
	ListPullRequests(context.Context, Watch) ([]PullRequest, string, error)
}

type Creation struct {
	WorkspaceID      string
	Watch            Watch
	PullRequest      PullRequest
	ReservationToken string
}

// TaskCreator owns calls to the host task API. FindByReservation makes a
// crash between task creation and state persistence recoverable without a
// duplicate task.
type TaskCreator interface {
	FindByReservation(context.Context, string, string) (taskID string, found bool, err error)
	Create(context.Context, Creation) (taskID string, err error)
	PreviewOwned(context.Context, string) ([]string, error)
	DeleteOwned(context.Context, string) ([]string, error)
}

type EventSink interface {
	Emit(context.Context, string, map[string]any) error
}

type Options struct {
	Repository Repository
	Provider   Provider
	Tasks      TaskCreator
	Events     EventSink
	Now        func() time.Time
	Token      func() (string, error)
}

type RunResult struct {
	Created int
	Skipped int
}

type ResetPreview struct {
	TaskIDs []string
}

type ResetResult struct {
	DeletedTaskIDs []string
}

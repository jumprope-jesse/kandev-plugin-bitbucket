package watches

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestRun_CreatesOneOwnedTaskAfterPersistingReservation(t *testing.T) {
	repository := &memoryRepository{snapshots: map[string]Snapshot{
		"workspace-1": {Watches: map[string]Watch{
			"watch-1": {ID: "watch-1", WorkspaceID: "workspace-1", Status: StatusRunning},
		}},
	}}
	tasks := &recordingTasks{beforeCreate: func() bool {
		watch := repository.snapshots["workspace-1"].Watches["watch-1"]
		reservation, found := watch.Reservations["repo-1#42"]
		return found && reservation.State == ReservationCreating && reservation.Token != ""
	}}
	service, err := NewService(Options{
		Repository: repository,
		Provider:   staticProvider{items: []PullRequest{{Key: "repo-1#42", RepositoryID: "repo-1", Number: 42, Title: "Fix race"}}, nextCursor: "next"},
		Tasks:      tasks,
		Now:        func() time.Time { return time.Date(2026, 7, 31, 12, 0, 0, 0, time.UTC) },
		Token:      func() (string, error) { return "reservation-token", nil },
	})
	require.NoError(t, err)

	result, err := service.Run(context.Background(), "workspace-1", "watch-1")
	require.NoError(t, err)
	require.Equal(t, 1, result.Created)
	require.Equal(t, 1, tasks.createCalls)
	require.True(t, tasks.reservationWasPersisted)

	watch := repository.snapshots["workspace-1"].Watches["watch-1"]
	require.Equal(t, "next", watch.Cursor)
	require.Equal(t, "task-1", watch.Links["repo-1#42"].TaskID)
	require.True(t, watch.Links["repo-1#42"].Owned)
	require.Equal(t, ReservationCreated, watch.Reservations["repo-1#42"].State)
}

func TestRun_ResumesPersistedProviderCursorAfterServiceRestart(t *testing.T) {
	firstPage := make([]PullRequest, 0, 100)
	for number := 1; number <= 100; number++ {
		firstPage = append(firstPage, PullRequest{Key: fmt.Sprintf("repo-1#%d", number), RepositoryID: "repo-1", Number: int64(number)})
	}
	repository := &memoryRepository{snapshots: map[string]Snapshot{"workspace-1": {Watches: map[string]Watch{
		"watch-1": {ID: "watch-1", WorkspaceID: "workspace-1", Status: StatusRunning},
	}}}}
	provider := &cursorProvider{pages: map[string]cursorPage{
		"":                {items: firstPage, next: "provider-page-2"},
		"provider-page-2": {items: []PullRequest{{Key: "repo-1#101", RepositoryID: "repo-1", Number: 101}}},
	}}
	tasks := &recordingTasks{}
	service, err := NewService(Options{Repository: repository, Provider: provider, Tasks: tasks})
	require.NoError(t, err)

	first, err := service.Run(context.Background(), "workspace-1", "watch-1")
	require.NoError(t, err)
	require.Equal(t, 100, first.Created)
	require.Equal(t, "provider-page-2", repository.snapshots["workspace-1"].Watches["watch-1"].Cursor)

	// A fresh Service simulates a plugin process restart. The durable snapshot
	// must resume at the provider cursor instead of re-polling the first page.
	restarted, err := NewService(Options{Repository: repository, Provider: provider, Tasks: tasks})
	require.NoError(t, err)
	second, err := restarted.Run(context.Background(), "workspace-1", "watch-1")
	require.NoError(t, err)
	require.Equal(t, 1, second.Created)
	require.Equal(t, "", repository.snapshots["workspace-1"].Watches["watch-1"].Cursor)
	require.Equal(t, []string{"", "provider-page-2"}, provider.cursors)
	require.Equal(t, 101, tasks.createCalls)
}

func TestRun_ReconcilesCreatingReservationWithoutDuplicateTask(t *testing.T) {
	repository := &memoryRepository{snapshots: map[string]Snapshot{
		"workspace-1": {Watches: map[string]Watch{
			"watch-1": {
				ID:          "watch-1",
				WorkspaceID: "workspace-1",
				Status:      StatusRunning,
				Reservations: map[string]Reservation{
					"repo-1#42": {Token: "durable-reservation", State: ReservationCreating},
				},
			},
		}},
	}}
	tasks := &recordingTasks{findTaskID: "created-before-crash"}
	service, err := NewService(Options{
		Repository: repository,
		Provider:   staticProvider{items: []PullRequest{{Key: "repo-1#42", RepositoryID: "repo-1", Number: 42}}},
		Tasks:      tasks,
	})
	require.NoError(t, err)

	result, err := service.Run(context.Background(), "workspace-1", "watch-1")
	require.NoError(t, err)
	require.Zero(t, result.Created)
	require.Equal(t, 1, result.Skipped)
	require.Equal(t, 0, tasks.createCalls)

	watch := repository.snapshots["workspace-1"].Watches["watch-1"]
	require.Equal(t, "created-before-crash", watch.Links["repo-1#42"].TaskID)
	require.Equal(t, ReservationCreated, watch.Reservations["repo-1#42"].State)
}

func TestRecover_FinalizesCreatingReservationAfterRestart(t *testing.T) {
	repository := &memoryRepository{snapshots: map[string]Snapshot{
		"workspace-1": {Watches: map[string]Watch{
			"watch-1": {
				ID: "watch-1", WorkspaceID: "workspace-1", Status: StatusRunning,
				Reservations: map[string]Reservation{
					"repo-1#42": {
						Token: "created-before-restart", State: ReservationCreating,
						Link: TaskLink{
							PullRequestKey: "repo-1#42", ProviderID: "bitbucket",
							ProviderHost:    "https://bitbucket.example.test",
							ConnectionScope: "https://bitbucket.example.test/context",
						},
					},
				},
			},
		}},
	}}
	tasks := &recordingTasks{findTaskID: "task-created-before-restart"}
	service, err := NewService(Options{Repository: repository, Provider: staticProvider{}, Tasks: tasks})
	require.NoError(t, err)

	recovered, err := service.Recover(context.Background(), "workspace-1")
	require.NoError(t, err)
	require.Equal(t, 1, recovered)
	require.Zero(t, tasks.createCalls)

	watch := repository.snapshots["workspace-1"].Watches["watch-1"]
	require.Equal(t, "task-created-before-restart", watch.Links["repo-1#42"].TaskID)
	require.Equal(t, "bitbucket", watch.Links["repo-1#42"].ProviderID)
	require.Equal(t, "https://bitbucket.example.test/context", watch.Links["repo-1#42"].ConnectionScope)
	require.Equal(t, ReservationCreated, watch.Reservations["repo-1#42"].State)
}

func TestDelete_ReconcilesTaskCreatedBeforeCrashWithoutExplicitRecover(t *testing.T) {
	repository := &memoryRepository{snapshots: map[string]Snapshot{
		"workspace-1": {Watches: map[string]Watch{
			"watch-1": {
				ID: "watch-1", WorkspaceID: "workspace-1", Status: StatusRunning,
				Reservations: map[string]Reservation{
					"repo-1#42": {
						Token: "created-before-crash", State: ReservationCreating,
						Link: TaskLink{PullRequestKey: "repo-1#42", ProviderID: "bitbucket"},
					},
				},
			},
		}},
	}}
	tasks := &recordingTasks{
		findTaskID:  "task-created-before-crash",
		deletedTree: []string{"task-created-before-crash"},
	}
	service, err := NewService(Options{Repository: repository, Provider: staticProvider{}, Tasks: tasks})
	require.NoError(t, err)

	result, err := service.Delete(context.Background(), "workspace-1", "watch-1")

	require.NoError(t, err)
	require.Equal(t, []string{"task-created-before-crash"}, result.DeletedTaskIDs)
	require.Equal(t, []string{"task-created-before-crash"}, tasks.deleted)
	require.NotContains(t, repository.snapshots["workspace-1"].Watches, "watch-1")
}

func TestRun_RetainsCreatingReservationWhenTaskCreationFails(t *testing.T) {
	repository := &memoryRepository{snapshots: map[string]Snapshot{
		"workspace-1": {Watches: map[string]Watch{
			"watch-1": {ID: "watch-1", WorkspaceID: "workspace-1", Status: StatusRunning},
		}},
	}}
	tasks := &recordingTasks{createErr: errors.New("host unavailable")}
	service, err := NewService(Options{
		Repository: repository, Provider: staticProvider{items: []PullRequest{{Key: "repo-1#42", RepositoryID: "repo-1", Number: 42}}}, Tasks: tasks,
		Token: func() (string, error) { return "durable-token", nil },
	})
	require.NoError(t, err)

	_, err = service.Run(context.Background(), "workspace-1", "watch-1")
	require.Error(t, err)
	watch := repository.snapshots["workspace-1"].Watches["watch-1"]
	reservation := watch.Reservations["repo-1#42"]
	require.Equal(t, ReservationCreating, reservation.State)
	require.Equal(t, "durable-token", reservation.Token)
	require.NotContains(t, watch.Links, "repo-1#42")
}

func TestRun_ConcurrentPollsCreateAtMostOneTask(t *testing.T) {
	repository := &memoryRepository{snapshots: map[string]Snapshot{
		"workspace-1": {Watches: map[string]Watch{
			"watch-1": {ID: "watch-1", WorkspaceID: "workspace-1", Status: StatusRunning},
		}},
	}}
	provider := blockingProvider{
		started: make(chan struct{}),
		release: make(chan struct{}),
		item:    PullRequest{Key: "repo-1#42", RepositoryID: "repo-1", Number: 42},
	}
	tasks := &recordingTasks{}
	service, err := NewService(Options{Repository: repository, Provider: &provider, Tasks: tasks})
	require.NoError(t, err)

	firstDone := make(chan error, 1)
	go func() {
		_, runErr := service.Run(context.Background(), "workspace-1", "watch-1")
		firstDone <- runErr
	}()
	<-provider.started

	secondDone := make(chan error, 1)
	go func() {
		_, runErr := service.Run(context.Background(), "workspace-1", "watch-1")
		secondDone <- runErr
	}()
	close(provider.release)
	require.NoError(t, <-firstDone)
	require.NoError(t, <-secondDone)
	require.Equal(t, 1, tasks.createCalls)
}

func TestRun_DoesNotConflatePullRequestsAfterRepositoryRecreation(t *testing.T) {
	repository := &memoryRepository{snapshots: map[string]Snapshot{
		"workspace-1": {Watches: map[string]Watch{
			"watch-1": {ID: "watch-1", WorkspaceID: "workspace-1", Status: StatusRunning},
		}},
	}}
	provider := &mutableProvider{items: []PullRequest{completePullRequest("repo-old")}}
	tasks := &recordingTasks{}
	service, err := NewService(Options{Repository: repository, Provider: provider, Tasks: tasks})
	require.NoError(t, err)

	first, err := service.Run(context.Background(), "workspace-1", "watch-1")
	require.NoError(t, err)
	require.Equal(t, 1, first.Created)
	provider.items = []PullRequest{completePullRequest("repo-new")}
	second, err := service.Run(context.Background(), "workspace-1", "watch-1")
	require.NoError(t, err)
	require.Equal(t, 1, second.Created)
	require.Equal(t, 2, tasks.createCalls)
	require.Len(t, repository.snapshots["workspace-1"].Watches["watch-1"].Links, 2)
}

func TestRun_PausesWatchWhenConnectionBindingChanges(t *testing.T) {
	repository := &memoryRepository{snapshots: map[string]Snapshot{
		"workspace-1": {Watches: map[string]Watch{
			"watch-1": {ID: "watch-1", WorkspaceID: "workspace-1", Status: StatusRunning, ConnectionBinding: "connection-old"},
		}},
	}}
	provider := &bindingProvider{binding: "connection-new", items: []PullRequest{completePullRequest("repo-new")}}
	service, err := NewService(Options{Repository: repository, Provider: provider, Tasks: &recordingTasks{}})
	require.NoError(t, err)

	_, err = service.Run(context.Background(), "workspace-1", "watch-1")

	require.ErrorIs(t, err, ErrConnectionChanged)
	require.Equal(t, StatusPaused, repository.snapshots["workspace-1"].Watches["watch-1"].Status)
	require.Zero(t, provider.calls, "a stale watch must pause before querying the replacement connection")
}

func TestCreateAndResume_BindWatchToCurrentConnection(t *testing.T) {
	repository := &memoryRepository{snapshots: map[string]Snapshot{"workspace-1": {}}}
	provider := &bindingProvider{binding: "connection-one"}
	service, err := NewService(Options{Repository: repository, Provider: provider, Tasks: &recordingTasks{}})
	require.NoError(t, err)

	created, err := service.Create(context.Background(), Watch{ID: "watch-1", WorkspaceID: "workspace-1"})
	require.NoError(t, err)
	require.Equal(t, "connection-one", created.ConnectionBinding)
	_, err = service.Pause(context.Background(), "workspace-1", "watch-1")
	require.NoError(t, err)
	provider.binding = "connection-two"
	resumed, err := service.Resume(context.Background(), "workspace-1", "watch-1")
	require.NoError(t, err)
	require.Equal(t, "connection-two", resumed.ConnectionBinding)
	require.Empty(t, resumed.Cursor)
}

func TestReset_PreviewsAndDeletesOnlyWatchOwnedTaskTrees(t *testing.T) {
	repository := &memoryRepository{snapshots: map[string]Snapshot{
		"workspace-1": {Watches: map[string]Watch{
			"watch-1": {
				ID:          "watch-1",
				WorkspaceID: "workspace-1",
				Status:      StatusRunning,
				Links: map[string]TaskLink{
					"repo-1#owned":  {PullRequestKey: "repo-1#owned", TaskID: "owned-root", Owned: true},
					"repo-1#manual": {PullRequestKey: "repo-1#manual", TaskID: "manual-task", Owned: false},
				},
				Reservations: map[string]Reservation{
					"repo-1#owned":  {Token: "owned", State: ReservationCreated, TaskID: "owned-root"},
					"repo-1#manual": {Token: "manual", State: ReservationCreated, TaskID: "manual-task"},
				},
			},
		}},
	}}
	tasks := &recordingTasks{previewTree: []string{"owned-root", "owned-child"}, deletedTree: []string{"owned-root", "owned-child"}}
	service, err := NewService(Options{Repository: repository, Provider: staticProvider{}, Tasks: tasks})
	require.NoError(t, err)

	preview, err := service.PreviewReset(context.Background(), "workspace-1", "watch-1")
	require.NoError(t, err)
	require.Equal(t, []string{"owned-root", "owned-child"}, preview.TaskIDs)
	require.Equal(t, []string{"owned-root"}, tasks.previewed)

	result, err := service.Reset(context.Background(), "workspace-1", "watch-1")
	require.NoError(t, err)
	require.Equal(t, []string{"owned-root", "owned-child"}, result.DeletedTaskIDs)
	require.Equal(t, []string{"owned-root"}, tasks.deleted)

	watch := repository.snapshots["workspace-1"].Watches["watch-1"]
	_, ownedLinkRemains := watch.Links["repo-1#owned"]
	require.False(t, ownedLinkRemains)
	require.Equal(t, "manual-task", watch.Links["repo-1#manual"].TaskID)
	require.NotContains(t, watch.Reservations, "repo-1#owned")
	require.Contains(t, watch.Reservations, "repo-1#manual")
}

func TestDetachTaskLinkKeepsReservationButPreventsReattachment(t *testing.T) {
	repository := &memoryRepository{snapshots: map[string]Snapshot{
		"workspace-1": {Watches: map[string]Watch{
			"watch-1": {
				ID: "watch-1", WorkspaceID: "workspace-1", Status: StatusRunning,
				Links: map[string]TaskLink{
					"repo-1#42": {PullRequestKey: "repo-1#42", TaskID: "task-1", Owned: true},
				},
				Reservations: map[string]Reservation{
					"repo-1#42": {Token: "reservation", State: ReservationCreated, TaskID: "task-1"},
				},
			},
		}},
	}}
	tasks := &recordingTasks{}
	service, err := NewService(Options{
		Repository: repository,
		Provider: staticProvider{items: []PullRequest{{
			Key: "repo-1#42", RepositoryID: "repo-1", Number: 42,
		}}},
		Tasks: tasks,
	})
	require.NoError(t, err)

	require.NoError(t, service.DetachTaskLink(
		context.Background(), "workspace-1", "task-1", "repo-1#42",
	))
	watch := repository.snapshots["workspace-1"].Watches["watch-1"]
	require.False(t, watch.Links["repo-1#42"].Owned)
	require.Contains(t, watch.Reservations, "repo-1#42")

	result, err := service.Run(context.Background(), "workspace-1", "watch-1")
	require.NoError(t, err)
	require.Equal(t, 1, result.Skipped)
	require.Zero(t, tasks.createCalls)
	require.False(t, repository.snapshots["workspace-1"].Watches["watch-1"].Links["repo-1#42"].Owned)
}

func TestWatchControls_PersistFiltersPresetsStatusAndSafeDelete(t *testing.T) {
	repository := &memoryRepository{snapshots: map[string]Snapshot{"workspace-1": {}}}
	provider := &countingProvider{}
	tasks := &recordingTasks{previewTree: []string{"owned-root"}, deletedTree: []string{"owned-root"}}
	events := &recordingEvents{}
	service, err := NewService(Options{Repository: repository, Provider: provider, Tasks: tasks, Events: events})
	require.NoError(t, err)

	created, err := service.Create(context.Background(), Watch{ID: "watch-1", WorkspaceID: "workspace-1"})
	require.NoError(t, err)
	require.Equal(t, StatusRunning, created.Status)
	updated, err := service.SetFilter(context.Background(), "workspace-1", "watch-1", Filter{RepositoryIDs: []string{"repo-1"}, States: []string{"open"}})
	require.NoError(t, err)
	require.Equal(t, []string{"repo-1"}, updated.Filter.RepositoryIDs)
	updated, err = service.SavePreset(context.Background(), "workspace-1", "watch-1", Preset{ID: "open", Name: "Open PRs", Filter: updated.Filter})
	require.NoError(t, err)
	require.Equal(t, "Open PRs", updated.Presets["open"].Name)

	_, err = service.Pause(context.Background(), "workspace-1", "watch-1")
	require.NoError(t, err)
	_, err = service.Run(context.Background(), "workspace-1", "watch-1")
	require.ErrorIs(t, err, ErrWatchPaused)
	require.Zero(t, provider.calls)
	_, err = service.Resume(context.Background(), "workspace-1", "watch-1")
	require.NoError(t, err)

	watch := repository.snapshots["workspace-1"].Watches["watch-1"]
	watch.Links["owned"] = TaskLink{PullRequestKey: "owned", TaskID: "owned-root", Owned: true}
	watch.Links["manual"] = TaskLink{PullRequestKey: "manual", TaskID: "manual-task", Owned: false}
	repository.snapshots["workspace-1"] = Snapshot{Watches: map[string]Watch{"watch-1": watch}}

	preview, err := service.PreviewDelete(context.Background(), "workspace-1", "watch-1")
	require.NoError(t, err)
	require.Equal(t, []string{"owned-root"}, preview.TaskIDs)
	result, err := service.Delete(context.Background(), "workspace-1", "watch-1")
	require.NoError(t, err)
	require.Equal(t, []string{"owned-root"}, result.DeletedTaskIDs)
	require.Equal(t, []string{"owned-root"}, tasks.deleted)
	_, err = service.Get(context.Background(), "workspace-1", "watch-1")
	require.ErrorIs(t, err, ErrWatchNotFound)
	require.NotContains(t, events.names, "plugin.kandev-plugin-bitbucket.watch.deleted")
	require.Contains(t, events.names, "watch.deleted")
}

func TestRefreshTaskLinkUpdatesMutableDisplayKeyWithoutChangingIdentity(t *testing.T) {
	link := TaskLink{
		PullRequestKey: "old/repo#42", PullRequestURL: "https://bitbucket.org/old/repo/pull-requests/42",
		TaskID: "task-1", Owned: true, ProviderID: "bitbucket", ProviderScope: "https://bitbucket.org",
		RepositoryID: "repo-uuid", PullRequestNumber: 42,
	}
	storageKey := link.storageKey()
	repository := &memoryRepository{snapshots: map[string]Snapshot{"workspace-1": {Watches: map[string]Watch{
		"watch-1": {ID: "watch-1", WorkspaceID: "workspace-1", Links: map[string]TaskLink{storageKey: link}},
	}}}}
	service, err := NewService(Options{Repository: repository, Provider: staticProvider{}, Tasks: &recordingTasks{}})
	require.NoError(t, err)

	require.NoError(t, service.RefreshTaskLink(
		context.Background(), "workspace-1", "task-1", storageKey,
		"new/repo#42", "https://bitbucket.org/new/repo/pull-requests/42",
	))
	updated := repository.snapshots["workspace-1"].Watches["watch-1"].Links[storageKey]
	require.Equal(t, "new/repo#42", updated.PullRequestKey)
	require.Equal(t, "https://bitbucket.org/new/repo/pull-requests/42", updated.PullRequestURL)
	require.Equal(t, storageKey, updated.storageKey())
}

func TestReset_RespectsCancelledActionContext(t *testing.T) {
	repository := &memoryRepository{snapshots: map[string]Snapshot{"workspace-1": {Watches: map[string]Watch{
		"watch-1": {ID: "watch-1", WorkspaceID: "workspace-1", Links: map[string]TaskLink{"owned": {PullRequestKey: "owned", TaskID: "owned-root", Owned: true}}},
	}}}}
	tasks := &recordingTasks{deletedTree: []string{"owned-root"}}
	service, err := NewService(Options{Repository: repository, Provider: staticProvider{}, Tasks: tasks})
	require.NoError(t, err)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = service.Reset(ctx, "workspace-1", "watch-1")
	require.ErrorIs(t, err, context.Canceled)
	require.Empty(t, tasks.deleted)
}

func TestReset_ReturnsPartialDeletionProgressAndKeepsLinkRetryable(t *testing.T) {
	repository := &memoryRepository{snapshots: map[string]Snapshot{"workspace-1": {Watches: map[string]Watch{
		"watch-1": {ID: "watch-1", WorkspaceID: "workspace-1", Links: map[string]TaskLink{
			"owned": {PullRequestKey: "owned", TaskID: "owned-root", Owned: true},
		}},
	}}}}
	tasks := &recordingTasks{
		deletedTree: []string{"owned-grandchild"},
		deleteErr:   errors.New("partial task-tree deletion"),
	}
	service, err := NewService(Options{Repository: repository, Provider: staticProvider{}, Tasks: tasks})
	require.NoError(t, err)

	result, err := service.Reset(context.Background(), "workspace-1", "watch-1")

	require.ErrorContains(t, err, "partial task-tree deletion")
	require.Equal(t, []string{"owned-grandchild"}, result.DeletedTaskIDs)
	require.Contains(t, repository.snapshots["workspace-1"].Watches["watch-1"].Links, "owned")
}

func TestReset_PersistsEachCompletedRootBeforeDeletingTheNext(t *testing.T) {
	repository := &memoryRepository{snapshots: map[string]Snapshot{"workspace-1": {Watches: map[string]Watch{
		"watch-1": {ID: "watch-1", WorkspaceID: "workspace-1", Links: map[string]TaskLink{
			"repo#1": {PullRequestKey: "repo#1", TaskID: "root-1", Owned: true},
			"repo#2": {PullRequestKey: "repo#2", TaskID: "root-2", Owned: true},
		}},
	}}}}
	tasks := &recordingTasks{deleteByTask: map[string]taskDeleteResult{
		"root-1": {deleted: []string{"root-1"}},
		"root-2": {err: errors.New("second root unavailable")},
	}}
	service, err := NewService(Options{Repository: repository, Provider: staticProvider{}, Tasks: tasks})
	require.NoError(t, err)

	result, err := service.Reset(context.Background(), "workspace-1", "watch-1")

	require.ErrorContains(t, err, "second root unavailable")
	require.Equal(t, []string{"root-1"}, result.DeletedTaskIDs)
	watch := repository.snapshots["workspace-1"].Watches["watch-1"]
	require.NotContains(t, watch.Links, "repo#1")
	require.Contains(t, watch.Links, "repo#2")
	require.Equal(t, 1, repository.saveCalls, "completed root progress must be durable before the next delete")

	tasks.deleteByTask["root-2"] = taskDeleteResult{deleted: []string{"root-2"}}
	result, err = service.Reset(context.Background(), "workspace-1", "watch-1")
	require.NoError(t, err)
	require.Equal(t, []string{"root-2"}, result.DeletedTaskIDs)
	require.Equal(t, []string{"root-1", "root-2", "root-2"}, tasks.deleted)
}

type memoryRepository struct {
	snapshots map[string]Snapshot
	saveCalls int
}

func (r *memoryRepository) Load(_ context.Context, workspaceID string) (Snapshot, error) {
	return r.snapshots[workspaceID], nil
}

func (r *memoryRepository) Save(_ context.Context, workspaceID string, snapshot Snapshot) error {
	r.saveCalls++
	r.snapshots[workspaceID] = snapshot
	return nil
}

type staticProvider struct {
	items      []PullRequest
	nextCursor string
}

type mutableProvider struct {
	items []PullRequest
}

func (p *mutableProvider) ListPullRequests(context.Context, Watch) ([]PullRequest, string, error) {
	return p.items, "", nil
}

type bindingProvider struct {
	binding string
	items   []PullRequest
	calls   int
}

func (p *bindingProvider) ConnectionBinding(context.Context, string) (string, error) {
	return p.binding, nil
}

func (p *bindingProvider) ListPullRequests(context.Context, Watch) ([]PullRequest, string, error) {
	p.calls++
	return p.items, "", nil
}

func completePullRequest(repositoryID string) PullRequest {
	return PullRequest{
		Key: "workspace/repo#42", RepositoryID: repositoryID, Number: 42,
		Repository: RemoteRepository{
			ProviderID: "bitbucket", ProviderHost: "https://bitbucket.org", ProviderScope: "https://bitbucket.org",
			OwnerOrProject: "workspace", ProviderRepositoryID: repositoryID, Name: "repo", CloneURL: "https://bitbucket.org/workspace/repo.git",
		},
	}
}

type cursorPage struct {
	items []PullRequest
	next  string
}

type cursorProvider struct {
	pages   map[string]cursorPage
	cursors []string
}

func (p *cursorProvider) ListPullRequests(_ context.Context, watch Watch) ([]PullRequest, string, error) {
	p.cursors = append(p.cursors, watch.Cursor)
	page, found := p.pages[watch.Cursor]
	if !found {
		return nil, "", fmt.Errorf("unexpected cursor %q", watch.Cursor)
	}
	return page.items, page.next, nil
}

func (p staticProvider) ListPullRequests(context.Context, Watch) ([]PullRequest, string, error) {
	return p.items, p.nextCursor, nil
}

type recordingTasks struct {
	beforeCreate            func() bool
	createCalls             int
	reservationWasPersisted bool
	findTaskID              string
	previewTree             []string
	deletedTree             []string
	previewed               []string
	deleted                 []string
	createErr               error
	deleteErr               error
	deleteByTask            map[string]taskDeleteResult
}

type taskDeleteResult struct {
	deleted []string
	err     error
}

func (t *recordingTasks) FindByReservation(context.Context, string, string) (string, bool, error) {
	return t.findTaskID, t.findTaskID != "", nil
}

func (t *recordingTasks) Create(_ context.Context, _ Creation) (string, error) {
	t.createCalls++
	if t.beforeCreate != nil {
		t.reservationWasPersisted = t.beforeCreate()
	}
	if t.createErr != nil {
		return "", t.createErr
	}
	return "task-1", nil
}

func (t *recordingTasks) PreviewOwned(_ context.Context, taskID string) ([]string, error) {
	t.previewed = append(t.previewed, taskID)
	return t.previewTree, nil
}

func (t *recordingTasks) DeleteOwned(_ context.Context, taskID string) ([]string, error) {
	t.deleted = append(t.deleted, taskID)
	if result, found := t.deleteByTask[taskID]; found {
		return result.deleted, result.err
	}
	return t.deletedTree, t.deleteErr
}

type blockingProvider struct {
	started chan struct{}
	release chan struct{}
	item    PullRequest
	once    sync.Once
}

func (p *blockingProvider) ListPullRequests(context.Context, Watch) ([]PullRequest, string, error) {
	p.once.Do(func() {
		close(p.started)
	})
	<-p.release
	return []PullRequest{p.item}, "", nil
}

type countingProvider struct{ calls int }

func (p *countingProvider) ListPullRequests(context.Context, Watch) ([]PullRequest, string, error) {
	p.calls++
	return nil, "", nil
}

type recordingEvents struct{ names []string }

func (e *recordingEvents) Emit(_ context.Context, name string, _ map[string]any) error {
	e.names = append(e.names, name)
	return nil
}

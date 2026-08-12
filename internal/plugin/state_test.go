package plugin

import (
	"context"
	"sync"
	"testing"
	"time"

	"kandev-plugin-bitbucket/internal/domain"
	"kandev-plugin-bitbucket/internal/watches"

	"github.com/stretchr/testify/require"
)

func TestWatchStateRepository_RoundTripsDurableCreatingReservation(t *testing.T) {
	host := &stateRecordingHost{values: make(map[string]map[string]any)}
	repository, err := NewWatchStateRepository(host)
	require.NoError(t, err)
	want := watches.Snapshot{Watches: map[string]watches.Watch{
		"watch-1": {
			ID: "watch-1", WorkspaceID: "workspace-1", Status: watches.StatusRunning,
			Reservations: map[string]watches.Reservation{
				"repo-1#42": {Token: "res-1", State: watches.ReservationCreating, CreatedAt: time.Date(2026, 7, 31, 12, 0, 0, 0, time.UTC)},
			},
		},
	}}
	require.NoError(t, repository.Save(context.Background(), "workspace-1", want))

	got, err := repository.Load(context.Background(), "workspace-1")
	require.NoError(t, err)
	require.Equal(t, want, got)
}

func TestLinkStore_UnlinkNeverDeletesLinkedTask(t *testing.T) {
	host := &stateRecordingHost{values: make(map[string]map[string]any)}
	links, err := NewLinkStore(host)
	require.NoError(t, err)
	linked, err := links.Link(context.Background(), "manual-task", PullRequestLink{Key: "ws/repo#42", RepositoryID: "ws/repo", URL: "https://bitbucket.org/ws/repo/pull-requests/42", Number: 42})
	require.NoError(t, err)
	require.Len(t, linked, 1)

	remaining, err := links.Unlink(
		context.Background(), "manual-task", "https://bitbucket.org", "ws/repo", 42,
	)
	require.NoError(t, err)
	require.Empty(t, remaining)
	require.Empty(t, host.deletedScopes, "unlink must not invoke task deletion")
}

func TestLinkStore_ExplicitUnlinkSuppressesAutoLinkUntilManualRelink(t *testing.T) {
	host := &stateRecordingHost{values: make(map[string]map[string]any)}
	links, err := NewLinkStore(host)
	require.NoError(t, err)
	link := PullRequestLink{
		Key: "ws/repo#42", RepositoryID: "ws/repo",
		URL: "https://bitbucket.org/ws/repo/pull-requests/42", Number: 42,
	}
	_, err = links.AutoLink(context.Background(), "task-1", link)
	require.NoError(t, err)
	_, err = links.Unlink(
		context.Background(), "task-1", "https://bitbucket.org", link.RepositoryID, link.Number,
	)
	require.NoError(t, err)
	automatic, err := links.AutoLink(context.Background(), "task-1", link)
	require.NoError(t, err)
	require.Empty(t, automatic)

	manual, err := links.Link(context.Background(), "task-1", link)
	require.NoError(t, err)
	require.Len(t, manual, 1)
}

func TestLinkStore_DoesNotConflateRecreatedRepositoryAtSamePath(t *testing.T) {
	host := &stateRecordingHost{values: make(map[string]map[string]any)}
	links, err := NewLinkStore(host)
	require.NoError(t, err)
	oldRepository := PullRequestLink{
		Key: "ws/repo#42", RepositoryID: "repo-uuid-old",
		URL: "https://bitbucket.org/ws/repo/pull-requests/42", Number: 42,
		Product: domain.ProductCloud, ConnectionScope: "https://bitbucket.org",
	}
	newRepository := oldRepository
	newRepository.RepositoryID = "repo-uuid-new"

	_, err = links.Link(context.Background(), "task-1", oldRepository)
	require.NoError(t, err)
	linked, err := links.Link(context.Background(), "task-1", newRepository)
	require.NoError(t, err)
	require.Len(t, linked, 2, "a mutable repository path must not be the persisted identity")

	remaining, err := links.Unlink(
		context.Background(), "task-1", oldRepository.ConnectionScope,
		oldRepository.RepositoryID, oldRepository.Number,
	)
	require.NoError(t, err)
	require.Len(t, remaining, 1,
		"unlink must remove only the selected immutable repository identity")
	require.Equal(t, newRepository.RepositoryID, remaining[0].RepositoryID)
	freshRepository := newRepository
	freshRepository.RepositoryID = "repo-uuid-fresh"
	automatic, err := links.AutoLink(context.Background(), "task-1", freshRepository)
	require.NoError(t, err)
	require.Len(t, automatic, 2, "unlink suppression must be scoped to immutable identities")
	require.ElementsMatch(t,
		[]string{newRepository.RepositoryID, freshRepository.RepositoryID},
		[]string{automatic[0].RepositoryID, automatic[1].RepositoryID},
	)
}

func TestLinkStore_LegacyPathSuppressionDoesNotSuppressImmutableRepository(t *testing.T) {
	host := &stateRecordingHost{values: make(map[string]map[string]any)}
	legacy, err := encodeState(linkState{LegacySuppressedKeys: []string{"ws/repo#42"}})
	require.NoError(t, err)
	require.NoError(t, host.SetState(context.Background(), "task", "task-1", taskLinkStateKey, legacy))
	links, err := NewLinkStore(host)
	require.NoError(t, err)

	linked, err := links.AutoLink(context.Background(), "task-1", PullRequestLink{
		Key: "ws/repo#42", RepositoryID: "repo-uuid-new",
		URL: "https://bitbucket.org/ws/repo/pull-requests/42", Number: 42,
		Product: domain.ProductCloud, ConnectionScope: "https://bitbucket.org",
	})
	require.NoError(t, err)
	require.Len(t, linked, 1, "legacy mutable-path suppression must not apply to immutable identities")
}

func TestLinkStore_ConcurrentLinksDoNotLoseUpdates(t *testing.T) {
	host := &stateRecordingHost{values: make(map[string]map[string]any)}
	links, err := NewLinkStore(host)
	require.NoError(t, err)
	start := make(chan struct{})
	var group sync.WaitGroup
	for _, link := range []PullRequestLink{
		{Key: "repo#1", RepositoryID: "repo", URL: "https://bitbucket.org/ws/repo/pull-requests/1", Number: 1},
		{Key: "repo#2", RepositoryID: "repo", URL: "https://bitbucket.org/ws/repo/pull-requests/2", Number: 2},
	} {
		group.Add(1)
		go func(link PullRequestLink) {
			defer group.Done()
			<-start
			_, _ = links.Link(context.Background(), "manual-task", link)
		}(link)
	}
	close(start)
	group.Wait()
	stored, err := links.List(context.Background(), "manual-task")
	require.NoError(t, err)
	require.Len(t, stored, 2)
}

func TestLinkStore_MigratesLegacyLinkIdentityFromCanonicalURL(t *testing.T) {
	host := &stateRecordingHost{values: make(map[string]map[string]any)}
	legacy, err := encodeState(linkState{Links: []PullRequestLink{{
		Key: "ENG/repo#42", RepositoryID: "ENG/repo", URL: "https://bitbucket.example.test/projects/ENG/repos/repo/pull-requests/42", Number: 42,
	}}})
	require.NoError(t, err)
	host.values["task:task-1:"+taskLinkStateKey] = legacy
	links, err := NewLinkStore(host)
	require.NoError(t, err)

	got, err := links.List(context.Background(), "task-1")
	require.NoError(t, err)
	require.Equal(t, domain.ProductDataCenter, got[0].Product)
	require.Equal(t, "bitbucket.example.test", got[0].Host)

	var persisted linkState
	require.NoError(t, decodeState(host.values["task:task-1:"+taskLinkStateKey], &persisted))
	require.Equal(t, got, persisted.Links, "legacy identity migration must be durable")
}

type stateRecordingHost struct {
	values        map[string]map[string]any
	deletedScopes []string
}

func (h *stateRecordingHost) GetState(_ context.Context, scope, scopeID, key string) (map[string]any, bool, error) {
	value, found := h.values[scope+":"+scopeID+":"+key]
	return value, found, nil
}

func (h *stateRecordingHost) SetState(_ context.Context, scope, scopeID, key string, value map[string]any) error {
	h.values[scope+":"+scopeID+":"+key] = value
	return nil
}

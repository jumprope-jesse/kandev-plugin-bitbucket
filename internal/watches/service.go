package watches

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sort"
	"sync"
	"time"
)

// Service coordinates durable watch state. Behavior is added incrementally
// behind focused failure-injection tests.
type Service struct {
	repository Repository
	provider   Provider
	tasks      TaskCreator
	events     EventSink
	now        func() time.Time
	token      func() (string, error)
	locks      keyedMutex
}

func NewService(options Options) (*Service, error) {
	if options.Repository == nil {
		return nil, fmt.Errorf("watch repository is required")
	}
	if options.Provider == nil {
		return nil, fmt.Errorf("watch provider is required")
	}
	if options.Tasks == nil {
		return nil, fmt.Errorf("watch task creator is required")
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	if options.Token == nil {
		options.Token = reservationToken
	}
	return &Service{
		repository: options.Repository,
		provider:   options.Provider,
		tasks:      options.Tasks,
		events:     options.Events,
		now:        options.Now,
		token:      options.Token,
	}, nil
}

// Run polls one enabled watch. The workspace-keyed mutex protects its single
// durable snapshot, including all reservation/checkpoint writes.
func (s *Service) Run(ctx context.Context, workspaceID, watchID string) (RunResult, error) {
	unlock := s.locks.lock(workspaceID)
	defer unlock()

	snapshot, watch, err := s.loadWatch(ctx, workspaceID, watchID)
	if err != nil {
		return RunResult{}, err
	}
	if watch.Status == StatusPaused {
		return RunResult{}, ErrWatchPaused
	}

	items, cursor, err := s.provider.ListPullRequests(ctx, watch)
	if err != nil {
		watch.Failures++
		snapshot.Watches[watch.ID] = watch
		if saveErr := s.repository.Save(ctx, workspaceID, snapshot); saveErr != nil {
			return RunResult{}, fmt.Errorf("save failed watch poll: %w", saveErr)
		}
		s.emit(ctx, "watch.poll_failed", map[string]any{"workspace_id": workspaceID, "watch_id": watchID})
		return RunResult{}, fmt.Errorf("list watched pull requests: %w", err)
	}

	result := RunResult{}
	for _, item := range items {
		created, skipped, nextSnapshot, nextWatch, err := s.ensureTask(ctx, workspaceID, snapshot, watch, item)
		if err != nil {
			return result, err
		}
		snapshot, watch = nextSnapshot, nextWatch
		if created {
			result.Created++
		}
		if skipped {
			result.Skipped++
		}
	}
	watch.Cursor = cursor
	watch.LastPolled = s.now().UTC()
	watch.Failures = 0
	snapshot.Watches[watch.ID] = watch
	if err := s.repository.Save(ctx, workspaceID, snapshot); err != nil {
		return result, fmt.Errorf("save completed watch poll: %w", err)
	}
	return result, nil
}

func (s *Service) Create(ctx context.Context, watch Watch) (Watch, error) {
	if watch.ID == "" || watch.WorkspaceID == "" {
		return Watch{}, fmt.Errorf("watch and workspace ids are required")
	}
	unlock := s.locks.lock(watch.WorkspaceID)
	defer unlock()
	snapshot, err := s.repository.Load(ctx, watch.WorkspaceID)
	if err != nil {
		return Watch{}, fmt.Errorf("load watch snapshot: %w", err)
	}
	if snapshot.Watches == nil {
		snapshot.Watches = make(map[string]Watch)
	}
	if _, exists := snapshot.Watches[watch.ID]; exists {
		return Watch{}, fmt.Errorf("watch %q already exists", watch.ID)
	}
	normalizeWatch(&watch)
	snapshot.Watches[watch.ID] = watch
	if err := s.repository.Save(ctx, watch.WorkspaceID, snapshot); err != nil {
		return Watch{}, fmt.Errorf("save created watch: %w", err)
	}
	s.emit(ctx, "watch.created", map[string]any{"workspace_id": watch.WorkspaceID, "watch_id": watch.ID})
	return watch, nil
}

func (s *Service) Get(ctx context.Context, workspaceID, watchID string) (Watch, error) {
	unlock := s.locks.lock(workspaceID)
	defer unlock()
	_, watch, err := s.loadWatch(ctx, workspaceID, watchID)
	return watch, err
}

func (s *Service) List(ctx context.Context, workspaceID string) ([]Watch, error) {
	if workspaceID == "" {
		return nil, fmt.Errorf("workspace id is required")
	}
	unlock := s.locks.lock(workspaceID)
	defer unlock()
	snapshot, err := s.repository.Load(ctx, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("load watch snapshot: %w", err)
	}
	ids := make([]string, 0, len(snapshot.Watches))
	for id := range snapshot.Watches {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	watches := make([]Watch, 0, len(ids))
	for _, id := range ids {
		watch := snapshot.Watches[id]
		normalizeWatch(&watch)
		watches = append(watches, watch)
	}
	return watches, nil
}

// Recover finalizes durable reservations left in creating state when the
// process stopped after the host created a task but before state was saved.
// It never creates or deletes tasks; a later Run safely retries reservations
// that the host cannot find.
func (s *Service) Recover(ctx context.Context, workspaceID string) (int, error) {
	if workspaceID == "" {
		return 0, fmt.Errorf("workspace id is required")
	}
	unlock := s.locks.lock(workspaceID)
	defer unlock()

	snapshot, err := s.repository.Load(ctx, workspaceID)
	if err != nil {
		return 0, fmt.Errorf("load watch snapshot: %w", err)
	}
	ids := make([]string, 0, len(snapshot.Watches))
	for id := range snapshot.Watches {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	recovered := 0
	for _, id := range ids {
		watch := snapshot.Watches[id]
		normalizeWatch(&watch)
		keys := make([]string, 0, len(watch.Reservations))
		for key, reservation := range watch.Reservations {
			if reservation.State == ReservationCreating && reservation.Token != "" {
				keys = append(keys, key)
			}
		}
		sort.Strings(keys)
		for _, key := range keys {
			reservation := watch.Reservations[key]
			taskID := reservation.TaskID
			if taskID == "" {
				var found bool
				taskID, found, err = s.tasks.FindByReservation(ctx, workspaceID, reservation.Token)
				if err != nil {
					return recovered, fmt.Errorf("find creating reservation: %w", err)
				}
				if !found {
					continue
				}
			}
			reservation.TaskID = taskID
			reservation.State = ReservationCreated
			watch.Reservations[key] = reservation
			watch.Links[key] = TaskLink{PullRequestKey: key, TaskID: taskID, Owned: true}
			recovered++
		}
		snapshot.Watches[id] = watch
	}
	if recovered == 0 {
		return 0, nil
	}
	if err := s.repository.Save(ctx, workspaceID, snapshot); err != nil {
		return 0, fmt.Errorf("save recovered reservations: %w", err)
	}
	s.emit(ctx, "watch.recovered", map[string]any{"workspace_id": workspaceID, "task_count": recovered})
	return recovered, nil
}

func (s *Service) Pause(ctx context.Context, workspaceID, watchID string) (Watch, error) {
	return s.setStatus(ctx, workspaceID, watchID, StatusPaused)
}

func (s *Service) Resume(ctx context.Context, workspaceID, watchID string) (Watch, error) {
	return s.setStatus(ctx, workspaceID, watchID, StatusRunning)
}

func (s *Service) setStatus(ctx context.Context, workspaceID, watchID string, status Status) (Watch, error) {
	unlock := s.locks.lock(workspaceID)
	defer unlock()
	snapshot, watch, err := s.loadWatch(ctx, workspaceID, watchID)
	if err != nil {
		return Watch{}, err
	}
	watch.Status = status
	snapshot.Watches[watch.ID] = watch
	if err := s.repository.Save(ctx, workspaceID, snapshot); err != nil {
		return Watch{}, fmt.Errorf("save watch status: %w", err)
	}
	s.emit(ctx, "watch."+string(status), map[string]any{"workspace_id": workspaceID, "watch_id": watchID})
	return watch, nil
}

func (s *Service) SetFilter(ctx context.Context, workspaceID, watchID string, filter Filter) (Watch, error) {
	unlock := s.locks.lock(workspaceID)
	defer unlock()
	snapshot, watch, err := s.loadWatch(ctx, workspaceID, watchID)
	if err != nil {
		return Watch{}, err
	}
	watch.Filter = filter
	watch.Cursor = ""
	snapshot.Watches[watch.ID] = watch
	if err := s.repository.Save(ctx, workspaceID, snapshot); err != nil {
		return Watch{}, fmt.Errorf("save watch filter: %w", err)
	}
	s.emit(ctx, "watch.updated", map[string]any{"workspace_id": workspaceID, "watch_id": watchID})
	return watch, nil
}

func (s *Service) SavePreset(ctx context.Context, workspaceID, watchID string, preset Preset) (Watch, error) {
	if preset.ID == "" || preset.Name == "" {
		return Watch{}, fmt.Errorf("preset id and name are required")
	}
	unlock := s.locks.lock(workspaceID)
	defer unlock()
	snapshot, watch, err := s.loadWatch(ctx, workspaceID, watchID)
	if err != nil {
		return Watch{}, err
	}
	watch.Presets[preset.ID] = preset
	snapshot.Watches[watch.ID] = watch
	if err := s.repository.Save(ctx, workspaceID, snapshot); err != nil {
		return Watch{}, fmt.Errorf("save watch preset: %w", err)
	}
	s.emit(ctx, "watch.updated", map[string]any{"workspace_id": workspaceID, "watch_id": watchID})
	return watch, nil
}

func (s *Service) ensureTask(ctx context.Context, workspaceID string, snapshot Snapshot, watch Watch, item PullRequest) (created, skipped bool, next Snapshot, updated Watch, err error) {
	if item.Key == "" {
		return false, false, snapshot, watch, fmt.Errorf("watched pull request key is required")
	}
	if _, exists := watch.Links[item.Key]; exists {
		return false, true, snapshot, watch, nil
	}
	if reservation, exists := watch.Reservations[item.Key]; exists {
		if reservation.TaskID != "" {
			watch.Links[item.Key] = TaskLink{PullRequestKey: item.Key, TaskID: reservation.TaskID, Owned: true}
			reservation.State = ReservationCreated
			watch.Reservations[item.Key] = reservation
			snapshot.Watches[watch.ID] = watch
			if saveErr := s.repository.Save(ctx, workspaceID, snapshot); saveErr != nil {
				return false, false, snapshot, watch, fmt.Errorf("save recovered task link: %w", saveErr)
			}
			return false, true, snapshot, watch, nil
		}
		foundTaskID, found, findErr := s.tasks.FindByReservation(ctx, workspaceID, reservation.Token)
		if findErr != nil {
			return false, false, snapshot, watch, fmt.Errorf("find creating reservation: %w", findErr)
		}
		if found {
			watch.Links[item.Key] = TaskLink{PullRequestKey: item.Key, TaskID: foundTaskID, Owned: true}
			reservation.State = ReservationCreated
			reservation.TaskID = foundTaskID
			watch.Reservations[item.Key] = reservation
			snapshot.Watches[watch.ID] = watch
			if saveErr := s.repository.Save(ctx, workspaceID, snapshot); saveErr != nil {
				return false, false, snapshot, watch, fmt.Errorf("save recovered reservation: %w", saveErr)
			}
			return false, true, snapshot, watch, nil
		}
	}

	reservation, exists := watch.Reservations[item.Key]
	if !exists {
		token, tokenErr := s.token()
		if tokenErr != nil {
			return false, false, snapshot, watch, fmt.Errorf("create reservation token: %w", tokenErr)
		}
		reservation = Reservation{Token: token, State: ReservationCreating, CreatedAt: s.now().UTC()}
		watch.Reservations[item.Key] = reservation
		snapshot.Watches[watch.ID] = watch
		if saveErr := s.repository.Save(ctx, workspaceID, snapshot); saveErr != nil {
			return false, false, snapshot, watch, fmt.Errorf("persist creating reservation: %w", saveErr)
		}
	}

	taskID, createErr := s.tasks.Create(ctx, Creation{
		WorkspaceID: workspaceID, Watch: watch, PullRequest: item, ReservationToken: reservation.Token,
	})
	if createErr != nil {
		return false, false, snapshot, watch, fmt.Errorf("create watched task: %w", createErr)
	}
	if taskID == "" {
		return false, false, snapshot, watch, fmt.Errorf("create watched task returned an empty task id")
	}
	reservation.State = ReservationCreated
	reservation.TaskID = taskID
	watch.Reservations[item.Key] = reservation
	watch.Links[item.Key] = TaskLink{PullRequestKey: item.Key, TaskID: taskID, Owned: true}
	snapshot.Watches[watch.ID] = watch
	if saveErr := s.repository.Save(ctx, workspaceID, snapshot); saveErr != nil {
		return false, false, snapshot, watch, fmt.Errorf("persist created task link: %w", saveErr)
	}
	s.emit(ctx, "watch.task_created", map[string]any{"workspace_id": workspaceID, "watch_id": watch.ID, "task_id": taskID, "pull_request_key": item.Key})
	return true, false, snapshot, watch, nil
}

func (s *Service) loadWatch(ctx context.Context, workspaceID, watchID string) (Snapshot, Watch, error) {
	if workspaceID == "" || watchID == "" {
		return Snapshot{}, Watch{}, fmt.Errorf("workspace and watch ids are required")
	}
	snapshot, err := s.repository.Load(ctx, workspaceID)
	if err != nil {
		return Snapshot{}, Watch{}, fmt.Errorf("load watch snapshot: %w", err)
	}
	watch, found := snapshot.Watches[watchID]
	if !found {
		return Snapshot{}, Watch{}, ErrWatchNotFound
	}
	normalizeWatch(&watch)
	return snapshot, watch, nil
}

func normalizeWatch(watch *Watch) {
	if watch.Status == "" {
		watch.Status = StatusRunning
	}
	if watch.Presets == nil {
		watch.Presets = make(map[string]Preset)
	}
	if watch.Links == nil {
		watch.Links = make(map[string]TaskLink)
	}
	if watch.Reservations == nil {
		watch.Reservations = make(map[string]Reservation)
	}
}

func (s *Service) emit(ctx context.Context, name string, payload map[string]any) {
	if s.events != nil {
		_ = s.events.Emit(ctx, name, payload)
	}
}

func (s *Service) PreviewReset(ctx context.Context, workspaceID, watchID string) (ResetPreview, error) {
	unlock := s.locks.lock(workspaceID)
	defer unlock()

	_, watch, err := s.loadWatch(ctx, workspaceID, watchID)
	if err != nil {
		return ResetPreview{}, err
	}
	var taskIDs []string
	for _, link := range ownedLinks(watch) {
		preview, previewErr := s.tasks.PreviewOwned(ctx, link.TaskID)
		if previewErr != nil {
			return ResetPreview{}, fmt.Errorf("preview owned task tree %q: %w", link.TaskID, previewErr)
		}
		taskIDs = appendUnique(taskIDs, preview...)
	}
	return ResetPreview{TaskIDs: taskIDs}, nil
}

// Reset removes only trees created by this watch. Manual/adopted links stay
// intact in persistent state and are never passed to the host deleter.
func (s *Service) Reset(ctx context.Context, workspaceID, watchID string) (ResetResult, error) {
	if err := ctx.Err(); err != nil {
		return ResetResult{}, err
	}
	unlock := s.locks.lock(workspaceID)
	defer unlock()

	snapshot, watch, err := s.loadWatch(ctx, workspaceID, watchID)
	if err != nil {
		return ResetResult{}, err
	}
	var deletedTaskIDs []string
	for _, link := range ownedLinks(watch) {
		deleted, deleteErr := s.tasks.DeleteOwned(ctx, link.TaskID)
		if deleteErr != nil {
			return ResetResult{DeletedTaskIDs: deletedTaskIDs}, fmt.Errorf("delete owned task tree %q: %w", link.TaskID, deleteErr)
		}
		deletedTaskIDs = appendUnique(deletedTaskIDs, deleted...)
		delete(watch.Links, link.PullRequestKey)
		delete(watch.Reservations, link.PullRequestKey)
	}
	watch.Cursor = ""
	watch.LastPolled = time.Time{}
	watch.Failures = 0
	snapshot.Watches[watch.ID] = watch
	if err := s.repository.Save(ctx, workspaceID, snapshot); err != nil {
		return ResetResult{DeletedTaskIDs: deletedTaskIDs}, fmt.Errorf("save reset watch: %w", err)
	}
	s.emit(ctx, "watch.reset", map[string]any{"workspace_id": workspaceID, "watch_id": watchID, "task_count": len(deletedTaskIDs)})
	return ResetResult{DeletedTaskIDs: deletedTaskIDs}, nil
}

func (s *Service) PreviewDelete(ctx context.Context, workspaceID, watchID string) (ResetPreview, error) {
	return s.PreviewReset(ctx, workspaceID, watchID)
}

// Delete removes a watch definition after deleting only trees the watch
// created. Linked/adopted tasks are external to the watch definition and
// survive even though the definition no longer exists.
func (s *Service) Delete(ctx context.Context, workspaceID, watchID string) (ResetResult, error) {
	if err := ctx.Err(); err != nil {
		return ResetResult{}, err
	}
	unlock := s.locks.lock(workspaceID)
	defer unlock()

	snapshot, watch, err := s.loadWatch(ctx, workspaceID, watchID)
	if err != nil {
		return ResetResult{}, err
	}
	var deletedTaskIDs []string
	for _, link := range ownedLinks(watch) {
		deleted, deleteErr := s.tasks.DeleteOwned(ctx, link.TaskID)
		if deleteErr != nil {
			return ResetResult{DeletedTaskIDs: deletedTaskIDs}, fmt.Errorf("delete owned task tree %q: %w", link.TaskID, deleteErr)
		}
		deletedTaskIDs = appendUnique(deletedTaskIDs, deleted...)
	}
	delete(snapshot.Watches, watchID)
	if err := s.repository.Save(ctx, workspaceID, snapshot); err != nil {
		return ResetResult{DeletedTaskIDs: deletedTaskIDs}, fmt.Errorf("save deleted watch: %w", err)
	}
	s.emit(ctx, "watch.deleted", map[string]any{"workspace_id": workspaceID, "watch_id": watchID, "task_count": len(deletedTaskIDs)})
	return ResetResult{DeletedTaskIDs: deletedTaskIDs}, nil
}

func ownedLinks(watch Watch) []TaskLink {
	keys := make([]string, 0, len(watch.Links))
	for key, link := range watch.Links {
		if link.Owned && link.TaskID != "" {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	links := make([]TaskLink, 0, len(keys))
	for _, key := range keys {
		links = append(links, watch.Links[key])
	}
	return links
}

func appendUnique(existing []string, values ...string) []string {
	seen := make(map[string]struct{}, len(existing)+len(values))
	for _, value := range existing {
		seen[value] = struct{}{}
	}
	for _, value := range values {
		if value == "" {
			continue
		}
		if _, found := seen[value]; found {
			continue
		}
		seen[value] = struct{}{}
		existing = append(existing, value)
	}
	return existing
}

func reservationToken() (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes), nil
}

type keyedMutex struct {
	mu    sync.Mutex
	locks map[string]*lockEntry
}

type lockEntry struct {
	mu   sync.Mutex
	refs int
}

func (m *keyedMutex) lock(key string) func() {
	m.mu.Lock()
	if m.locks == nil {
		m.locks = make(map[string]*lockEntry)
	}
	entry := m.locks[key]
	if entry == nil {
		entry = &lockEntry{}
		m.locks[key] = entry
	}
	entry.refs++
	m.mu.Unlock()

	entry.mu.Lock()
	return func() {
		entry.mu.Unlock()
		m.mu.Lock()
		entry.refs--
		if entry.refs == 0 {
			delete(m.locks, key)
		}
		m.mu.Unlock()
	}
}

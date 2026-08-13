package watches

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
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
	if changed, bindingErr := s.connectionChanged(ctx, watch); bindingErr != nil {
		return RunResult{}, bindingErr
	} else if changed {
		watch.Status = StatusPaused
		snapshot.Watches[watch.ID] = watch
		if err := s.repository.Save(ctx, workspaceID, snapshot); err != nil {
			return RunResult{}, fmt.Errorf("save watch after connection change: %w", err)
		}
		s.emit(ctx, "watch.connection_changed", map[string]any{"workspace_id": workspaceID, "watch_id": watchID})
		return RunResult{}, ErrConnectionChanged
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
		return Watch{}, fmt.Errorf("%w: watch and workspace ids are required", ErrInvalidWatch)
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
		return Watch{}, fmt.Errorf("%w: %q", ErrWatchExists, watch.ID)
	}
	if binding, bound, err := s.currentConnectionBinding(ctx, watch.WorkspaceID); err != nil {
		return Watch{}, err
	} else if bound {
		watch.ConnectionBinding = binding
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
		return nil, fmt.Errorf("%w: workspace id is required", ErrInvalidWatch)
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

// DetachTaskLink removes watch ownership of one task association without
// deleting the task or forgetting the durable reservation. Keeping an
// unowned link prevents a later poll from recreating or reattaching it.
func (s *Service) DetachTaskLink(
	ctx context.Context,
	workspaceID, taskID, providerScope, repositoryID string,
	pullRequestNumber int64,
) error {
	if workspaceID == "" || taskID == "" || providerScope == "" ||
		repositoryID == "" || pullRequestNumber <= 0 {
		return fmt.Errorf("%w: workspace, task, and complete pull request identity are required", ErrInvalidWatch)
	}
	unlock := s.locks.lock(workspaceID)
	defer unlock()
	snapshot, err := s.repository.Load(ctx, workspaceID)
	if err != nil {
		return fmt.Errorf("load watch snapshot: %w", err)
	}
	changed := false
	for id, watch := range snapshot.Watches {
		normalizeWatch(&watch)
		watchChanged := false
		for storageKey, link := range watch.Links {
			if link.ProviderScope != providerScope || link.RepositoryID != repositoryID ||
				link.PullRequestNumber != pullRequestNumber || link.TaskID != taskID || !link.Owned {
				continue
			}
			link.Owned = false
			watch.Links[storageKey] = link
			watchChanged = true
		}
		if watchChanged {
			snapshot.Watches[id] = watch
			changed = true
		}
	}
	if !changed {
		return nil
	}
	if err := s.repository.Save(ctx, workspaceID, snapshot); err != nil {
		return fmt.Errorf("save detached watch link: %w", err)
	}
	s.emit(ctx, "watch.link_detached", map[string]any{
		"workspace_id":        workspaceID,
		"task_id":             taskID,
		"provider_scope":      providerScope,
		"repository_id":       repositoryID,
		"pull_request_number": pullRequestNumber,
	})
	return nil
}

// RefreshTaskLink updates mutable display attributes while preserving the
// immutable map key and watch ownership.
func (s *Service) RefreshTaskLink(
	ctx context.Context,
	workspaceID, taskID, storageKey, pullRequestKey, pullRequestURL string,
) error {
	if workspaceID == "" || taskID == "" || storageKey == "" || pullRequestKey == "" {
		return fmt.Errorf("%w: workspace, task, storage, and pull request keys are required", ErrInvalidWatch)
	}
	unlock := s.locks.lock(workspaceID)
	defer unlock()
	snapshot, err := s.repository.Load(ctx, workspaceID)
	if err != nil {
		return fmt.Errorf("load watch snapshot: %w", err)
	}
	changed := false
	for id, watch := range snapshot.Watches {
		normalizeWatch(&watch)
		link, found := watch.Links[storageKey]
		if !found || link.TaskID != taskID || !link.Owned {
			continue
		}
		if link.PullRequestKey == pullRequestKey && link.PullRequestURL == pullRequestURL {
			continue
		}
		link.PullRequestKey = pullRequestKey
		link.PullRequestURL = pullRequestURL
		watch.Links[storageKey] = link
		snapshot.Watches[id] = watch
		changed = true
	}
	if !changed {
		return nil
	}
	if err := s.repository.Save(ctx, workspaceID, snapshot); err != nil {
		return fmt.Errorf("save refreshed watch link: %w", err)
	}
	return nil
}

// Recover finalizes durable reservations left in creating state when the
// process stopped after the host created a task but before state was saved.
// It never creates or deletes tasks; a later Run safely retries reservations
// that the host cannot find.
func (s *Service) Recover(ctx context.Context, workspaceID string) (int, error) {
	if workspaceID == "" {
		return 0, fmt.Errorf("%w: workspace id is required", ErrInvalidWatch)
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
		count, reconcileErr := s.reconcileCreatingReservations(ctx, workspaceID, &watch)
		if reconcileErr != nil {
			return recovered, reconcileErr
		}
		recovered += count
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

func (s *Service) reconcileCreatingReservations(
	ctx context.Context, workspaceID string, watch *Watch,
) (int, error) {
	keys := make([]string, 0, len(watch.Reservations))
	for key, reservation := range watch.Reservations {
		if reservation.State == ReservationCreating && reservation.Token != "" {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	recovered := 0
	for _, key := range keys {
		reservation := watch.Reservations[key]
		taskID := reservation.TaskID
		if taskID == "" {
			var found bool
			var err error
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
		link := reservation.Link
		if link.PullRequestKey == "" {
			link.PullRequestKey = key
		}
		link.TaskID = taskID
		link.Owned = true
		storageKey := link.storageKey()
		if storageKey == "" {
			storageKey = key
		}
		watch.Links[storageKey] = link
		recovered++
	}
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
	if status == StatusRunning {
		if binding, bound, bindErr := s.currentConnectionBinding(ctx, workspaceID); bindErr != nil {
			return Watch{}, bindErr
		} else if bound {
			watch.ConnectionBinding = binding
			watch.Cursor = ""
			watch.Failures = 0
		}
	}
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
		return Watch{}, fmt.Errorf("%w: preset id and name are required", ErrInvalidWatch)
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
	storageKey := item.storageKey()
	if storageKey == "" {
		return false, false, snapshot, watch, fmt.Errorf("watched pull request immutable identity is required")
	}
	if existing, exists := watch.Links[storageKey]; exists {
		upgraded := taskLinkForPullRequest(item, existing.TaskID)
		upgraded.Owned = existing.Owned
		if existing != upgraded {
			watch.Links[storageKey] = upgraded
			snapshot.Watches[watch.ID] = watch
			if saveErr := s.repository.Save(ctx, workspaceID, snapshot); saveErr != nil {
				return false, false, snapshot, watch, fmt.Errorf("save upgraded task link: %w", saveErr)
			}
		}
		return false, true, snapshot, watch, nil
	}
	if reservation, exists := watch.Reservations[storageKey]; exists {
		if reservation.TaskID != "" {
			watch.Links[storageKey] = taskLinkForPullRequest(item, reservation.TaskID)
			reservation.State = ReservationCreated
			watch.Reservations[storageKey] = reservation
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
			watch.Links[storageKey] = taskLinkForPullRequest(item, foundTaskID)
			reservation.State = ReservationCreated
			reservation.TaskID = foundTaskID
			watch.Reservations[storageKey] = reservation
			snapshot.Watches[watch.ID] = watch
			if saveErr := s.repository.Save(ctx, workspaceID, snapshot); saveErr != nil {
				return false, false, snapshot, watch, fmt.Errorf("save recovered reservation: %w", saveErr)
			}
			return false, true, snapshot, watch, nil
		}
	}

	reservation, exists := watch.Reservations[storageKey]
	if !exists {
		token, tokenErr := s.token()
		if tokenErr != nil {
			return false, false, snapshot, watch, fmt.Errorf("create reservation token: %w", tokenErr)
		}
		reservation = Reservation{
			Token: token, State: ReservationCreating, CreatedAt: s.now().UTC(),
			Link: taskLinkForPullRequest(item, ""),
		}
		watch.Reservations[storageKey] = reservation
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
	watch.Reservations[storageKey] = reservation
	watch.Links[storageKey] = taskLinkForPullRequest(item, taskID)
	snapshot.Watches[watch.ID] = watch
	if saveErr := s.repository.Save(ctx, workspaceID, snapshot); saveErr != nil {
		return false, false, snapshot, watch, fmt.Errorf("persist created task link: %w", saveErr)
	}
	s.emit(ctx, "watch.task_created", map[string]any{"workspace_id": workspaceID, "watch_id": watch.ID, "task_id": taskID, "pull_request_key": item.Key})
	return true, false, snapshot, watch, nil
}

func taskLinkForPullRequest(item PullRequest, taskID string) TaskLink {
	return TaskLink{
		PullRequestKey:    item.Key,
		TaskID:            taskID,
		Owned:             true,
		ProviderID:        item.Repository.ProviderID,
		ProviderHost:      item.Repository.ProviderHost,
		ConnectionScope:   item.ConnectionScope,
		PullRequestURL:    item.URL,
		RepositoryID:      item.RepositoryID,
		ProviderScope:     item.Repository.ProviderScope,
		PullRequestNumber: item.Number,
	}
}

func (s *Service) loadWatch(ctx context.Context, workspaceID, watchID string) (Snapshot, Watch, error) {
	if workspaceID == "" || watchID == "" {
		return Snapshot{}, Watch{}, fmt.Errorf("%w: workspace and watch ids are required", ErrInvalidWatch)
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
	migrateWatchIdentityKeys(watch)
}

func migrateWatchIdentityKeys(watch *Watch) {
	links := make(map[string]TaskLink, len(watch.Links))
	for key, link := range watch.Links {
		if link.PullRequestKey == "" {
			link.PullRequestKey = key
		}
		storageKey := link.storageKey()
		if storageKey == "" {
			storageKey = key
		}
		links[storageKey] = link
	}
	reservations := make(map[string]Reservation, len(watch.Reservations))
	for key, reservation := range watch.Reservations {
		storageKey := reservation.Link.storageKey()
		if storageKey == "" {
			storageKey = key
		}
		reservations[storageKey] = reservation
	}
	watch.Links = links
	watch.Reservations = reservations
}

func (s *Service) currentConnectionBinding(ctx context.Context, workspaceID string) (string, bool, error) {
	provider, supported := s.provider.(connectionBindingProvider)
	if !supported {
		return "", false, nil
	}
	binding, err := provider.ConnectionBinding(ctx, workspaceID)
	if err != nil {
		if errors.Is(err, ErrConnectionBindingUnsupported) {
			return "", false, nil
		}
		return "", true, fmt.Errorf("resolve watch connection binding: %w", err)
	}
	if binding == "" {
		return "", true, fmt.Errorf("watch connection binding is unavailable")
	}
	return binding, true, nil
}

func (s *Service) connectionChanged(ctx context.Context, watch Watch) (bool, error) {
	binding, bound, err := s.currentConnectionBinding(ctx, watch.WorkspaceID)
	if err != nil || !bound {
		return false, err
	}
	return watch.ConnectionBinding == "" || watch.ConnectionBinding != binding, nil
}

func (s *Service) emit(ctx context.Context, name string, payload map[string]any) {
	if s.events != nil {
		_ = s.events.Emit(ctx, name, payload)
	}
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

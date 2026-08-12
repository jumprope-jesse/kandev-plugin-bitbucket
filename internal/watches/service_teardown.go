package watches

import (
	"context"
	"fmt"
	"sort"
	"time"
)

func (s *Service) PreviewReset(ctx context.Context, workspaceID, watchID string) (ResetPreview, error) {
	unlock := s.locks.lock(workspaceID)
	defer unlock()

	snapshot, watch, err := s.loadWatch(ctx, workspaceID, watchID)
	if err != nil {
		return ResetPreview{}, err
	}
	recovered, err := s.reconcileCreatingReservations(ctx, workspaceID, &watch)
	if err != nil {
		return ResetPreview{}, err
	}
	if recovered > 0 {
		snapshot.Watches[watch.ID] = watch
		if err := s.repository.Save(ctx, workspaceID, snapshot); err != nil {
			return ResetPreview{}, fmt.Errorf("save reconciled reset preview: %w", err)
		}
	}
	var taskIDs []string
	for _, record := range ownedLinks(watch) {
		link := record.link
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
	if _, err := s.reconcileCreatingReservations(ctx, workspaceID, &watch); err != nil {
		return ResetResult{}, err
	}
	snapshot.Watches[watch.ID] = watch
	var deletedTaskIDs []string
	for _, record := range ownedLinks(watch) {
		link := record.link
		deleted, deleteErr := s.tasks.DeleteOwned(ctx, link.TaskID)
		deletedTaskIDs = appendUnique(deletedTaskIDs, deleted...)
		if deleteErr != nil {
			return ResetResult{DeletedTaskIDs: deletedTaskIDs}, fmt.Errorf("delete owned task tree %q: %w", link.TaskID, deleteErr)
		}
		delete(watch.Links, record.storageKey)
		delete(watch.Reservations, record.storageKey)
		snapshot.Watches[watch.ID] = watch
		if err := s.repository.Save(ctx, workspaceID, snapshot); err != nil {
			return ResetResult{DeletedTaskIDs: deletedTaskIDs}, fmt.Errorf("save reset progress: %w", err)
		}
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
	if _, err := s.reconcileCreatingReservations(ctx, workspaceID, &watch); err != nil {
		return ResetResult{}, err
	}
	snapshot.Watches[watch.ID] = watch
	var deletedTaskIDs []string
	for _, record := range ownedLinks(watch) {
		link := record.link
		deleted, deleteErr := s.tasks.DeleteOwned(ctx, link.TaskID)
		deletedTaskIDs = appendUnique(deletedTaskIDs, deleted...)
		if deleteErr != nil {
			return ResetResult{DeletedTaskIDs: deletedTaskIDs}, fmt.Errorf("delete owned task tree %q: %w", link.TaskID, deleteErr)
		}
		delete(watch.Links, record.storageKey)
		delete(watch.Reservations, record.storageKey)
		snapshot.Watches[watch.ID] = watch
		if err := s.repository.Save(ctx, workspaceID, snapshot); err != nil {
			return ResetResult{DeletedTaskIDs: deletedTaskIDs}, fmt.Errorf("save delete progress: %w", err)
		}
	}
	delete(snapshot.Watches, watchID)
	if err := s.repository.Save(ctx, workspaceID, snapshot); err != nil {
		return ResetResult{DeletedTaskIDs: deletedTaskIDs}, fmt.Errorf("save deleted watch: %w", err)
	}
	s.emit(ctx, "watch.deleted", map[string]any{"workspace_id": workspaceID, "watch_id": watchID, "task_count": len(deletedTaskIDs)})
	return ResetResult{DeletedTaskIDs: deletedTaskIDs}, nil
}

type ownedLink struct {
	storageKey string
	link       TaskLink
}

func ownedLinks(watch Watch) []ownedLink {
	keys := make([]string, 0, len(watch.Links))
	for key, link := range watch.Links {
		if link.Owned && link.TaskID != "" {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	links := make([]ownedLink, 0, len(keys))
	for _, key := range keys {
		links = append(links, ownedLink{storageKey: key, link: watch.Links[key]})
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

// Package plugin contains host-facing orchestration for the Bitbucket plugin.
package plugin

import (
	"context"
	"encoding/json"
	"fmt"

	"kandev-plugin-bitbucket/internal/watches"
)

const watchStateKey = "bitbucket.watches.v1"

// StateHost is the narrow Host-state surface used by durable plugin stores.
type StateHost interface {
	GetState(context.Context, string, string, string) (map[string]any, bool, error)
	SetState(context.Context, string, string, string, map[string]any) error
}

// WatchStateRepository persists the complete workspace watch snapshot in one
// host-state value. A snapshot write is atomic at the Host-state boundary,
// which keeps a creating reservation durable across plugin restarts.
type WatchStateRepository struct{ host StateHost }

func NewWatchStateRepository(host StateHost) (*WatchStateRepository, error) {
	if host == nil {
		return nil, fmt.Errorf("watch state host is required")
	}
	return &WatchStateRepository{host: host}, nil
}

func (r *WatchStateRepository) Load(ctx context.Context, workspaceID string) (watches.Snapshot, error) {
	if workspaceID == "" {
		return watches.Snapshot{}, fmt.Errorf("workspace id is required")
	}
	value, found, err := r.host.GetState(ctx, "workspace", workspaceID, watchStateKey)
	if err != nil {
		return watches.Snapshot{}, fmt.Errorf("load watch state: %w", err)
	}
	if !found {
		return watches.Snapshot{Watches: make(map[string]watches.Watch)}, nil
	}
	var snapshot watches.Snapshot
	if err := decodeState(value, &snapshot); err != nil {
		return watches.Snapshot{}, fmt.Errorf("decode watch state: %w", err)
	}
	if snapshot.Watches == nil {
		snapshot.Watches = make(map[string]watches.Watch)
	}
	return snapshot, nil
}

func (r *WatchStateRepository) Save(ctx context.Context, workspaceID string, snapshot watches.Snapshot) error {
	if workspaceID == "" {
		return fmt.Errorf("workspace id is required")
	}
	value, err := encodeState(snapshot)
	if err != nil {
		return fmt.Errorf("encode watch state: %w", err)
	}
	if err := r.host.SetState(ctx, "workspace", workspaceID, watchStateKey, value); err != nil {
		return fmt.Errorf("save watch state: %w", err)
	}
	return nil
}

func encodeState(value any) (map[string]any, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal(encoded, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func decodeState(value map[string]any, target any) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return json.Unmarshal(encoded, target)
}

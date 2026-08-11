package plugin

import (
	"context"
	"fmt"
	"sync"
	"time"

	"kandev-plugin-bitbucket/internal/domain"
	"kandev-plugin-bitbucket/internal/watches"

	"github.com/kandev/kandev/pkg/pluginsdk"
)

// Manager owns the process-lifetime health and watch polling loop. All
// watched task changes remain behind the durable watch service.
type Manager struct {
	host     pluginsdk.Host
	resolver ProviderResolver
	watches  *watches.Service
	events   watches.EventSink
	schedule domain.HealthSchedule
	now      func() time.Time

	mu               sync.Mutex
	workspaceBackoff map[string]workspacePollBackoff
}

type workspacePollBackoff struct {
	failures    int
	nextAttempt time.Time
}

func NewManager(host pluginsdk.Host, resolver ProviderResolver, watchService *watches.Service) (*Manager, error) {
	if host == nil || resolver == nil || watchService == nil {
		return nil, fmt.Errorf("host, provider resolver, and watches are required")
	}
	events, err := NewEventSink(host)
	if err != nil {
		return nil, err
	}
	return &Manager{
		host: host, resolver: resolver, watches: watchService, events: events,
		schedule: domain.NewHealthSchedule(nil), now: time.Now,
		workspaceBackoff: make(map[string]workspacePollBackoff),
	}, nil
}

// Run performs an immediate poll, then uses the adapter's bounded health
// schedule. Cancellation stops cleanly; it never creates a background task
// from a caller-owned request context.
func (m *Manager) Run(ctx context.Context) {
	for {
		_ = m.pollScheduled(ctx)
		delay := m.schedule.Next(0)

		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

func (m *Manager) PollAll(ctx context.Context) error {
	return m.pollWorkspaces(ctx, false)
}

func (m *Manager) pollScheduled(ctx context.Context) error {
	return m.pollWorkspaces(ctx, true)
}

func (m *Manager) pollWorkspaces(ctx context.Context, scheduled bool) error {
	page := pluginsdk.Page{Limit: 100}
	var firstErr error
	for {
		workspaces, info, err := m.host.Workspaces().List(ctx, page)
		if err != nil {
			return fmt.Errorf("list workspaces for Bitbucket polling: %w", err)
		}
		for _, workspace := range workspaces {
			if workspace.ID == "" {
				continue
			}
			if scheduled && !m.workspacePollDue(workspace.ID) {
				continue
			}
			err := m.PollWorkspace(ctx, workspace.ID)
			if scheduled {
				m.recordWorkspacePoll(workspace.ID, err)
			}
			if err != nil {
				// Continue polling other workspaces. Per-workspace errors are
				// emitted with a safe, namespaced event below.
				m.emit(ctx, "health.unavailable", map[string]any{"workspace_id": workspace.ID})
				if firstErr == nil {
					firstErr = err
				}
			}
		}
		if info == nil || !info.HasMore || info.NextCursor == "" {
			return firstErr
		}
		page.Cursor = info.NextCursor
	}
}

func (m *Manager) workspacePollDue(workspaceID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return !m.now().Before(m.workspaceBackoff[workspaceID].nextAttempt)
}

func (m *Manager) recordWorkspacePoll(workspaceID string, pollErr error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	state := m.workspaceBackoff[workspaceID]
	if pollErr == nil {
		state.failures = 0
	} else {
		state.failures++
	}
	state.nextAttempt = m.now().Add(m.schedule.Next(state.failures))
	m.workspaceBackoff[workspaceID] = state
}

// PollWorkspace first restores crash-safe reservations, then checks health,
// then runs enabled watches. Health failure intentionally leaves state intact.
func (m *Manager) PollWorkspace(ctx context.Context, workspaceID string) error {
	if workspaceID == "" {
		return fmt.Errorf("workspace id is required")
	}
	if _, err := m.watches.Recover(ctx, workspaceID); err != nil {
		return err
	}
	if connections, ok := m.resolver.(ConnectionSettingsStore); ok {
		_, configured, err := connections.Load(ctx, workspaceID)
		if err != nil {
			return fmt.Errorf("load Bitbucket connection: %w", err)
		}
		if !configured {
			return nil
		}
	}
	provider, err := m.resolver.Provider(ctx, workspaceID)
	if err != nil {
		return fmt.Errorf("resolve Bitbucket provider: %w", err)
	}
	if err := provider.Health(ctx); err != nil {
		return fmt.Errorf("Bitbucket health check failed")
	}
	m.emit(ctx, "health.healthy", map[string]any{"workspace_id": workspaceID})
	configured, err := m.watches.List(ctx, workspaceID)
	if err != nil {
		return err
	}
	for _, watch := range configured {
		if watch.Status != watches.StatusRunning {
			continue
		}
		if _, err := m.watches.Run(ctx, workspaceID, watch.ID); err != nil {
			m.emit(ctx, "watch.poll_failed", map[string]any{"workspace_id": workspaceID, "watch_id": watch.ID})
		}
	}
	return nil
}

func (m *Manager) emit(ctx context.Context, name string, payload map[string]any) {
	if m.events != nil {
		_ = m.events.Emit(ctx, name, payload)
	}
}

package plugin

import (
	"context"
	"errors"
	"testing"

	"github.com/kandev/kandev/pkg/pluginsdk"
	"github.com/stretchr/testify/require"
)

func TestManager_PollsWorkspaceAndEmitsOnlySafeHealthEvent(t *testing.T) {
	host := &managerHost{connectionHost: newConnectionHost(), workspaces: []pluginsdk.Workspace{{ID: "workspace-1"}}}
	provider := &workflowProvider{healthErr: errors.New("remote rejected secret-token")}
	workflows, err := NewWorkflows(host, staticResolver{provider: provider})
	require.NoError(t, err)
	manager, err := NewManager(host, staticResolver{provider: provider}, workflows.watches)
	require.NoError(t, err)

	err = manager.PollAll(context.Background())
	require.Error(t, err)
	require.NotContains(t, err.Error(), "secret-token")
	require.Equal(t, []string{"health.unavailable"}, host.events)
}

type managerHost struct {
	*connectionHost
	workspaces []pluginsdk.Workspace
	events     []string
}

func (h *managerHost) Workspaces() pluginsdk.WorkspaceReader {
	return managerWorkspaceReader{workspaces: h.workspaces}
}
func (h *managerHost) EmitEvent(_ context.Context, name string, _ map[string]any) error {
	h.events = append(h.events, name)
	return nil
}

type managerWorkspaceReader struct{ workspaces []pluginsdk.Workspace }

func (r managerWorkspaceReader) List(context.Context, pluginsdk.Page) ([]pluginsdk.Workspace, *pluginsdk.PageInfo, error) {
	return r.workspaces, nil, nil
}

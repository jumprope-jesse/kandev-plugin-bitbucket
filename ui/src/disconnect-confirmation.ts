import { disconnectConnectionInput, errorMessage } from "./view-models";
import type { PluginHost } from "./host-contract";
import { action } from "./actions";
import { isAbortError, useAbortableOperation } from "./ui-runtime";

export function DisconnectConfirmation({
  host,
  workspaceId,
  onSuccess,
  onCancel,
}: {
  host: PluginHost;
  workspaceId: string;
  onSuccess(): void;
  onCancel(): void;
}) {
  const { jsx: h, ui, React } = host;
  const [disconnecting, setDisconnecting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const mutation = useAbortableOperation(host);
  const disconnect = async () => {
    setDisconnecting(true);
    setError(null);
    const request = mutation.begin();
    try {
      await host.api.invokeAction(
        action.connectionDisconnect,
        disconnectConnectionInput(workspaceId),
        {
          signal: request.signal,
        },
      );
      if (request.isCurrent()) onSuccess();
    } catch (reason) {
      if (request.isCurrent() && !isAbortError(reason)) setError(errorMessage(reason));
    } finally {
      if (request.finish()) setDisconnecting(false);
    }
  };
  return h(
    "section",
    { className: "bb-disconnect-confirm" },
    h("p", null, "Disconnect Bitbucket connection?"),
    h(
      "p",
      { className: "bb-capability-note" },
      "Stored Bitbucket credentials and connection settings for this workspace will be removed.",
    ),
    error ? h("p", { className: "bb-error", role: "alert" }, error) : null,
    h(
      "div",
      { className: "bb-card-actions" },
      h(
        ui.Button,
        {
          type: "button",
          variant: "outline",
          className: "min-h-11",
          disabled: disconnecting,
          onClick: onCancel,
        },
        "Cancel",
      ),
      h(
        ui.Button,
        {
          type: "button",
          variant: "destructive",
          className: "min-h-11",
          disabled: disconnecting,
          onClick: () => void disconnect(),
        },
        disconnecting ? "Disconnecting…" : "Disconnect Bitbucket",
      ),
    ),
  );
}

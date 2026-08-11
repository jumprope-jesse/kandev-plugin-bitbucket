import { integrationSettingsHref } from "./view-models";
import type { Component, PluginHost, PluginRegistry } from "./host-contract";
import { ConnectionHealth } from "./connection-view";
import { Watches } from "./dashboard-components";
import { BitbucketPage } from "./bitbucket-page";
import { registerNativeIntegrations } from "./native-integrations";
import { associationStore, reviewStore } from "./review-store";
import { text, useActiveWorkspaceId } from "./ui-runtime";

const PLUGIN_ID = "kandev-plugin-bitbucket";

function makeIntegrationSettings(host: PluginHost): Component {
  return function IntegrationSettings(props = {}) {
    const activeWorkspaceId = useActiveWorkspaceId(host);
    const scopedWorkspaceId = text(props.workspaceId) || activeWorkspaceId;
    return host.jsx(
      "div",
      { className: "bb-plugin-settings" },
      host.jsx(ConnectionHealth, {
        key: scopedWorkspaceId || "unscoped",
        host,
        workspaceId: scopedWorkspaceId,
      }),
      host.jsx(Watches, {
        key: `watches:${scopedWorkspaceId || "unscoped"}`,
        host,
        workspaceId: scopedWorkspaceId,
        filter: {},
        showCreate: false,
      }),
    );
  };
}

function makeTopbarActions(host: PluginHost): Component {
  return function TopbarActions() {
    const activeWorkspaceId = useActiveWorkspaceId(host);
    return host.jsx(
      host.ui.Button,
      {
        type: "button",
        variant: "ghost",
        size: "sm",
        className: "bb-topbar-settings",
        "aria-label": "Open Bitbucket settings",
        onClick: () =>
          host.navigate(integrationSettingsHref(activeWorkspaceId)),
      },
      "Settings",
    );
  };
}

declare global {
  interface Window {
    registerKandevPlugin(
      id: string,
      lifecycle: {
        initialize(registry: PluginRegistry, host: PluginHost): void;
        destroy?(): void;
      },
    ): void;
  }
}

window.registerKandevPlugin(PLUGIN_ID, {
  initialize(registry, host) {
    registry.registerNavItem({
      id: "bitbucket",
      label: "Bitbucket",
      path: "/bitbucket",
      icon: "bitbucket",
      section: "integrations",
    });
    registry.registerRoute(
      "/bitbucket",
      () => host.jsx(BitbucketPage, { host }),
      {
        topbar: {
          title: "Bitbucket",
          subtitle: "Pull requests",
          icon: "bitbucket",
          actions: makeTopbarActions(host),
        },
      },
    );
    registry.registerIntegrationSettings({
      id: "bitbucket",
      label: "Bitbucket",
      description: "Connect Bitbucket Cloud or Data Center for this workspace.",
      icon: "bitbucket",
      Component: makeIntegrationSettings(host),
    });
    registerNativeIntegrations(registry, host);
  },
  destroy() {
    reviewStore.clear();
    associationStore.clear();
  },
});

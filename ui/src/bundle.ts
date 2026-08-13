import { integrationSettingsHref } from "./view-models";
import type { Component, PluginHost, PluginRegistry } from "./host-contract";
import { ConnectionHealth } from "./connection-view";
import { Watches } from "./dashboard-components";
import { BitbucketPage } from "./bitbucket-page";
import { registerNativeIntegrations } from "./native-integrations";
import { associationStore, reviewStore } from "./review-store";
import { text, useActiveWorkspaceId } from "./ui-runtime";
import {
  pluginTranslate,
  registerTranslations,
  usePluginTranslation,
} from "./i18n";
import { createBitbucketIcon } from "./bitbucket-icon";

const PLUGIN_ID = "kandev-plugin-bitbucket";

function makeIntegrationSettings(
  host: PluginHost,
): Component<{ workspaceId?: string }> {
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
    const { t } = usePluginTranslation(host);
    return host.jsx(
      host.ui.Button,
      {
        type: "button",
        variant: "ghost",
        size: "sm",
        className: "bb-topbar-settings",
        "aria-label": t("openSettings"),
        onClick: () =>
          host.navigate(integrationSettingsHref(activeWorkspaceId)),
      },
      t("settings"),
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
    registerTranslations(registry);
    const t = pluginTranslate(host);
    const bitbucketIcon = createBitbucketIcon(host);
    registry.registerNavItem({
      id: "bitbucket",
      get label() {
        return t("bitbucket");
      },
      path: "/bitbucket",
      icon: bitbucketIcon,
      section: "integrations",
    });
    registry.registerRoute(
      "/bitbucket",
      () => host.jsx(BitbucketPage, { host }),
      {
        topbar: {
          get title() {
            return t("bitbucket");
          },
          get subtitle() {
            return t("pullRequests");
          },
          icon: bitbucketIcon,
          actions: makeTopbarActions(host),
        },
      },
    );
    registry.registerIntegrationSettings({
      id: "bitbucket",
      get label() {
        return t("bitbucket");
      },
      get description() {
        return t("connectDescription");
      },
      icon: bitbucketIcon,
      Component: makeIntegrationSettings(host),
    });
    registerNativeIntegrations(registry, host, bitbucketIcon);
  },
  destroy() {
    reviewStore.clear();
    associationStore.clear();
  },
});

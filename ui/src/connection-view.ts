import {
  connectionIdentity,
  connectionOAuthRegistration,
  connectionSaveBody,
  connectionState,
  deriveOAuthCallbackURL,
  disconnectConnectionInput,
  errorMessage,
  oauthStartInput,
  validateCloudWorkspace,
  validateConnectionIdentity,
  validateOAuthRegistration,
  type ConnectionState,
} from "./view-models";
import { type PluginHost } from "./host-contract";
import { record, text, usePluginQuery, Badge } from "./ui-runtime";
import { action } from "./actions";
import { DisconnectConfirmation } from "./disconnect-confirmation";

export function ConnectionHealth({
  host,
  workspaceId: scopedWorkspaceId,
}: {
  host: PluginHost;
  workspaceId?: string;
}) {
  const { jsx: h, ui, React } = host;
  const responsive = host.useResponsiveBreakpoint();
  const connection = usePluginQuery<Record<string, unknown>>(
    host,
    action.connectionGet,
    scopedWorkspaceId ? { workspaceId: scopedWorkspaceId } : undefined,
    Boolean(scopedWorkspaceId),
  );
  const [saving, setSaving] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [product, setProduct] = React.useState("cloud");
  const [baseUrl, setBaseUrl] = React.useState("");
  const [cloudWorkspace, setCloudWorkspace] = React.useState("");
  const [authMethod, setAuthMethod] = React.useState("api_token");
  const [token, setToken] = React.useState("");
  const details = record(connection.data);
  const [identity, setIdentity] = React.useState("");
  const oauthRegistration = connectionOAuthRegistration(details);
  const [oauthClientId, setOAuthClientId] = React.useState("");
  const [oauthClientSecret, setOAuthClientSecret] = React.useState("");
  const oauthCallbackUrl = deriveOAuthCallbackURL(
    host.api.baseUrl,
    window.location.origin,
  );
  const [disconnectOpen, setDisconnectOpen] = React.useState(false);
  React.useEffect(() => {
    if (!connection.data) return;
    setProduct(text(details.product, "cloud"));
    setBaseUrl(text(details.base_url));
    setCloudWorkspace(text(details.cloud_workspace));
    setAuthMethod(text(details.auth_method, "api_token"));
    setIdentity(text(details.auth_identity));
  }, [connection.data]);
  const state = connectionState(details);
  const identityField = connectionIdentity(product, authMethod);
  const formInput = () => ({
    product,
    baseUrl,
    cloudWorkspace,
    authMethod,
    token,
    identity,
    oauthRegistrationConfigured: oauthRegistration.configured,
    oauthClientId,
    oauthClientSecret,
    oauthCallbackUrl,
  });
  const connectionValidationError = () =>
    validateCloudWorkspace(formInput()) ??
    validateConnectionIdentity(formInput()) ??
    validateOAuthRegistration(formInput());
  const oauthReady = authMethod === "oauth" && !connectionValidationError();
  const label: Record<ConnectionState, string> = {
    unconfigured: "Not configured",
    checking: "Checking connection",
    connected: "Connected",
    auth_required: "Authentication required",
    unavailable: "Unavailable",
  };
  const saveConnection = async () => {
    if (!scopedWorkspaceId) return;
    const validationError = connectionValidationError();
    if (validationError) {
      setMessage(validationError);
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      await host.api.invokeAction(action.connectionSave, {
        workspaceId: scopedWorkspaceId,
        body: {
          ...connectionSaveBody(formInput()),
          probe: true,
        },
      });
      setToken("");
      setOAuthClientSecret("");
      setMessage("Connection saved and health check started.");
      connection.refresh();
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };
  const startOauth = async () => {
    if (!scopedWorkspaceId) return;
    const validationError = connectionValidationError();
    if (validationError) {
      setMessage(validationError);
      return;
    }
    setSaving(true);
    try {
      await host.api.invokeAction(action.connectionSave, {
        workspaceId: scopedWorkspaceId,
        body: {
          ...connectionSaveBody(formInput()),
          probe: false,
        },
      });
      setOAuthClientSecret("");
      const result = await host.api.invokeAction<Record<string, unknown>>(
        action.oauthStart,
        oauthStartInput(scopedWorkspaceId),
      );
      const href =
        text(record(result).url) || text(record(result).authorization_url);
      if (href) window.location.assign(href);
      else
        setMessage(
          "OAuth authorization is ready. Continue in the connection settings.",
        );
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };
  const completeDisconnect = () => {
    setToken("");
    setOAuthClientSecret("");
    setProduct("cloud");
    setBaseUrl("");
    setCloudWorkspace("");
    setAuthMethod("api_token");
    setIdentity("");
    setOAuthClientId("");
    setDisconnectOpen(false);
    setMessage("Bitbucket disconnected. Stored credentials cleared.");
    connection.refresh();
  };
  const openDisconnectConfirmation = () => {
    if (!scopedWorkspaceId) return;
    if (responsive.isMobile) {
      setDisconnectOpen(true);
      return;
    }
    let modal: { close(): void } | undefined;
    modal = host.openModal({
      title: "Disconnect Bitbucket",
      size: "sm",
      content: () =>
        h(DisconnectConfirmation, {
          host,
          workspaceId: scopedWorkspaceId,
          onSuccess: () => {
            completeDisconnect();
            modal?.close();
          },
          onCancel: () => modal?.close(),
        }),
    });
  };
  return h(
    ui.Card,
    {
      className: "bb-connection",
      "data-testid": "bitbucket-connection-health",
    },
    h(
      ui.CardHeader,
      null,
      h(
        "div",
        { className: "bb-title-row" },
        h(ui.CardTitle, null, "Connection"),
        Badge(
          host,
          label[state],
          state === "connected"
            ? "success"
            : state === "auth_required"
              ? "warning"
              : "neutral",
        ),
      ),
      h(
        ui.CardDescription,
        null,
        text(
          details.product,
          "Connect Bitbucket Cloud or Data Center for this workspace.",
        ),
      ),
    ),
    h(
      ui.CardContent,
      { className: "bb-settings-form" },
      connection.loading
        ? h(ui.Spinner, { "aria-label": "Checking Bitbucket connection" })
        : null,
      connection.error
        ? h("p", { className: "bb-error", role: "alert" }, connection.error)
        : null,
      message
        ? h("p", { className: "bb-message", role: "status" }, message)
        : null,
      h(ui.Label, { htmlFor: "bitbucket-product" }, "Bitbucket product"),
      h(
        ui.Select,
        {
          value: product,
          onValueChange: (next: string) => {
            setProduct(next);
            setAuthMethod(next === "cloud" ? "api_token" : "user_pat");
            setCloudWorkspace("");
            setIdentity("");
            setToken("");
            setOAuthClientId("");
            setOAuthClientSecret("");
          },
        },
        h(
          ui.SelectTrigger,
          { id: "bitbucket-product", className: "min-h-11" },
          h(ui.SelectValue, null),
        ),
        h(
          ui.SelectContent,
          null,
          h(ui.SelectItem, { value: "cloud" }, "Bitbucket Cloud"),
          h(ui.SelectItem, { value: "data_center" }, "Bitbucket Data Center"),
        ),
      ),
      product === "cloud"
        ? h(
            "div",
            { className: "bb-field" },
            h(
              ui.Label,
              { htmlFor: "bitbucket-cloud-workspace" },
              "Bitbucket workspace",
            ),
            h(ui.Input, {
              id: "bitbucket-cloud-workspace",
              "data-testid": "bitbucket-cloud-workspace",
              className: "min-h-11",
              autoComplete: "organization",
              value: cloudWorkspace,
              onChange: (event: { target: { value: string } }) =>
                setCloudWorkspace(event.target.value),
              placeholder: "workspace-slug",
              "aria-describedby": "bitbucket-cloud-workspace-help",
            }),
            h(
              "p",
              {
                id: "bitbucket-cloud-workspace-help",
                className: "bb-capability-note",
              },
              "Workspace slug or ID from bitbucket.org/workspace; required to list repositories.",
            ),
          )
        : null,
      product === "data_center"
        ? h(
            "div",
            { className: "bb-field" },
            h(ui.Label, { htmlFor: "bitbucket-base-url" }, "Data Center URL"),
            h(ui.Input, {
              id: "bitbucket-base-url",
              className: "min-h-11",
              value: baseUrl,
              onChange: (event: { target: { value: string } }) =>
                setBaseUrl(event.target.value),
              placeholder: "https://bitbucket.example.com/bitbucket",
            }),
          )
        : null,
      h(ui.Label, { htmlFor: "bitbucket-auth-method" }, "Authentication"),
      h(
        ui.Select,
        {
          value: authMethod,
          onValueChange: (next: string) => {
            setAuthMethod(next);
            if (next === "oauth") setToken("");
            if (next !== "oauth") {
              setOAuthClientId("");
              setOAuthClientSecret("");
            }
          },
        },
        h(
          ui.SelectTrigger,
          { id: "bitbucket-auth-method", className: "min-h-11" },
          h(ui.SelectValue, null),
        ),
        h(
          ui.SelectContent,
          null,
          product === "cloud"
            ? [
                h(ui.SelectItem, { value: "api_token" }, "API token"),
                h(ui.SelectItem, { value: "oauth" }, "OAuth 2.0"),
              ]
            : [
                h(
                  ui.SelectItem,
                  { value: "user_pat" },
                  "Personal access token",
                ),
                h(
                  ui.SelectItem,
                  { value: "project_token" },
                  "Project access token",
                ),
                h(
                  ui.SelectItem,
                  { value: "repository_token" },
                  "Repository access token",
                ),
                h(ui.SelectItem, { value: "oauth" }, "OAuth 2.0"),
              ],
        ),
      ),
      authMethod !== "oauth"
        ? h(
            "div",
            { className: "bb-field" },
            h(ui.Label, { htmlFor: "bitbucket-token" }, "Access token"),
            h(ui.Input, {
              id: "bitbucket-token",
              type: "password",
              className: "min-h-11",
              autoComplete: "off",
              value: token,
              onChange: (event: { target: { value: string } }) =>
                setToken(event.target.value),
              placeholder: "Stored only by Bitbucket secret handling",
            }),
          )
        : null,
      identityField
        ? h(
            "div",
            { className: "bb-field" },
            h(
              ui.Label,
              { htmlFor: "bitbucket-connection-identity" },
              identityField.label,
            ),
            h(ui.Input, {
              id: "bitbucket-connection-identity",
              "data-testid": "bitbucket-connection-identity",
              type: identityField.inputType,
              className: "min-h-11",
              autoComplete:
                identityField.inputType === "email" ? "email" : "username",
              value: identity,
              onChange: (event: { target: { value: string } }) =>
                setIdentity(event.target.value),
              "aria-describedby": "bitbucket-connection-identity-help",
            }),
            h(
              "p",
              {
                id: "bitbucket-connection-identity-help",
                className: "bb-capability-note",
              },
              identityField.help,
            ),
          )
        : null,
      authMethod === "oauth"
        ? h(
            "section",
            {
              className: "bb-oauth-registration",
              "aria-label": "OAuth client registration",
            },
            oauthRegistration.configured
              ? h(
                  "p",
                  { className: "bb-capability-note", role: "status" },
                  "OAuth app registration is configured. Enter both values only to replace it.",
                )
              : null,
            h(
              "div",
              { className: "bb-field" },
              h(
                ui.Label,
                { htmlFor: "bitbucket-oauth-client-id" },
                oauthRegistration.configured
                  ? "OAuth client ID (optional to replace)"
                  : "OAuth client ID",
              ),
              h(ui.Input, {
                id: "bitbucket-oauth-client-id",
                "data-testid": "bitbucket-oauth-client-id",
                className: "min-h-11",
                autoComplete: "off",
                value: oauthClientId,
                onChange: (event: { target: { value: string } }) =>
                  setOAuthClientId(event.target.value),
              }),
            ),
            h(
              "div",
              { className: "bb-field" },
              h(
                ui.Label,
                { htmlFor: "bitbucket-oauth-client-secret" },
                oauthRegistration.configured
                  ? "OAuth client secret (optional to replace)"
                  : "OAuth client secret",
              ),
              h(ui.Input, {
                id: "bitbucket-oauth-client-secret",
                "data-testid": "bitbucket-oauth-client-secret",
                type: "password",
                className: "min-h-11",
                autoComplete: "off",
                value: oauthClientSecret,
                onChange: (event: { target: { value: string } }) =>
                  setOAuthClientSecret(event.target.value),
                "aria-describedby": "bitbucket-oauth-client-secret-help",
              }),
              h(
                "p",
                {
                  id: "bitbucket-oauth-client-secret-help",
                  className: "bb-capability-note",
                },
                "Stored only by Bitbucket secret handling. Existing secrets are never displayed.",
              ),
            ),
            h(
              "div",
              { className: "bb-field" },
              h(
                ui.Label,
                { htmlFor: "bitbucket-oauth-callback-url" },
                "OAuth callback URL",
              ),
              h(ui.Input, {
                id: "bitbucket-oauth-callback-url",
                "data-testid": "bitbucket-oauth-callback-url",
                type: "url",
                className: "min-h-11",
                readOnly: true,
                value: oauthCallbackUrl,
                "aria-describedby": "bitbucket-oauth-callback-url-help",
              }),
              h(
                "p",
                {
                  id: "bitbucket-oauth-callback-url-help",
                  className: "bb-capability-note",
                },
                "Copy this Kandev callback URL into your OAuth app. It is derived from this Kandev origin.",
              ),
            ),
          )
        : null,
      authMethod === "oauth"
        ? h(
            ui.Button,
            {
              type: "button",
              className: "min-h-11",
              disabled: saving || !oauthReady,
              onClick: startOauth,
            },
            "Connect with OAuth",
          )
        : null,
      h(ui.Separator, null),
      h(
        "div",
        { className: "bb-settings-actions" },
        h(
          ui.Button,
          {
            type: "button",
            variant: "outline",
            className: "min-h-11",
            disabled: saving,
            onClick: saveConnection,
          },
          "Check connection",
        ),
        h(
          ui.Button,
          {
            type: "button",
            variant: "destructive",
            className: "bb-settings-disconnect min-h-11",
            disabled: saving || !scopedWorkspaceId,
            onClick: openDisconnectConfirmation,
          },
          "Disconnect Bitbucket",
        ),
      ),
      responsive.isMobile && scopedWorkspaceId
        ? h(
            ui.Drawer,
            {
              open: disconnectOpen,
              onOpenChange: (open: boolean) => setDisconnectOpen(open),
            },
            h(
              ui.DrawerContent,
              { className: "bb-disconnect-drawer" },
              h(
                ui.DrawerHeader,
                null,
                h(ui.DrawerTitle, null, "Disconnect Bitbucket"),
                h(
                  ui.DrawerDescription,
                  null,
                  "Remove this workspace Bitbucket connection.",
                ),
              ),
              h(
                "div",
                { className: "bb-drawer-scroll" },
                h(DisconnectConfirmation, {
                  host,
                  workspaceId: scopedWorkspaceId,
                  onSuccess: completeDisconnect,
                  onCancel: () => setDisconnectOpen(false),
                }),
              ),
            ),
          )
        : null,
    ),
  );
}

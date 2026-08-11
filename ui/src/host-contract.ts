import type { ReviewSummaryForHost } from "./task-review-status";
import type { RepositoryInspection } from "./view-models";

export type ElementFactory = (
  type: unknown,
  props?: Record<string, unknown> | null,
  ...children: unknown[]
) => unknown;
export type Component = (props?: Record<string, unknown>) => unknown;
export type ResponsiveBreakpoint = {
  isMobile: boolean;
  usesDesktopWorkbench?: boolean;
};

export type ActionInput = {
  workspaceId?: string;
  taskId?: string;
  sessionId?: string;
  repositoryId?: string;
  body?: unknown;
};

export type PluginHostRepository = {
  id: string;
  workspace_id: string;
  name: string;
  provider: string;
  provider_repo_id?: string;
  provider_host?: string;
  provider_scope?: string;
  provider_owner?: string;
  provider_name?: string;
  remote_url?: string;
  default_branch?: string;
};

export type TaskContext = {
  workspaceId: string;
  taskId: string;
  repositories: readonly PluginHostRepository[];
  pathname: string;
  presentation: "desktop" | "mobile";
};

export type HostReact = {
  useState<T>(
    value: T | (() => T),
  ): [T, (next: T | ((previous: T) => T)) => void];
  useEffect(effect: () => void | (() => void), dependencies?: unknown[]): void;
  useMemo<T>(factory: () => T, dependencies?: unknown[]): T;
  useCallback<T extends (...args: never[]) => unknown>(
    callback: T,
    dependencies: unknown[],
  ): T;
  useRef<T>(value: T): { current: T };
};

export type PluginHost = {
  React: HostReact;
  jsx: ElementFactory;
  ui: Record<string, unknown>;
  api: {
    readonly baseUrl: string;
    invokeAction<T>(
      key: string,
      input?: ActionInput,
      options?: { signal?: AbortSignal },
    ): Promise<T>;
  };
  useResponsiveBreakpoint(): ResponsiveBreakpoint;
  store: {
    getState(): Record<string, unknown>;
    subscribe(listener: () => void): () => void;
  };
  navigate(href: string, options?: { replace?: boolean }): void;
  openModal(options: {
    title: string;
    content: Component;
    size?: "sm" | "md" | "lg" | "xl";
    presentation?: "dialog" | "drawer";
  }): { close(): void };
  openTaskLinkDialog(options: {
    title: string;
    description: string;
    inputLabel: string;
    placeholder?: string;
    emptyError: string;
    failureMessage: string;
    successMessage: string;
    inputTestId?: string;
    errorTestId?: string;
    submitTestId?: string;
    onSubmit(reference: string, signal: AbortSignal): Promise<void>;
  }): { close(): void };
  utils: { generateUUID(): string };
  storage: {
    get(
      scope: "workspace",
      scopeId: string,
      key: string,
    ): Promise<{ value: unknown; updatedAt: string } | undefined>;
    set(
      scope: "workspace",
      scopeId: string,
      key: string,
      value: unknown,
    ): Promise<{ updatedAt: string }>;
    subscribe(
      filter: { scope: "workspace"; scopeId: string; key: string },
      listener: () => void,
    ): () => void;
  };
};

export type ReviewSummary = ReviewSummaryForHost;
export type ReviewTaskAssociation = {
  providerId: "bitbucket";
  taskId: string;
  reviewKey: string;
};

export type PluginRegistry = {
  registerRoute(
    path: string,
    component: Component,
    options?: Record<string, unknown>,
  ): void;
  registerNavItem(item: {
    id: string;
    label: string;
    path: string;
    icon: string;
    section: "integrations";
  }): void;
  registerComponent(slot: string, component: Component): void;
  registerIntegrationSettings(settings: {
    id: string;
    label: string;
    description: string;
    icon?: string;
    Component: Component;
  }): void;
  registerRepositoryProvider(provider: {
    id: string;
    label: string;
    icon: string;
    listRepositories(context: {
      workspaceId: string;
      query?: string;
      cursor?: string;
      limit?: number;
      signal: AbortSignal;
    }): Promise<
      | RepositoryInspection[]
      | { repositories: RepositoryInspection[]; nextCursor?: string }
    >;
    matchesURL(url: string): boolean;
    listBranches(context: {
      workspaceId: string;
      repository: RepositoryInspection;
      signal: AbortSignal;
    }): Promise<Array<{ name: string }>>;
    inspectURL(context: {
      workspaceId: string;
      url: string;
      signal: AbortSignal;
    }): Promise<RepositoryInspection | null>;
    supportsDraft?: boolean;
    createChangeRequest?(context: {
      workspaceId: string;
      taskId: string;
      sessionId: string;
      repositoryId: string;
      repository: PluginHostRepository;
      title: string;
      body: string;
      baseBranch?: string;
      draft: boolean;
      signal: AbortSignal;
    }): Promise<{
      url: string;
      provider?: string;
      output?: string;
      linked?: boolean;
      associationError?: string;
    }>;
  }): void;
  registerTaskAction(action: {
    id: string;
    label: string;
    icon: string;
    placement: "link";
    visible?(context: TaskContext): boolean;
    run(context: TaskContext): Promise<void>;
  }): void;
  registerReviewProvider(provider: {
    id: string;
    label: string;
    icon: string;
    changeRequestNoun: string;
    order: number;
    getSnapshot(taskId: string): readonly ReviewSummary[];
    subscribe(taskId: string, listener: () => void): () => void;
    refresh(taskId: string, signal: AbortSignal): Promise<void>;
    getAssociationSnapshot?(
      workspaceId: string,
    ): readonly ReviewTaskAssociation[];
    subscribeAssociations?(
      workspaceId: string,
      listener: () => void,
    ): () => void;
    refreshAssociations?(
      workspaceId: string,
      signal: AbortSignal,
    ): Promise<void>;
    unlink?(context: {
      workspaceId: string;
      taskId: string;
      reviewKey: string;
      signal: AbortSignal;
    }): Promise<void>;
    ReviewPanel: Component;
  }): void;
};

export type QueryState<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  lastFetchedAt: Date | null;
  refresh(): void;
};

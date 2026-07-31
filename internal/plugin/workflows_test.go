package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"kandev-plugin-bitbucket/internal/domain"

	"github.com/kandev/kandev/pkg/pluginsdk"
	"github.com/stretchr/testify/require"
)

func TestDecodeActionRejectsTrailingJSONValue(t *testing.T) {
	var input listRepositoriesInput
	err := decodeAction([]byte(`{"query":"first"}{"query":"second"}`), &input)

	require.Error(t, err)
	require.Contains(t, err.Error(), "invalid action body")
}

func TestWorkflows_QueueAndComposerAuthorizeLivePullRequest(t *testing.T) {
	provider := &workflowProvider{pullRequest: testPullRequest()}
	workflows, err := NewWorkflows(newConnectionHost(), staticResolver{provider: provider})
	require.NoError(t, err)

	response, err := workflows.HandleAction(context.Background(), &pluginsdk.PluginActionRequest{
		ActionKey: "pullrequests.queue", Context: pluginsdk.VerifiedActionContext{WorkspaceID: "workspace-1"}, Body: []byte(`{"query":"fix","state":"OPEN"}`),
	})
	require.NoError(t, err)
	var queue struct {
		PullRequests []map[string]any `json:"pull_requests"`
	}
	require.NoError(t, json.Unmarshal(response.Body, &queue))
	require.Len(t, queue.PullRequests, 1)
	require.Equal(t, "workspace/repo#42", queue.PullRequests[0]["review_key"])
	require.Contains(t, queue.PullRequests[0]["capabilities"], "launch_task")
	require.Len(t, provider.searchQueries, 1)
	require.Equal(t, "OPEN", provider.searchQueries[0].State)

	search, err := workflows.SearchEntityReferences(context.Background(), &pluginsdk.SearchEntityReferencesRequest{Source: "bitbucket", WorkspaceID: "workspace-1", Query: "fix", Limit: 10})
	require.NoError(t, err)
	require.Len(t, search.Candidates, 1)
	authorized, err := workflows.AuthorizeEntityReference(context.Background(), &pluginsdk.AuthorizeEntityReferenceRequest{
		Source: "bitbucket", WorkspaceID: "workspace-1", Purpose: "submission", Reference: search.Candidates[0].Attributes,
	})
	require.NoError(t, err)
	require.True(t, authorized.Allowed)

	tampered := map[string]any{"key": "workspace/repo#99", "repository": map[string]any{"namespace": "workspace", "slug": "repo"}, "number": 99}
	authorized, err = workflows.AuthorizeEntityReference(context.Background(), &pluginsdk.AuthorizeEntityReferenceRequest{Source: "bitbucket", WorkspaceID: "workspace-1", Purpose: "submission", Reference: tampered})
	require.NoError(t, err)
	require.False(t, authorized.Allowed)
}

func TestPullRequestViewIncludesCanonicalAuthor(t *testing.T) {
	pullRequest := testPullRequest()
	pullRequest.Author = "cloud-account-ada"
	require.Equal(t, "cloud-account-ada", pullRequestView(pullRequest)["author"])
}

func TestWorkflows_LinkAndUnlinkDoNotDeleteTask(t *testing.T) {
	provider := &workflowProvider{pullRequest: testPullRequest()}
	host := newConnectionHost()
	workflows, err := NewWorkflows(host, staticResolver{provider: provider})
	require.NoError(t, err)

	link, err := workflows.HandleAction(context.Background(), &pluginsdk.PluginActionRequest{
		ActionKey: "pullrequests.link", Context: pluginsdk.VerifiedActionContext{WorkspaceID: "workspace-1", TaskID: "manual-task"}, Body: []byte(`{"review_key":"workspace/repo#42"}`),
	})
	require.NoError(t, err)
	require.Contains(t, string(link.Body), "workspace/repo#42")
	_, err = workflows.HandleAction(context.Background(), &pluginsdk.PluginActionRequest{
		ActionKey: "pullrequests.unlink", Context: pluginsdk.VerifiedActionContext{WorkspaceID: "workspace-1", TaskID: "manual-task"}, Body: []byte(`{"review_key":"workspace/repo#42"}`),
	})
	require.NoError(t, err)
	require.Empty(t, host.secrets, "links must not perform task or secret cleanup")

	response, err := workflows.HandleAction(context.Background(), &pluginsdk.PluginActionRequest{
		ActionKey: "pullrequests.get", Context: pluginsdk.VerifiedActionContext{WorkspaceID: "workspace-1", TaskID: "manual-task"}, Body: []byte(`{"view":"task"}`),
	})
	require.NoError(t, err)
	require.JSONEq(t, `{"pull_requests":[]}`, string(response.Body))
}

func TestWorkflows_TaskLinkDoesNotRetargetAfterDataCenterHostChanges(t *testing.T) {
	pullRequest := testPullRequest()
	pullRequest.Repository = domain.Repository{Namespace: "ENG", Slug: "repo"}
	pullRequest.Number = 42
	pullRequest.URL = "https://bitbucket-one.example.test/projects/ENG/repos/repo/pull-requests/42"
	provider := &workflowProvider{pullRequest: pullRequest}
	resolver := &connectionSettingsResolver{
		staticResolver: staticResolver{provider: provider},
		settings:       ConnectionSettings{Product: domain.ProductDataCenter, BaseURL: "https://bitbucket-one.example.test"},
		found:          true,
	}
	workflows, err := NewWorkflows(newConnectionHost(), resolver)
	require.NoError(t, err)

	_, err = workflows.HandleAction(context.Background(), &pluginsdk.PluginActionRequest{
		ActionKey: "pullrequests.link", Context: pluginsdk.VerifiedActionContext{WorkspaceID: "workspace-1", TaskID: "task-1"}, Body: []byte(`{"review_key":"ENG/repo#42"}`),
	})
	require.NoError(t, err)
	provider.getPullRequestCalls = 0
	resolver.settings.BaseURL = "https://bitbucket-two.example.test"

	response, err := workflows.HandleAction(context.Background(), &pluginsdk.PluginActionRequest{
		ActionKey: "pullrequests.get", Context: pluginsdk.VerifiedActionContext{WorkspaceID: "workspace-1", TaskID: "task-1"}, Body: []byte(`{"view":"task"}`),
	})
	require.NoError(t, err)
	require.JSONEq(t, `{"pull_requests":[],"unavailable_pull_requests":[{"key":"ENG/repo#42","reason":"connection_changed"}]}`, string(response.Body))
	require.Zero(t, provider.getPullRequestCalls, "a link must not be fetched from a new Bitbucket host")
}

func TestWorkflows_HidesProviderSecretsFromCredentialRPC(t *testing.T) {
	provider := &workflowProvider{credentialErr: errors.New("provider rejected top-secret-token")}
	workflows, err := NewWorkflows(newConnectionHost(), staticResolver{provider: provider})
	require.NoError(t, err)
	_, err = workflows.ResolveGitCredential(context.Background(), &pluginsdk.ResolveGitCredentialRequest{ProviderID: "bitbucket", WorkspaceID: "workspace-1", TaskID: "task", SessionID: "session", RepositoryID: "repo", Host: "bitbucket.org", Path: "/workspace/repo.git"})
	require.ErrorIs(t, err, ErrCredentialUnavailable)
	require.NotContains(t, err.Error(), "top-secret-token")
}

func TestWorkflows_UsesConnectionBindingWithoutResolvingProviderCredential(t *testing.T) {
	provider := &workflowProvider{credentialErr: errors.New("credential must not be resolved")}
	workflows, err := NewWorkflows(newConnectionHost(), staticResolver{provider: provider, binding: "connection:9"})
	require.NoError(t, err)

	response, err := workflows.GetGitCredentialBinding(context.Background(), &pluginsdk.GitCredentialBindingRequest{
		ProviderID: "bitbucket", WorkspaceID: "workspace-1", TaskID: "task", SessionID: "session", RepositoryID: "repo", Host: "bitbucket.org", Path: "/workspace/repo.git",
	})

	require.NoError(t, err)
	require.Equal(t, "connection:9", response.Binding)
}

func TestWorkflows_RejectsUnsupportedReviewMutationBeforeProviderCall(t *testing.T) {
	provider := &workflowProvider{pullRequest: testPullRequest(), capabilities: domain.Capabilities{domain.CapabilityPullRequests: true}}
	workflows, err := NewWorkflows(newConnectionHost(), staticResolver{provider: provider})
	require.NoError(t, err)

	_, err = workflows.HandleAction(context.Background(), &pluginsdk.PluginActionRequest{
		ActionKey: "pullrequests.update", Context: pluginsdk.VerifiedActionContext{WorkspaceID: "workspace-1"}, Body: []byte(`{"review_key":"workspace/repo#42","operation":"merge"}`),
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "does not support merge")
	require.Zero(t, provider.actions)
}

func TestWorkflows_RejectsCredentialBearingRepositoryInspectionURL(t *testing.T) {
	workflows, err := NewWorkflows(newConnectionHost(), staticResolver{provider: &workflowProvider{pullRequest: testPullRequest()}})
	require.NoError(t, err)
	_, err = workflows.HandleAction(context.Background(), &pluginsdk.PluginActionRequest{
		ActionKey: "repositories.inspect", Context: pluginsdk.VerifiedActionContext{WorkspaceID: "workspace-1"}, Body: []byte(`{"url":"https://secret-token@bitbucket.org/workspace/repo.git"}`),
	})
	require.Error(t, err)
	require.NotContains(t, err.Error(), "secret-token")
}

func TestWorkflows_UsesProviderURLInspectors(t *testing.T) {
	provider := &workflowProvider{pullRequest: testPullRequest()}
	workflows, err := NewWorkflows(newConnectionHost(), staticResolver{provider: provider})
	require.NoError(t, err)

	_, err = workflows.HandleAction(context.Background(), &pluginsdk.PluginActionRequest{
		ActionKey: "repositories.inspect", Context: pluginsdk.VerifiedActionContext{WorkspaceID: "workspace-1"}, Body: []byte(`{"url":"https://bitbucket.org/workspace/repo"}`),
	})
	require.NoError(t, err)
	require.Equal(t, "https://bitbucket.org/workspace/repo", provider.inspectedRepositoryURL)

	response, err := workflows.HandleAction(context.Background(), &pluginsdk.PluginActionRequest{
		ActionKey: "pullrequests.inspect", Context: pluginsdk.VerifiedActionContext{WorkspaceID: "workspace-1"}, Body: []byte(`{"review_key":"https://bitbucket.org/workspace/repo/pull-requests/42"}`),
	})
	require.NoError(t, err)
	require.Equal(t, "https://bitbucket.org/workspace/repo/pull-requests/42", provider.inspectedPullRequestURL)
	require.Contains(t, string(response.Body), "workspace/repo#42")
}

func TestWorkflows_RepositoryInspectionFetchesPullRequestURLMetadata(t *testing.T) {
	pullRequest := testPullRequest()
	pullRequest.Source = domain.Branch{Name: "feature/fix-auth"}
	pullRequest.Destination = domain.Branch{Name: "main"}
	provider := &workflowProvider{pullRequest: pullRequest, repositoryInspectErr: errors.New("not a repository URL")}
	workflows, err := NewWorkflows(newConnectionHost(), staticResolver{provider: provider})
	require.NoError(t, err)

	response, err := workflows.HandleAction(context.Background(), &pluginsdk.PluginActionRequest{
		ActionKey: "repositories.inspect", Context: pluginsdk.VerifiedActionContext{WorkspaceID: "workspace-1"}, Body: []byte(`{"url":"https://bitbucket.org/workspace/repo/pull-requests/42"}`),
	})
	require.NoError(t, err)
	require.Equal(t, "https://bitbucket.org/workspace/repo/pull-requests/42", provider.inspectedRepositoryURL)
	require.Equal(t, "https://bitbucket.org/workspace/repo/pull-requests/42", provider.inspectedPullRequestURL)
	require.Equal(t, 1, provider.getPullRequestCalls)

	var result struct {
		Repository  map[string]any `json:"repository"`
		PullRequest map[string]any `json:"pull_request"`
		BaseBranch  string         `json:"base_branch"`
		HeadBranch  string         `json:"head_branch"`
	}
	require.NoError(t, json.Unmarshal(response.Body, &result))
	require.Equal(t, "workspace/repo", result.Repository["id"])
	require.Equal(t, "main", result.BaseBranch)
	require.Equal(t, "feature/fix-auth", result.HeadBranch)
	require.Equal(t, "main", result.Repository["base_branch"])
	require.Equal(t, "feature/fix-auth", result.Repository["head_branch"])
	require.Equal(t, "workspace/repo#42", result.PullRequest["review_key"])
	require.Equal(t, float64(42), result.PullRequest["number"])
	require.Equal(t, "Fix auth", result.PullRequest["title"])
	require.Equal(t, "https://bitbucket.org/workspace/repo/pull-requests/42", result.PullRequest["url"])
}

func TestWorkflows_CreatePullRequestDerivesRepositoryAndSourceFromVerifiedTask(t *testing.T) {
	host := newTaskHost()
	host.tasks.task = &pluginsdk.Task{
		ID: "task-1", WorkspaceID: "workspace-1", Title: "Host task title", Description: "Host task description",
		Repositories: []pluginsdk.TaskRepository{{RepositoryID: "repository-1", BaseBranch: "main", CheckoutBranch: "refs/heads/fix-auth"}},
	}
	defaultBranch := "main"
	host.repositories.repositories = []pluginsdk.Repository{{
		ID: "repository-1", WorkspaceID: "workspace-1", Name: "repo", SourceType: "provider", ProviderID: "bitbucket",
		ProviderHost: "bitbucket.org", OwnerOrProject: "workspace", ProviderRepositoryID: "repo-uuid",
		RemoteURL: "https://bitbucket.org/workspace/repo.git", DefaultBranch: &defaultBranch,
	}}
	provider := &workflowProvider{pullRequest: testPullRequest()}
	workflows, err := NewWorkflows(host, staticResolver{provider: provider})
	require.NoError(t, err)

	_, err = workflows.HandleAction(context.Background(), &pluginsdk.PluginActionRequest{
		ActionKey: "pullrequests.create", Context: pluginsdk.VerifiedActionContext{WorkspaceID: "workspace-1", TaskID: "task-1"},
		Body: []byte(`{"title":"Override title","destination":"release"}`),
	})
	require.NoError(t, err)
	require.Equal(t, "workspace", provider.createdPullRequest.Repository.Namespace)
	require.Equal(t, "repo", provider.createdPullRequest.Repository.Slug)
	require.Equal(t, "https://bitbucket.org/workspace/repo.git", provider.createdPullRequest.Repository.CloneURL.String())
	require.Equal(t, "Override title", provider.createdPullRequest.Title)
	require.Equal(t, "Host task description", provider.createdPullRequest.Description)
	require.Equal(t, "fix-auth", provider.createdPullRequest.Source)
	require.Equal(t, "release", provider.createdPullRequest.Destination)

	_, err = workflows.HandleAction(context.Background(), &pluginsdk.PluginActionRequest{
		ActionKey: "pullrequests.create", Context: pluginsdk.VerifiedActionContext{WorkspaceID: "workspace-1", TaskID: "task-1"},
		Body: []byte(`{"source":"attacker-branch"}`),
	})
	require.Error(t, err, "browser input cannot select a source checkout")
}

func TestWorkflows_CreatePullRequestRejectsManualRepositoryWithBitbucketFields(t *testing.T) {
	host := newTaskHost()
	host.tasks.task = &pluginsdk.Task{
		ID: "task-1", WorkspaceID: "workspace-1", Title: "Host task",
		Repositories: []pluginsdk.TaskRepository{{RepositoryID: "repository-1", BaseBranch: "main", CheckoutBranch: "feature"}},
	}
	host.repositories.repositories = []pluginsdk.Repository{{
		ID: "repository-1", WorkspaceID: "workspace-1", Name: "repo", SourceType: "manual", ProviderID: "bitbucket",
		ProviderHost: "bitbucket.org", OwnerOrProject: "workspace", ProviderRepositoryID: "repo-uuid",
		RemoteURL: "https://bitbucket.org/workspace/repo.git",
	}}
	workflows, err := NewWorkflows(host, staticResolver{provider: &workflowProvider{pullRequest: testPullRequest()}})
	require.NoError(t, err)

	_, err = workflows.HandleAction(context.Background(), &pluginsdk.PluginActionRequest{
		ActionKey: "pullrequests.create", Context: pluginsdk.VerifiedActionContext{WorkspaceID: "workspace-1", TaskID: "task-1"}, Body: []byte(`{}`),
	})
	require.Error(t, err)
}

func TestWorkflows_LaunchAppliesNamedPreset(t *testing.T) {
	host := newTaskHost()
	pullRequest := testPullRequest()
	pullRequest.Repository.CloneURL = mustURL(t, "https://bitbucket.org/workspace/repo.git")
	workflows, err := NewWorkflows(host, staticResolver{provider: &workflowProvider{pullRequest: pullRequest}})
	require.NoError(t, err)

	_, err = workflows.HandleAction(context.Background(), &pluginsdk.PluginActionRequest{
		ActionKey: "pullrequests.launch", Context: pluginsdk.VerifiedActionContext{WorkspaceID: "workspace-1"},
		Body: []byte(`{"review_key":"workspace/repo#42","preset":"review"}`),
	})
	require.NoError(t, err)
	require.NotNil(t, host.tasks.created.Launch)
	require.Equal(t, "Review the Bitbucket pull request and run relevant tests.", *host.tasks.created.Launch.Prompt)
}

func TestReviewView_PreservesAdapterFiles(t *testing.T) {
	view := reviewView(domain.Review{
		PullRequest: testPullRequest(),
		Files: []domain.ReviewFile{{
			Path: "internal/auth.go", Status: "modified", Additions: 4, Deletions: 1, Patch: "@@ -1 +1 @@",
		}},
	})

	files, ok := view["files"].([]map[string]any)
	require.True(t, ok)
	require.Equal(t, []map[string]any{{
		"path": "internal/auth.go", "status": "modified", "additions": 4, "deletions": 1, "patch": "@@ -1 +1 @@",
	}}, files)
}

func testPullRequest() domain.PullRequest {
	return domain.PullRequest{
		Repository: domain.Repository{Namespace: "workspace", Slug: "repo"}, Number: 42, Title: "Fix auth", State: "OPEN", URL: "https://bitbucket.org/workspace/repo/pull-requests/42",
		Capabilities: domain.Capabilities{domain.CapabilityPullRequests: true, domain.CapabilityReview: true, domain.CapabilityMerge: true},
	}
}

type staticResolver struct {
	provider domain.Provider
	err      error
	binding  string
}

type connectionSettingsResolver struct {
	staticResolver
	settings ConnectionSettings
	found    bool
}

func (r *connectionSettingsResolver) Load(context.Context, string) (ConnectionSettings, bool, error) {
	return r.settings, r.found, nil
}

func (r staticResolver) Provider(context.Context, string) (domain.Provider, error) {
	return r.provider, r.err
}

func (r staticResolver) GitCredentialBinding(context.Context, GitCredentialScope) (string, error) {
	if r.binding == "" {
		return "", ErrCredentialUnavailable
	}
	return r.binding, nil
}

type workflowProvider struct {
	pullRequest             domain.PullRequest
	capabilities            domain.Capabilities
	credentialErr           error
	healthErr               error
	actions                 int
	createdPullRequest      domain.CreatePullRequestInput
	inspectedRepositoryURL  string
	inspectedPullRequestURL string
	repositoryInspectErr    error
	getPullRequestCalls     int
	searchQueries           []domain.PullRequestQuery
}

func (p *workflowProvider) Capabilities() domain.Capabilities {
	if p.capabilities != nil {
		return p.capabilities
	}
	return domain.Capabilities{domain.CapabilityPullRequests: true, domain.CapabilityBranches: true, domain.CapabilityReview: true, domain.CapabilityMerge: true}
}
func (p *workflowProvider) ListRepositories(context.Context, string, int) ([]domain.Repository, error) {
	return []domain.Repository{p.pullRequest.Repository}, nil
}
func (p *workflowProvider) InspectRepositoryURL(raw string) (domain.Repository, error) {
	p.inspectedRepositoryURL = raw
	if p.repositoryInspectErr != nil {
		return domain.Repository{}, p.repositoryInspectErr
	}
	return p.pullRequest.Repository, nil
}
func (p *workflowProvider) InspectPullRequestURL(raw string) (domain.PullRequestLocator, error) {
	p.inspectedPullRequestURL = raw
	return domain.PullRequestLocator{Repository: p.pullRequest.Repository, Number: p.pullRequest.Number}, nil
}
func (*workflowProvider) ListBranches(context.Context, domain.Repository) ([]domain.Branch, error) {
	return nil, nil
}
func (p *workflowProvider) SearchPullRequests(_ context.Context, query domain.PullRequestQuery) ([]domain.PullRequest, error) {
	p.searchQueries = append(p.searchQueries, query)
	return []domain.PullRequest{p.pullRequest}, nil
}
func (p *workflowProvider) SearchPullRequestsPage(ctx context.Context, query domain.PullRequestQuery) (domain.PullRequestPage, error) {
	pullRequests, err := p.SearchPullRequests(ctx, query)
	return domain.PullRequestPage{PullRequests: pullRequests}, err
}
func (p *workflowProvider) GetPullRequest(_ context.Context, repository domain.Repository, number int) (domain.PullRequest, error) {
	p.getPullRequestCalls++
	if repository.Namespace != p.pullRequest.Repository.Namespace || repository.Slug != p.pullRequest.Repository.Slug || number != p.pullRequest.Number {
		return domain.PullRequest{}, errors.New("not found")
	}
	return p.pullRequest, nil
}
func (p *workflowProvider) CreatePullRequest(_ context.Context, input domain.CreatePullRequestInput) (domain.PullRequest, error) {
	p.createdPullRequest = input
	return p.pullRequest, nil
}
func (p *workflowProvider) GetReview(context.Context, domain.Repository, int) (domain.Review, error) {
	return domain.Review{PullRequest: p.pullRequest}, nil
}
func (p *workflowProvider) ApplyReviewAction(context.Context, domain.PullRequest, domain.ReviewAction) (domain.PullRequest, error) {
	p.actions++
	return p.pullRequest, nil
}
func (p *workflowProvider) Health(context.Context) error { return p.healthErr }
func (p *workflowProvider) ResolveGitCredential(context.Context) (domain.GitCredential, error) {
	return domain.GitCredential{}, p.credentialErr
}

package auth

// Role-based access control, the same table as server/auth/permissions.ts. Pure functions only.
//
//   - Every workspace member has a workspace role (viewer < editor < admin).
//   - A notebook (collection) can override a member's role up or down.
//   - Workspace admins are always admins of every notebook.

type Role string

const (
	Viewer Role = "viewer"
	Editor Role = "editor"
	Admin  Role = "admin"
)

func (r Role) Valid() bool { return r == Viewer || r == Editor || r == Admin }

func rank(r Role) int {
	switch r {
	case Viewer:
		return 0
	case Editor:
		return 1
	case Admin:
		return 2
	}
	return -1
}

type Permission string

const (
	WorkspaceView       Permission = "workspace.view"
	WorkspaceManage     Permission = "workspace.manage"
	MembersManage       Permission = "members.manage"
	AnalyticsWorkspace  Permission = "analytics.workspace"
	EvaluationManage    Permission = "evaluation.manage"
	CollectionCreate    Permission = "collection.create"
	CollectionView      Permission = "collection.view"
	CollectionSearch    Permission = "collection.search"
	CollectionIngest    Permission = "collection.ingest"
	CollectionEditChunk Permission = "collection.editChunks"
	CollectionManage    Permission = "collection.manage"
	ReportsCreate       Permission = "reports.create"
	ImagesCreate        Permission = "images.create"
	AudioCreate         Permission = "audio.create"
	MindmapsCreate      Permission = "mindmaps.create"
	ConnectorsUse       Permission = "connectors.use"
	SharesCreate        Permission = "shares.create"
	IntegrationsManage  Permission = "integrations.manage"
)

type rule struct {
	minimum Role
	message string
}

var permissions = map[Permission]rule{
	WorkspaceView:       {Viewer, "You are not a member of this workspace."},
	WorkspaceManage:     {Admin, "Only workspace admins can change workspace settings."},
	MembersManage:       {Admin, "Only workspace admins can manage members."},
	AnalyticsWorkspace:  {Admin, "Only workspace admins can see workspace-wide analytics."},
	EvaluationManage:    {Editor, "You need Editor access to manage evaluation benchmarks."},
	CollectionCreate:    {Editor, "You need Editor access to create notebooks."},
	CollectionView:      {Viewer, "You do not have access to this notebook."},
	CollectionSearch:    {Viewer, "You do not have access to this notebook."},
	CollectionIngest:    {Editor, "You need Editor access to this notebook to add sources."},
	CollectionEditChunk: {Editor, "You need Editor access to this notebook to change its content."},
	CollectionManage:    {Admin, "You need Admin access to this notebook."},
	ReportsCreate:       {Viewer, "You do not have access to these sources."},
	ImagesCreate:        {Viewer, "You do not have access to these sources."},
	AudioCreate:         {Viewer, "You do not have access to these sources."},
	MindmapsCreate:      {Viewer, "You do not have access to these sources."},
	ConnectorsUse:       {Editor, "You need Editor access to connect apps and import from them."},
	SharesCreate:        {Editor, "You need Editor access to share links outside the workspace."},
	IntegrationsManage:  {Admin, "Only workspace admins can connect Slack."},
}

// guestPermissions: demo visitors look around and ask questions; nothing else.
var guestPermissions = map[Permission]bool{WorkspaceView: true, CollectionView: true, CollectionSearch: true}

// GuestDeniedMessage is shown when a demo visitor tries anything else.
const GuestDeniedMessage = "This is a read-only demo. Sign in with your own account to do this."

func HasRole(actual, required Role) bool {
	return actual.Valid() && rank(actual) >= rank(required)
}

// Can reports whether a role grants a permission. Unknown permissions are never granted.
func Can(role Role, permission Permission) bool {
	r, ok := permissions[permission]
	return ok && HasRole(role, r.minimum)
}

func GuestCan(permission Permission) bool { return guestPermissions[permission] }

func PermissionMessage(permission Permission) string { return permissions[permission].message }

// EffectiveCollectionRole: admin wins, then an explicit override, then the workspace role.
// The empty role means "no role".
func EffectiveCollectionRole(workspaceRole Role, override *Role) Role {
	if !workspaceRole.Valid() {
		return ""
	}
	if workspaceRole == Admin {
		return Admin
	}
	if override != nil && override.Valid() {
		return *override
	}
	return workspaceRole
}

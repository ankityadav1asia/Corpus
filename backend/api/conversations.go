package api

import (
	"context"
	"fmt"

	"github.com/ankityadav1asia/Corpus/backend/apperr"
	"github.com/ankityadav1asia/Corpus/backend/auth"
	"github.com/ankityadav1asia/Corpus/backend/httpx"
	"github.com/ankityadav1asia/Corpus/backend/jsstr"
	"github.com/ankityadav1asia/Corpus/backend/store"
)

// Group 3: conversations, answer feedback, notifications and usage analytics. The TypeScript
// originals are app/api/{conversations,messages/[id]/feedback,notifications,analytics}. Asking
// (POST /api/chat) and follow-up suggestions call the AI models and stay in TypeScript.

// ConversationStore is what these routes need from the database (implemented by *store.Store).
type ConversationStore interface {
	ListConversations(ctx context.Context, workspaceID, ownerID string, limit int) ([]store.Conversation, error)
	SearchConversations(ctx context.Context, workspaceID, ownerID, query string, limit int) ([]store.Conversation, error)
	GetConversation(ctx context.Context, workspaceID, ownerID, id string) (*store.Conversation, error)
	RenameConversation(ctx context.Context, workspaceID, ownerID, id, title string) (*store.Conversation, error)
	PinConversation(ctx context.Context, workspaceID, ownerID, id string, pinned bool) (*store.Conversation, error)
	DeleteConversation(ctx context.Context, workspaceID, ownerID, id string) (bool, error)
	BranchConversation(ctx context.Context, workspaceID, ownerID, conversationID, messageID string) (string, error)
	Messages(ctx context.Context, conversationID, viewerID string) ([]store.Message, error)
	MessageContext(ctx context.Context, messageID string) (*store.MessageContext, error)
	SetFeedback(ctx context.Context, messageID, userID, workspaceID string, rating int, comment *string) error
	RemoveFeedback(ctx context.Context, messageID, userID string) error
	Notifications(ctx context.Context, userID string, limit int) ([]store.NotificationItem, int, error)
	MarkNotificationsRead(ctx context.Context, userID string, ids []string, all bool) (int, error)
	AnalyticsSummary(ctx context.Context, workspaceID, ownerID string) (*store.Analytics, error)
}

// Limits from lib/constants.ts and the TypeScript routes.
const (
	conversationsListed   = 100
	conversationsSearched = 50
	searchChars           = 200
	conversationTitle     = 200
	feedbackCommentChars  = 1000
	feedbackPerHour       = 300
	smallBodyLimit        = 8 * 1024
	notificationsListed   = 30
	notificationIDsMax    = 100
)

// conversationsOnly: these routes need the conversation part of the store.
func (s *Server) conversationsOnly(run handler) handler {
	return func(req *request) error {
		if s.chats == nil {
			return apperr.NotConfigured("Server is missing required configuration: POSTGRES_URL")
		}
		return run(req)
	}
}

// ── /api/conversations ───────────────────────────────────────────────────

// listConversations: the caller's own threads in the workspace; ?q= searches titles and message
// text instead.
func (s *Server) listConversations(req *request) error {
	q := jsstr.Trim(req.r.URL.Query().Get("q"))
	if jsstr.Len(q) > searchChars {
		return apperr.Validation([]apperr.Issue{{Path: "q", Message: fmt.Sprintf("Too big: expected string to have <=%d characters", searchChars)}})
	}
	ctx := req.r.Context()
	var list []store.Conversation
	var err error
	if q != "" {
		list, err = s.chats.SearchConversations(ctx, req.access.WorkspaceID, req.access.UserID, q, conversationsSearched)
	} else {
		list, err = s.chats.ListConversations(ctx, req.access.WorkspaceID, req.access.UserID, conversationsListed)
	}
	if err != nil {
		return err
	}
	return req.json(200, map[string]any{"conversations": list})
}

func (s *Server) ownConversation(req *request) (*store.Conversation, error) {
	id, err := pathID(req.r.PathValue("id"))
	if err != nil {
		return nil, err
	}
	conversation, err := s.chats.GetConversation(req.r.Context(), req.access.WorkspaceID, req.access.UserID, id)
	if err != nil {
		return nil, err
	}
	if conversation == nil {
		return nil, apperr.NotFound("Conversation")
	}
	return conversation, nil
}

// conversationDetail: the conversation and its messages, with scores and the caller's ratings.
func (s *Server) conversationDetail(req *request) error {
	conversation, err := s.ownConversation(req)
	if err != nil {
		return err
	}
	ctx := req.r.Context()
	messages, err := s.chats.Messages(ctx, conversation.ID, req.access.UserID)
	if err != nil {
		return err
	}
	// The client polls this for quality scores: run the latest answer's queued evaluation now.
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i].Role != "assistant" {
			continue
		}
		if messages[i].Evaluation == nil && s.evaluatePending(metered(ctx, req.access, "evaluate_answer"), messages[i].ID) {
			if messages, err = s.chats.Messages(ctx, conversation.ID, req.access.UserID); err != nil {
				return err
			}
		}
		break
	}
	return req.json(200, map[string]any{"conversation": conversation, "messages": messages})
}

// updateConversation renames and/or pins (pinned conversations are listed first).
func (s *Server) updateConversation(req *request) error {
	id, err := pathID(req.r.PathValue("id"))
	if err != nil {
		return err
	}
	body, err := httpx.ReadJSON(req.r, httpx.DefaultJSONLimit)
	if err != nil {
		return err
	}
	object, err := httpx.Object(body)
	if err != nil {
		return err
	}
	var issues []apperr.Issue
	var title string
	_, hasTitle := object["title"]
	if hasTitle {
		var issue *apperr.Issue
		if title, issue = httpx.RequiredText(object, "title", conversationTitle); issue != nil {
			issues = append(issues, *issue)
		}
	}
	rawPinned, hasPinned := object["pinned"]
	pinned, ok := rawPinned.(bool)
	if hasPinned && !ok {
		issues = append(issues, apperr.Issue{Path: "pinned", Message: "Invalid input: expected boolean, received " + jsonType(rawPinned)})
	}
	if len(issues) > 0 {
		return apperr.Validation(issues)
	}
	if !hasTitle && !hasPinned {
		return apperr.Validation([]apperr.Issue{{Path: "", Message: "Nothing to update"}})
	}
	ctx := req.r.Context()
	conversation, err := s.chats.GetConversation(ctx, req.access.WorkspaceID, req.access.UserID, id)
	if err != nil {
		return err
	}
	if conversation != nil && hasTitle {
		if conversation, err = s.chats.RenameConversation(ctx, req.access.WorkspaceID, req.access.UserID, id, title); err != nil {
			return err
		}
	}
	if conversation != nil && hasPinned {
		if conversation, err = s.chats.PinConversation(ctx, req.access.WorkspaceID, req.access.UserID, id, pinned); err != nil {
			return err
		}
	}
	if conversation == nil {
		return apperr.NotFound("Conversation")
	}
	return req.json(200, map[string]any{"conversation": conversation})
}

func (s *Server) deleteConversation(req *request) error {
	id, err := pathID(req.r.PathValue("id"))
	if err != nil {
		return err
	}
	deleted, err := s.chats.DeleteConversation(req.r.Context(), req.access.WorkspaceID, req.access.UserID, id)
	if err != nil {
		return err
	}
	if !deleted {
		return apperr.NotFound("Conversation")
	}
	return req.json(200, map[string]any{"ok": true})
}

// branchConversation forks the thread at messageId into a new conversation (copied server-side).
func (s *Server) branchConversation(req *request) error {
	id, err := pathID(req.r.PathValue("id"))
	if err != nil {
		return err
	}
	body, err := httpx.ReadJSON(req.r, httpx.DefaultJSONLimit)
	if err != nil {
		return err
	}
	object, err := httpx.Object(body)
	if err != nil {
		return err
	}
	messageID, issue := guidField(object, "messageId")
	if issue != nil {
		return apperr.Validation([]apperr.Issue{*issue})
	}
	created, err := s.chats.BranchConversation(req.r.Context(), req.access.WorkspaceID, req.access.UserID, id, messageID)
	if err != nil {
		return err
	}
	if created == "" {
		return apperr.NotFound("Message")
	}
	return req.json(201, map[string]any{"conversationId": created})
}

// guidField is a required z.guid() field.
func guidField(object map[string]any, name string) (string, *apperr.Issue) {
	raw, present := object[name]
	text, ok := raw.(string)
	if !present || !ok {
		received := "undefined"
		if present {
			received = jsonType(raw)
		}
		return "", &apperr.Issue{Path: name, Message: "Invalid input: expected string, received " + received}
	}
	if !httpx.IsID(text) {
		return "", &apperr.Issue{Path: name, Message: "Invalid GUID"}
	}
	return text, nil
}

// ── /api/messages/:id/feedback ───────────────────────────────────────────

// rateAnswer: 1 helpful, -1 not helpful, 0 clears. Only the conversation's author rates its answers.
func (s *Server) rateAnswer(req *request) error {
	id, err := pathID(req.r.PathValue("id"))
	if err != nil {
		return err
	}
	body, err := httpx.ReadJSON(req.r, smallBodyLimit)
	if err != nil {
		return err
	}
	object, err := httpx.Object(body)
	if err != nil {
		return err
	}
	var issues []apperr.Issue
	rating, isNumber := object["rating"].(float64)
	if !isNumber || (rating != 1 && rating != -1 && rating != 0) {
		issues = append(issues, apperr.Issue{Path: "rating", Message: "Invalid input"})
	}
	var comment *string
	if raw, present := object["comment"]; present {
		text, ok := raw.(string)
		switch {
		case !ok:
			issues = append(issues, apperr.Issue{Path: "comment", Message: "Invalid input: expected string, received " + jsonType(raw)})
		case jsstr.Len(jsstr.Trim(text)) > feedbackCommentChars:
			issues = append(issues, apperr.Issue{Path: "comment", Message: fmt.Sprintf("Too big: expected string to have <=%d characters", feedbackCommentChars)})
		default:
			if trimmed := jsstr.Trim(text); trimmed != "" {
				comment = &trimmed
			}
		}
	}
	if len(issues) > 0 {
		return apperr.Validation(issues)
	}
	ctx := req.r.Context()
	if s.admin != nil {
		if err := s.rateLimit(ctx, "feedback:user:"+req.access.UserID, feedbackPerHour, 3600); err != nil {
			return err
		}
	}
	mc, err := s.chats.MessageContext(ctx, id)
	if err != nil {
		return err
	}
	if mc == nil || mc.WorkspaceID != req.access.WorkspaceID || mc.OwnerID != req.access.UserID || mc.Role != "assistant" {
		return apperr.NotFound("Answer")
	}
	if rating == 0 {
		if err := s.chats.RemoveFeedback(ctx, id, req.access.UserID); err != nil {
			return err
		}
		return req.json(200, map[string]any{"feedback": nil})
	}
	if err := s.chats.SetFeedback(ctx, id, req.access.UserID, req.access.WorkspaceID, int(rating), comment); err != nil {
		return err
	}
	return req.json(200, map[string]any{"feedback": store.Feedback{Rating: int(rating), Comment: comment}})
}

// ── /api/notifications ───────────────────────────────────────────────────

func (s *Server) listNotifications(req *request) error {
	items, unread, err := s.chats.Notifications(req.r.Context(), req.user.ID, notificationsListed)
	if err != nil {
		return err
	}
	return req.json(200, map[string]any{"items": items, "unread": unread})
}

// markNotificationsRead marks some (ids) or all (all: true) of the caller's notifications read.
func (s *Server) markNotificationsRead(req *request) error {
	body, err := httpx.ReadJSON(req.r, smallBodyLimit)
	if err != nil {
		return err
	}
	object, err := httpx.Object(body)
	if err != nil {
		return err
	}
	var issues []apperr.Issue
	var ids []string
	if raw, present := object["ids"]; present {
		list, ok := raw.([]any)
		switch {
		case !ok:
			issues = append(issues, apperr.Issue{Path: "ids", Message: "Invalid input: expected array, received " + jsonType(raw)})
		case len(list) > notificationIDsMax:
			issues = append(issues, apperr.Issue{Path: "ids", Message: fmt.Sprintf("Too big: expected array to have <=%d items", notificationIDsMax)})
		default:
			for i, item := range list {
				text, isString := item.(string)
				if !isString {
					issues = append(issues, apperr.Issue{Path: fmt.Sprintf("ids.%d", i), Message: "Invalid input: expected string, received " + jsonType(item)})
				} else if !httpx.IsID(text) {
					issues = append(issues, apperr.Issue{Path: fmt.Sprintf("ids.%d", i), Message: "Invalid GUID"})
				} else {
					ids = append(ids, text)
				}
			}
		}
	}
	all := false
	if raw, present := object["all"]; present {
		value, ok := raw.(bool)
		if !ok {
			issues = append(issues, apperr.Issue{Path: "all", Message: "Invalid input: expected boolean, received " + jsonType(raw)})
		}
		all = value
	}
	if len(issues) > 0 {
		return apperr.Validation(issues)
	}
	if !all && len(ids) == 0 {
		return apperr.Validation([]apperr.Issue{{Path: "", Message: "Nothing to mark as read"}})
	}
	updated, err := s.chats.MarkNotificationsRead(req.r.Context(), req.user.ID, ids, all)
	if err != nil {
		return err
	}
	return req.json(200, map[string]any{"updated": updated})
}

// ── /api/analytics ───────────────────────────────────────────────────────

// analytics: your own questions, or (workspace admins, ?scope=workspace) everyone's.
func (s *Server) analytics(req *request) error {
	scope := req.r.URL.Query().Get("scope")
	if scope == "" {
		scope = "me"
	}
	if scope != "me" && scope != "workspace" {
		return apperr.Validation([]apperr.Issue{{Path: "scope", Message: `Invalid option: expected one of "me"|"workspace"`}})
	}
	owner := req.access.UserID
	if scope == "workspace" {
		if err := auth.RequireWorkspacePermission(req.access, auth.AnalyticsWorkspace); err != nil {
			return err
		}
		owner = ""
	}
	summary, err := s.chats.AnalyticsSummary(req.r.Context(), req.access.WorkspaceID, owner)
	if err != nil {
		return err
	}
	return req.json(200, summary)
}

import { EMBEDDING_DIMENSIONS, LIMITS, STUDIO_LIMITS } from '@/lib/constants'

export interface Migration {
  version: number
  name: string
  /** Neon's HTTP driver runs one statement per query, so each migration is a list. */
  statements: string[]
}

/**
 * Versioned, append-only schema history. Never edit a released migration; add a new one.
 *
 * Everything lives in the `app` schema so the tables created by the previous version of
 * the project (public.vectorstore_documents, public.conversations, public.messages, …)
 * are left untouched and can be imported with `npm run db:import-legacy`.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    statements: [
      `CREATE EXTENSION IF NOT EXISTS vector`,

      `CREATE TABLE app.users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email text NOT NULL UNIQUE CHECK (email = lower(email) AND position('@' in email) > 1),
        name text,
        created_at timestamptz NOT NULL DEFAULT now(),
        last_login_at timestamptz
      )`,

      `CREATE TABLE app.collections (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
        name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND ${LIMITS.collectionNameChars}),
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE UNIQUE INDEX collections_owner_name_key ON app.collections (owner_id, lower(name))`,

      `CREATE TABLE app.documents (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
        collection_id uuid NOT NULL REFERENCES app.collections(id) ON DELETE CASCADE,
        source_type text NOT NULL CHECK (source_type IN ('text', 'file', 'url', 'youtube')),
        source text NOT NULL,
        title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND ${LIMITS.documentTitleChars}),
        status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'ready', 'failed')),
        chunk_count integer NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
        char_count integer NOT NULL DEFAULT 0 CHECK (char_count >= 0),
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX documents_owner_collection_idx ON app.documents (owner_id, collection_id, created_at DESC)`,
      `CREATE INDEX documents_source_idx ON app.documents (owner_id, collection_id, source_type, source)`,

      // Exact (sequential) vector search scoped by owner/collection. 3072-dim vectors exceed
      // pgvector's 2000-dim HNSW limit; see docs/ARCHITECTURE.md for the halfvec scaling path.
      `CREATE TABLE app.chunks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        document_id uuid NOT NULL REFERENCES app.documents(id) ON DELETE CASCADE,
        owner_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
        collection_id uuid NOT NULL REFERENCES app.collections(id) ON DELETE CASCADE,
        chunk_index integer NOT NULL CHECK (chunk_index >= 0),
        content text NOT NULL,
        embedding vector(${EMBEDDING_DIMENSIONS}) NOT NULL,
        tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX chunks_owner_collection_idx ON app.chunks (owner_id, collection_id)`,
      `CREATE INDEX chunks_document_idx ON app.chunks (document_id, chunk_index)`,
      `CREATE INDEX chunks_tsv_idx ON app.chunks USING gin (tsv)`,

      `CREATE TABLE app.conversations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
        collection_id uuid REFERENCES app.collections(id) ON DELETE SET NULL,
        parent_id uuid REFERENCES app.conversations(id) ON DELETE SET NULL,
        title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND ${LIMITS.conversationTitleChars}),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX conversations_owner_updated_idx ON app.conversations (owner_id, updated_at DESC)`,

      `CREATE TABLE app.messages (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id uuid NOT NULL REFERENCES app.conversations(id) ON DELETE CASCADE,
        seq bigint GENERATED ALWAYS AS IDENTITY,
        role text NOT NULL CHECK (role IN ('user', 'assistant')),
        content text NOT NULL,
        citations jsonb NOT NULL DEFAULT '[]'::jsonb,
        steps jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX messages_conversation_seq_idx ON app.messages (conversation_id, seq)`,

      `CREATE TABLE app.query_logs (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        owner_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
        collection_id uuid,
        mode text NOT NULL,
        query text NOT NULL,
        latency_ms integer NOT NULL,
        chunks_retrieved integer NOT NULL,
        status text NOT NULL CHECK (status IN ('ok', 'error')),
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX query_logs_owner_created_idx ON app.query_logs (owner_id, created_at DESC)`,

      // One-time sign-in codes are stored hashed (HMAC), never in plain text.
      `CREATE TABLE app.otp_codes (
        email text PRIMARY KEY,
        code_hash text NOT NULL,
        expires_at timestamptz NOT NULL,
        attempts integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,

      // Fixed-window counters shared by every server instance (in-memory maps are per instance).
      `CREATE TABLE app.rate_limits (
        key text PRIMARY KEY,
        window_start timestamptz NOT NULL,
        count integer NOT NULL
      )`,
    ],
  },
  {
    version: 2,
    name: 'workspaces_and_roles',
    statements: [
      // Workspaces own the knowledge base; users take part through memberships with a role.
      `CREATE TABLE app.workspaces (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND ${LIMITS.workspaceNameChars}),
        personal_user_id uuid UNIQUE REFERENCES app.users(id) ON DELETE CASCADE,
        settings jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_by uuid REFERENCES app.users(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE app.workspace_members (
        workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
        role text NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (workspace_id, user_id)
      )`,
      `CREATE INDEX workspace_members_user_idx ON app.workspace_members (user_id)`,
      // Invitations for people who have not signed in yet; accepted automatically on first sign-in.
      `CREATE TABLE app.workspace_invites (
        workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
        email text NOT NULL CHECK (email = lower(email)),
        role text NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
        invited_by uuid REFERENCES app.users(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (workspace_id, email)
      )`,
      `CREATE INDEX workspace_invites_email_idx ON app.workspace_invites (email)`,
      // Per-notebook overrides of a member's workspace role (up or down).
      `CREATE TABLE app.collection_roles (
        collection_id uuid NOT NULL REFERENCES app.collections(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
        role text NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
        PRIMARY KEY (collection_id, user_id)
      )`,

      // Every existing account gets a personal workspace holding its current data.
      `INSERT INTO app.workspaces (name, personal_user_id, created_by) SELECT 'Personal', id, id FROM app.users`,
      `INSERT INTO app.workspace_members (workspace_id, user_id, role)
       SELECT id, personal_user_id, 'admin' FROM app.workspaces WHERE personal_user_id IS NOT NULL`,

      `ALTER TABLE app.collections ADD COLUMN workspace_id uuid REFERENCES app.workspaces(id) ON DELETE CASCADE`,
      `UPDATE app.collections c SET workspace_id = w.id FROM app.workspaces w WHERE w.personal_user_id = c.owner_id`,
      `ALTER TABLE app.collections ALTER COLUMN workspace_id SET NOT NULL`,
      `ALTER TABLE app.collections DROP CONSTRAINT collections_owner_id_fkey`,
      `ALTER TABLE app.collections RENAME COLUMN owner_id TO created_by`,
      `ALTER TABLE app.collections ALTER COLUMN created_by DROP NOT NULL`,
      `ALTER TABLE app.collections ADD CONSTRAINT collections_created_by_fkey FOREIGN KEY (created_by) REFERENCES app.users(id) ON DELETE SET NULL`,
      `DROP INDEX app.collections_owner_name_key`,
      `CREATE UNIQUE INDEX collections_workspace_name_key ON app.collections (workspace_id, lower(name))`,

      `ALTER TABLE app.documents ADD COLUMN workspace_id uuid REFERENCES app.workspaces(id) ON DELETE CASCADE`,
      `UPDATE app.documents d SET workspace_id = c.workspace_id FROM app.collections c WHERE c.id = d.collection_id`,
      `ALTER TABLE app.documents ALTER COLUMN workspace_id SET NOT NULL`,
      `ALTER TABLE app.documents DROP CONSTRAINT documents_owner_id_fkey`,
      `ALTER TABLE app.documents RENAME COLUMN owner_id TO created_by`,
      `ALTER TABLE app.documents ALTER COLUMN created_by DROP NOT NULL`,
      `ALTER TABLE app.documents ADD CONSTRAINT documents_created_by_fkey FOREIGN KEY (created_by) REFERENCES app.users(id) ON DELETE SET NULL`,
      `DROP INDEX app.documents_owner_collection_idx`,
      `DROP INDEX app.documents_source_idx`,
      `CREATE INDEX documents_workspace_collection_idx ON app.documents (workspace_id, collection_id, created_at DESC)`,
      `CREATE INDEX documents_source_idx ON app.documents (collection_id, source_type, source)`,

      `ALTER TABLE app.chunks ADD COLUMN workspace_id uuid REFERENCES app.workspaces(id) ON DELETE CASCADE`,
      `UPDATE app.chunks ch SET workspace_id = c.workspace_id FROM app.collections c WHERE c.id = ch.collection_id`,
      `ALTER TABLE app.chunks ALTER COLUMN workspace_id SET NOT NULL`,
      `DROP INDEX app.chunks_owner_collection_idx`,
      `ALTER TABLE app.chunks DROP COLUMN owner_id`,
      `CREATE INDEX chunks_workspace_collection_idx ON app.chunks (workspace_id, collection_id)`,

      // Conversations stay private to their author, inside a workspace.
      `ALTER TABLE app.conversations ADD COLUMN workspace_id uuid REFERENCES app.workspaces(id) ON DELETE CASCADE`,
      `UPDATE app.conversations cv SET workspace_id = w.id FROM app.workspaces w WHERE w.personal_user_id = cv.owner_id`,
      `ALTER TABLE app.conversations ALTER COLUMN workspace_id SET NOT NULL`,
      `DROP INDEX app.conversations_owner_updated_idx`,
      `CREATE INDEX conversations_workspace_owner_idx ON app.conversations (workspace_id, owner_id, updated_at DESC)`,

      `ALTER TABLE app.query_logs ADD COLUMN workspace_id uuid REFERENCES app.workspaces(id) ON DELETE CASCADE`,
      `UPDATE app.query_logs q SET workspace_id = w.id FROM app.workspaces w WHERE w.personal_user_id = q.owner_id`,
      `ALTER TABLE app.query_logs ALTER COLUMN workspace_id SET NOT NULL`,
      `ALTER TABLE app.query_logs DROP CONSTRAINT query_logs_status_check`,
      `ALTER TABLE app.query_logs ADD CONSTRAINT query_logs_status_check CHECK (status IN ('ok', 'error', 'insufficient_context'))`,
      `CREATE INDEX query_logs_workspace_created_idx ON app.query_logs (workspace_id, created_at DESC)`,
    ],
  },
  {
    version: 3,
    name: 'chunk_labels_and_metadata',
    statements: [
      `ALTER TABLE app.chunks ADD COLUMN labels text[] NOT NULL DEFAULT '{}'`,
      `ALTER TABLE app.chunks ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}'::jsonb`,
      `ALTER TABLE app.chunks ADD COLUMN updated_at timestamptz`,
      `ALTER TABLE app.chunks ADD COLUMN updated_by uuid REFERENCES app.users(id) ON DELETE SET NULL`,
      `CREATE INDEX chunks_labels_idx ON app.chunks USING gin (labels)`,
    ],
  },
  {
    version: 4,
    name: 'background_jobs_and_evaluation',
    statements: [
      // Durable job queue in Postgres, claimed with FOR UPDATE SKIP LOCKED by any worker.
      `CREATE TABLE app.jobs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        type text NOT NULL,
        payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
        attempts integer NOT NULL DEFAULT 0,
        max_attempts integer NOT NULL DEFAULT 3,
        run_after timestamptz NOT NULL DEFAULT now(),
        locked_at timestamptz,
        last_error text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX jobs_ready_idx ON app.jobs (run_after) WHERE status = 'queued'`,
      `CREATE INDEX jobs_running_idx ON app.jobs (locked_at) WHERE status = 'running'`,

      // Benchmark questions with reference answers (needed for context recall).
      `CREATE TABLE app.eval_cases (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
        collection_id uuid REFERENCES app.collections(id) ON DELETE SET NULL,
        question text NOT NULL CHECK (char_length(question) BETWEEN 1 AND ${LIMITS.evalQuestionChars}),
        reference_answer text NOT NULL CHECK (char_length(reference_answer) BETWEEN 1 AND ${LIMITS.evalReferenceChars}),
        created_by uuid REFERENCES app.users(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX eval_cases_workspace_idx ON app.eval_cases (workspace_id, created_at)`,
      `CREATE TABLE app.eval_runs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
        status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
        case_count integer NOT NULL DEFAULT 0,
        completed_count integer NOT NULL DEFAULT 0,
        error text,
        created_by uuid REFERENCES app.users(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        finished_at timestamptz
      )`,
      `CREATE INDEX eval_runs_workspace_idx ON app.eval_runs (workspace_id, created_at DESC)`,
      // One row per scored answer: live answers (message_id) or benchmark answers (run_id).
      `CREATE TABLE app.evaluations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
        message_id uuid UNIQUE REFERENCES app.messages(id) ON DELETE CASCADE,
        run_id uuid REFERENCES app.eval_runs(id) ON DELETE CASCADE,
        case_id uuid REFERENCES app.eval_cases(id) ON DELETE SET NULL,
        question text NOT NULL,
        answer text NOT NULL,
        faithfulness real CHECK (faithfulness BETWEEN 0 AND 1),
        answer_relevance real CHECK (answer_relevance BETWEEN 0 AND 1),
        context_precision real CHECK (context_precision BETWEEN 0 AND 1),
        context_recall real CHECK (context_recall BETWEEN 0 AND 1),
        details jsonb NOT NULL DEFAULT '{}'::jsonb,
        model text,
        created_at timestamptz NOT NULL DEFAULT now(),
        CHECK (message_id IS NOT NULL OR run_id IS NOT NULL)
      )`,
      `CREATE INDEX evaluations_workspace_created_idx ON app.evaluations (workspace_id, created_at DESC)`,
      `CREATE INDEX evaluations_run_idx ON app.evaluations (run_id)`,
    ],
  },
  {
    version: 5,
    name: 'synthesis_reports',
    statements: [
      `CREATE TABLE app.reports (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
        created_by uuid REFERENCES app.users(id) ON DELETE SET NULL,
        template text NOT NULL CHECK (template IN ('executive_summary', 'comparison_table', 'slide_outline')),
        format text NOT NULL DEFAULT 'markdown' CHECK (format IN ('markdown', 'json')),
        title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND ${LIMITS.documentTitleChars}),
        instructions text,
        collection_ids uuid[] NOT NULL DEFAULT '{}',
        document_ids uuid[] NOT NULL DEFAULT '{}',
        status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
        progress text,
        content text,
        output jsonb,
        sources jsonb NOT NULL DEFAULT '[]'::jsonb,
        error text,
        created_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz
      )`,
      `CREATE INDEX reports_workspace_created_idx ON app.reports (workspace_id, created_at DESC)`,
    ],
  },
  {
    version: 6,
    name: 'background_ingestion',
    statements: [
      // Sources are indexed by a background job. The extracted text is kept until the document is
      // ready, so an interrupted job resumes where it stopped and a failed one can be retried.
      `ALTER TABLE app.documents ADD COLUMN total_chunks integer CHECK (total_chunks IS NULL OR total_chunks >= 0)`,
      `ALTER TABLE app.documents ADD COLUMN byte_size bigint CHECK (byte_size IS NULL OR byte_size >= 0)`,
      `ALTER TABLE app.documents ADD COLUMN error text`,
      `CREATE TABLE app.document_uploads (
        document_id uuid PRIMARY KEY REFERENCES app.documents(id) ON DELETE CASCADE,
        text text NOT NULL,
        replace_existing boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
    ],
  },
  {
    version: 7,
    name: 'generated_images',
    statements: [
      // Knowledge-grounded images. Bytes live in Postgres (bounded size, workspace-scoped like everything else).
      `CREATE TABLE app.images (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
        created_by uuid REFERENCES app.users(id) ON DELETE SET NULL,
        collection_id uuid REFERENCES app.collections(id) ON DELETE SET NULL,
        document_ids uuid[] NOT NULL DEFAULT '{}',
        prompt text NOT NULL CHECK (char_length(prompt) BETWEEN 1 AND ${LIMITS.imagePromptChars}),
        style text NOT NULL CHECK (style IN ('infographic', 'diagram', 'illustration', 'photo', 'sketch', 'render3d')),
        aspect_ratio text NOT NULL CHECK (aspect_ratio IN ('1:1', '16:9', '9:16', '4:3', '3:4')),
        status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
        progress text,
        title text,
        alt_text text,
        final_prompt text,
        sources jsonb NOT NULL DEFAULT '[]'::jsonb,
        model text,
        mime_type text CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
        data bytea,
        byte_size integer CHECK (byte_size IS NULL OR byte_size BETWEEN 1 AND ${LIMITS.imageBytes}),
        width integer,
        height integer,
        error text,
        created_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz
      )`,
      `CREATE INDEX images_workspace_created_idx ON app.images (workspace_id, created_at DESC)`,
    ],
  },
  {
    version: 8,
    name: 'feedback_notifications_audit',
    statements: [
      // Readers rate answers; one rating per person per answer.
      `CREATE TABLE app.message_feedback (
        message_id uuid NOT NULL REFERENCES app.messages(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
        workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
        rating smallint NOT NULL CHECK (rating IN (-1, 1)),
        comment text CHECK (comment IS NULL OR char_length(comment) <= ${LIMITS.feedbackCommentChars}),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (message_id, user_id)
      )`,
      `CREATE INDEX message_feedback_workspace_idx ON app.message_feedback (workspace_id, updated_at DESC)`,
      // In-app notifications (background work finished, added to a workspace, …).
      `CREATE TABLE app.notifications (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
        workspace_id uuid REFERENCES app.workspaces(id) ON DELETE CASCADE,
        kind text NOT NULL,
        title text NOT NULL,
        body text,
        link jsonb,
        read_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX notifications_user_created_idx ON app.notifications (user_id, created_at DESC)`,
      `CREATE INDEX notifications_unread_idx ON app.notifications (user_id) WHERE read_at IS NULL`,
      // Who changed what in a workspace (members, settings, content), for admins.
      `CREATE TABLE app.audit_events (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
        actor_id uuid REFERENCES app.users(id) ON DELETE SET NULL,
        action text NOT NULL,
        target_type text,
        target_id text,
        details jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX audit_events_workspace_created_idx ON app.audit_events (workspace_id, created_at DESC)`,
      `ALTER TABLE app.conversations ADD COLUMN pinned_at timestamptz`,
    ],
  },
  {
    version: 9,
    name: 'embedding_models_and_media',
    statements: [
      // Vectors from different embedding models are not comparable: every chunk records its model and
      // search only compares vectors of the active one. Existing vectors came from gemini-embedding-001.
      `ALTER TABLE app.chunks ADD COLUMN embedding_model text`,
      `UPDATE app.chunks SET embedding_model = 'gemini-embedding-001' WHERE embedding_model IS NULL`,
      `CREATE INDEX chunks_workspace_model_idx ON app.chunks (workspace_id, embedding_model)`,
      // Progress text while a source is read (OCR, transcription) and what kind of media it came from.
      `ALTER TABLE app.documents ADD COLUMN progress text`,
      `ALTER TABLE app.documents ADD COLUMN media_kind text CHECK (media_kind IS NULL OR media_kind IN ('image', 'audio', 'video', 'scan'))`,
      `ALTER TABLE app.documents DROP CONSTRAINT documents_source_type_check`,
      `ALTER TABLE app.documents ADD CONSTRAINT documents_source_type_check
         CHECK (source_type IN ('text', 'file', 'url', 'youtube', 'google_drive', 'notion', 'github', 'website'))`,
      // Uploaded media waiting to be read by a background job, stored in parts that stay well under
      // per-request size limits of serverless Postgres drivers.
      `CREATE TABLE app.document_media (
        document_id uuid PRIMARY KEY REFERENCES app.documents(id) ON DELETE CASCADE,
        kind text NOT NULL CHECK (kind IN ('image', 'audio', 'video', 'scan')),
        mime_type text NOT NULL,
        file_name text NOT NULL,
        byte_size bigint NOT NULL CHECK (byte_size > 0),
        page_count integer CHECK (page_count IS NULL OR page_count > 0),
        replace_existing boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE app.document_media_parts (
        document_id uuid NOT NULL REFERENCES app.document_media(document_id) ON DELETE CASCADE,
        part integer NOT NULL CHECK (part >= 0),
        data bytea NOT NULL,
        PRIMARY KEY (document_id, part)
      )`,
      // Per-page text of PDFs (from the text layer or OCR), so reading a long scan resumes page by page.
      `CREATE TABLE app.document_pages (
        document_id uuid NOT NULL REFERENCES app.documents(id) ON DELETE CASCADE,
        page integer NOT NULL CHECK (page >= 1),
        text text NOT NULL,
        method text NOT NULL CHECK (method IN ('text', 'ocr')),
        PRIMARY KEY (document_id, page)
      )`,
      // Documents imported by a connector remember where they came from, for incremental sync.
      `ALTER TABLE app.documents ADD COLUMN connector_source_id uuid`,
      `ALTER TABLE app.documents ADD COLUMN external_id text`,
      `ALTER TABLE app.documents ADD COLUMN external_version text`,
    ],
  },
  {
    version: 10,
    name: 'audio_overviews_and_mind_maps',
    statements: [
      // Mind maps: a topic tree built from the selected sources.
      `CREATE TABLE app.mind_maps (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
        created_by uuid REFERENCES app.users(id) ON DELETE SET NULL,
        title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND ${LIMITS.documentTitleChars}),
        focus text CHECK (focus IS NULL OR char_length(focus) <= ${STUDIO_LIMITS.focusChars}),
        collection_ids uuid[] NOT NULL DEFAULT '{}',
        document_ids uuid[] NOT NULL DEFAULT '{}',
        status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
        progress text,
        root jsonb,
        node_count integer,
        sources jsonb NOT NULL DEFAULT '[]'::jsonb,
        model text,
        error text,
        created_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz
      )`,
      `CREATE INDEX mind_maps_workspace_created_idx ON app.mind_maps (workspace_id, created_at DESC)`,
      // Audio overviews: a two-host script, recorded in segments (MP3) so a long recording resumes
      // where it stopped; the file is the segments played back to back.
      `CREATE TABLE app.audio_overviews (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
        created_by uuid REFERENCES app.users(id) ON DELETE SET NULL,
        title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND ${LIMITS.documentTitleChars}),
        format text NOT NULL CHECK (format IN ('deep_dive', 'brief', 'critique', 'debate')),
        length text NOT NULL CHECK (length IN ('short', 'default', 'long')),
        language text NOT NULL,
        focus text CHECK (focus IS NULL OR char_length(focus) <= ${STUDIO_LIMITS.focusChars}),
        collection_ids uuid[] NOT NULL DEFAULT '{}',
        document_ids uuid[] NOT NULL DEFAULT '{}',
        status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
        progress text,
        script jsonb,
        transcript jsonb,
        sources jsonb NOT NULL DEFAULT '[]'::jsonb,
        voices text[] NOT NULL DEFAULT '{}',
        model text,
        duration_ms integer,
        byte_size integer,
        error text,
        created_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz
      )`,
      `CREATE INDEX audio_overviews_workspace_created_idx ON app.audio_overviews (workspace_id, created_at DESC)`,
      `CREATE TABLE app.audio_segments (
        audio_id uuid NOT NULL REFERENCES app.audio_overviews(id) ON DELETE CASCADE,
        idx integer NOT NULL CHECK (idx >= 0),
        data bytea NOT NULL,
        duration_ms integer NOT NULL CHECK (duration_ms >= 0),
        PRIMARY KEY (audio_id, idx)
      )`,
    ],
  },
  {
    version: 11,
    name: 'connectors',
    statements: [
      // A member's own account at an external app (Google Drive, Notion, GitHub). Credentials are
      // encrypted with a key derived from AUTH_SECRET (server/security/secrets.ts); only its owner uses it.
      `CREATE TABLE app.connections (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
        provider text NOT NULL CHECK (provider IN ('google_drive', 'notion', 'github')),
        account_label text NOT NULL CHECK (char_length(account_label) BETWEEN 1 AND 200),
        credentials text NOT NULL,
        status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'error')),
        error text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (workspace_id, user_id, provider, account_label)
      )`,
      // Something kept in sync with a notebook: a Drive file or folder, a Notion page or database,
      // a GitHub repository, or a website.
      `CREATE TABLE app.connector_sources (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
        collection_id uuid NOT NULL REFERENCES app.collections(id) ON DELETE CASCADE,
        connection_id uuid REFERENCES app.connections(id) ON DELETE CASCADE,
        created_by uuid REFERENCES app.users(id) ON DELETE SET NULL,
        provider text NOT NULL CHECK (provider IN ('google_drive', 'notion', 'github', 'website')),
        kind text NOT NULL CHECK (kind IN ('file', 'folder', 'page', 'database', 'repository', 'site')),
        external_id text NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND ${LIMITS.urlChars}),
        name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND ${LIMITS.documentTitleChars}),
        url text,
        options jsonb NOT NULL DEFAULT '{}'::jsonb,
        auto_sync boolean NOT NULL DEFAULT true,
        sync_interval_hours integer NOT NULL DEFAULT 24 CHECK (sync_interval_hours BETWEEN 1 AND 720),
        status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'syncing', 'idle', 'error')),
        progress text,
        sync_state jsonb,
        item_count integer NOT NULL DEFAULT 0,
        last_error text,
        last_synced_at timestamptz,
        next_sync_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (collection_id, provider, external_id)
      )`,
      `CREATE INDEX connector_sources_workspace_idx ON app.connector_sources (workspace_id, created_at DESC)`,
      `CREATE INDEX connector_sources_due_idx ON app.connector_sources (next_sync_at) WHERE auto_sync`,
      `ALTER TABLE app.documents ADD CONSTRAINT documents_connector_source_fkey
         FOREIGN KEY (connector_source_id) REFERENCES app.connector_sources(id) ON DELETE SET NULL`,
      `CREATE INDEX documents_connector_idx ON app.documents (connector_source_id, external_id) WHERE connector_source_id IS NOT NULL`,
    ],
  },
  {
    version: 12,
    name: 'followups_shares_files_integrations',
    statements: [
      // Suggested follow-up questions, generated once per answer (after it has been delivered).
      `ALTER TABLE app.messages ADD COLUMN followups jsonb`,
      // Read-only public links to a conversation or a report. The content is a snapshot taken when
      // the link was made; the token is stored hashed (lookup) and encrypted (to show it again).
      `CREATE TABLE app.share_links (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
        created_by uuid REFERENCES app.users(id) ON DELETE SET NULL,
        kind text NOT NULL CHECK (kind IN ('conversation', 'report')),
        target_id uuid NOT NULL,
        title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND ${LIMITS.documentTitleChars}),
        token_hash text NOT NULL UNIQUE,
        token_sealed text NOT NULL,
        snapshot jsonb NOT NULL,
        view_count integer NOT NULL DEFAULT 0,
        last_viewed_at timestamptz,
        revoked_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX share_links_target_idx ON app.share_links (workspace_id, kind, target_id)`,
      // Original files kept for viewing (PDFs, with the cited passage highlighted), in parts.
      `CREATE TABLE app.document_files (
        document_id uuid PRIMARY KEY REFERENCES app.documents(id) ON DELETE CASCADE,
        mime_type text NOT NULL,
        file_name text NOT NULL,
        byte_size bigint NOT NULL CHECK (byte_size > 0),
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE app.document_file_parts (
        document_id uuid NOT NULL REFERENCES app.document_files(document_id) ON DELETE CASCADE,
        part integer NOT NULL CHECK (part >= 0),
        data bytea NOT NULL,
        PRIMARY KEY (document_id, part)
      )`,
      // Chat apps (Slack, Microsoft Teams) that answer from a workspace. Credentials are encrypted.
      `CREATE TABLE app.integrations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
        created_by uuid REFERENCES app.users(id) ON DELETE SET NULL,
        provider text NOT NULL CHECK (provider IN ('slack', 'teams')),
        name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
        collection_id uuid REFERENCES app.collections(id) ON DELETE SET NULL,
        credentials text NOT NULL,
        status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'error')),
        last_error text,
        last_used_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX integrations_workspace_idx ON app.integrations (workspace_id, created_at DESC)`,
    ],
  },
  {
    version: 13,
    name: 'server_side_sessions',
    statements: [
      // Every session token names one of these rows, so a session can be ended for real: signing
      // out revokes it, "sign out everywhere" revokes all of a user's sessions.
      `CREATE TABLE app.sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz,
        user_agent text CHECK (user_agent IS NULL OR char_length(user_agent) <= 300)
      )`,
      `CREATE INDEX sessions_user_active_idx ON app.sessions (user_id) WHERE revoked_at IS NULL`,
    ],
  },
  {
    version: 14,
    name: 'integration_scope',
    statements: [
      // "All notebooks" is now explicit. Before, a missing notebook meant all notebooks, so deleting
      // the notebook a chat-app bot was limited to silently widened the bot to the whole workspace.
      `ALTER TABLE app.integrations ADD COLUMN all_notebooks boolean NOT NULL DEFAULT false`,
      `UPDATE app.integrations SET all_notebooks = (collection_id IS NULL)`,
    ],
  },
  {
    version: 15,
    name: 'upload_sessions',
    statements: [
      // Files larger than one request body (serverless hosts cap bodies, Vercel at 4.5 MB) arrive in
      // parts. The parts wait here until the upload is completed and becomes a document; uploads that
      // are never completed expire and are purged.
      `CREATE TABLE app.upload_sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
        collection_id uuid NOT NULL REFERENCES app.collections(id) ON DELETE CASCADE,
        created_by uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
        file_name text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 500),
        byte_size bigint NOT NULL CHECK (byte_size > 0),
        part_bytes integer NOT NULL CHECK (part_bytes > 0),
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL
      )`,
      `CREATE INDEX upload_sessions_owner_idx ON app.upload_sessions (workspace_id, created_by)`,
      `CREATE INDEX upload_sessions_expiry_idx ON app.upload_sessions (expires_at)`,
      // A part is stored as one or more pieces, each small enough for serverless Postgres drivers.
      `CREATE TABLE app.upload_session_parts (
        upload_id uuid NOT NULL REFERENCES app.upload_sessions(id) ON DELETE CASCADE,
        part integer NOT NULL CHECK (part >= 0),
        piece integer NOT NULL CHECK (piece >= 0),
        data bytea NOT NULL,
        PRIMARY KEY (upload_id, part, piece)
      )`,
    ],
  },
]

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version

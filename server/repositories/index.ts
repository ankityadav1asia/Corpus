import type { Db } from '@/server/db/client'
import { analyticsRepository } from '@/server/repositories/analytics'
import { auditRepository } from '@/server/repositories/audit'
import { otpRepository, rateLimitRepository } from '@/server/repositories/auth-state'
import { chunksRepository } from '@/server/repositories/chunks'
import { collectionsRepository } from '@/server/repositories/collections'
import { connectorsRepository } from '@/server/repositories/connectors'
import { conversationsRepository } from '@/server/repositories/conversations'
import { documentsRepository } from '@/server/repositories/documents'
import { evaluationsRepository } from '@/server/repositories/evaluations'
import { feedbackRepository } from '@/server/repositories/feedback'
import { jobsRepository } from '@/server/repositories/jobs'
import { mediaRepository } from '@/server/repositories/media'
import { notificationsRepository } from '@/server/repositories/notifications'
import { reportsRepository } from '@/server/repositories/reports'
import { sealedValuesRepository } from '@/server/repositories/sealed'
import { sessionsRepository } from '@/server/repositories/sessions'
import { sharesRepository } from '@/server/repositories/shares'
import { uploadsRepository } from '@/server/repositories/uploads'
import { usageRepository } from '@/server/repositories/usage'
import { usersRepository } from '@/server/repositories/users'
import { workspacesRepository } from '@/server/repositories/workspaces'

export function createRepositories(db: Db) {
  return {
    users: usersRepository(db),
    sessions: sessionsRepository(db),
    workspaces: workspacesRepository(db),
    collections: collectionsRepository(db),
    documents: documentsRepository(db),
    chunks: chunksRepository(db),
    media: mediaRepository(db),
    uploads: uploadsRepository(db),
    conversations: conversationsRepository(db),
    analytics: analyticsRepository(db),
    evaluations: evaluationsRepository(db),
    reports: reportsRepository(db),
    connectors: connectorsRepository(db),
    feedback: feedbackRepository(db),
    shares: sharesRepository(db),
    notifications: notificationsRepository(db),
    audit: auditRepository(db),
    jobs: jobsRepository(db),
    otp: otpRepository(db),
    rateLimits: rateLimitRepository(db),
    sealed: sealedValuesRepository(db),
    usage: usageRepository(db),
  }
}

export type Repositories = ReturnType<typeof createRepositories>

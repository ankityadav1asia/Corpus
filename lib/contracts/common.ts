/** Shapes shared by every part of the API. */
import { id } from './fields'

export const idSchema = id

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown; requestId?: string }
}

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed'

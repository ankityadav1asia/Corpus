import { studioItemRoutes } from '@/server/studio/item-routes'

/** Read (any member) or delete (its creator or a workspace admin). */
const routes = studioItemRoutes({ noun: 'Report', responseKey: 'report', auditType: 'report', repository: (repos) => repos.reports })

export const GET = routes.GET
export const DELETE = routes.DELETE

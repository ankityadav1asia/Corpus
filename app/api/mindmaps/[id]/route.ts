import { studioItemRoutes } from '@/server/studio/item-routes'

/** Read (any member) or delete (its creator or a workspace admin). */
const routes = studioItemRoutes({ noun: 'Mind map', responseKey: 'mindMap', auditType: 'mindmap', repository: (repos) => repos.mindMaps })

export const GET = routes.GET
export const DELETE = routes.DELETE

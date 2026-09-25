import { studioItemRoutes } from '@/server/studio/item-routes'

/** Read (any member) or delete (its creator or a workspace admin). */
const routes = studioItemRoutes({ noun: 'Audio overview', responseKey: 'overview', auditType: 'audio', repository: (repos) => repos.audio })

export const GET = routes.GET
export const DELETE = routes.DELETE

import { studioItemRoutes } from '@/server/studio/item-routes'

/** Read (any member) or delete (its creator or a workspace admin). */
const routes = studioItemRoutes({ noun: 'Image', responseKey: 'image', auditType: 'image', repository: (repos) => repos.images })

export const GET = routes.GET
export const DELETE = routes.DELETE

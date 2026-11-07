import { AuditLog } from './models/index.js'

export async function writeAudit(actor, action, entity, entityId, changes, session) {
  await AuditLog.create([{ actor, action, entity, entityId, changes }], { session })
}

export function pagination(request) {
  const page = Math.max(1, Number.parseInt(request.query.page, 10) || 1)
  const limit = Math.min(100, Math.max(1, Number.parseInt(request.query.limit, 10) || 20))
  return { page, limit, skip: (page - 1) * limit }
}

export function dateBounds(query) {
  const filter = {}
  if (query.from || query.to) {
    filter.$gte = query.from ? new Date(query.from) : new Date(0)
    filter.$lte = query.to ? new Date(`${query.to}T23:59:59.999`) : new Date()
  }
  return Object.keys(filter).length ? filter : null
}
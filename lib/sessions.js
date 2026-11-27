'use strict'

const crypto = require('crypto')

// In-memory, per-gateway store. Sessions do not survive a restart and are
// not shared across gateway instances.
const sessions = new Map()

// Identity comes from the Gateway: a token it verified against spec.rbac
// (`{ kind, sub }`), or an older authVerifier's `req._info.user`. A gateway
// running without either serves a single local operator, so every caller
// shares one identity.
function callerId (req) {
  const info = req._info || {}
  if (typeof info.sub === 'string' && info.sub) return `${info.kind || 'user'}:${info.sub}`
  return (info.user && info.user.userId) || 'local'
}

// The caller as the Kernel names it, for naming who approved a write: the
// bare `sub` (the Kernel's command log keys a caller by it, without the
// kind), else an older authVerifier's user id. The shared `local` operator
// is nobody in particular, so undefined.
function callerSub (req) {
  const info = req._info || {}
  if (typeof info.sub === 'string' && info.sub) return info.sub
  return (info.user && info.user.userId) || undefined
}

function create (userId, session) {
  const sessionId = crypto.randomUUID()
  sessions.set(sessionId, { session, userId, busy: false })
  return sessionId
}

// Missing and foreign sessions are indistinguishable to the caller — same
// error, same status — so session ids never leak across users.
function get (sessionId, userId) {
  const entry = sessions.get(sessionId)
  if (!entry || entry.userId !== userId) {
    throw Object.assign(new Error('ERR_AGENT_SESSION_NOT_FOUND'), { statusCode: 404 })
  }
  return entry
}

// Refuses while a turn is streaming or paused on an approval — the message
// loop owns the entry until it releases busy in its finally.
function remove (sessionId, userId) {
  const entry = get(sessionId, userId)
  if (entry.busy) throw Object.assign(new Error('ERR_AGENT_TURN_ACTIVE'), { statusCode: 409 })
  sessions.delete(sessionId)
}

module.exports = { callerId, callerSub, create, get, remove }

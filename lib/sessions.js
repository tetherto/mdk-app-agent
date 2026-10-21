'use strict'

const crypto = require('crypto')

// In-memory, per-gateway store. Sessions do not survive a restart and are
// not shared across gateway instances.
const sessions = new Map()

// Identity comes from the auth plugin when one is installed (its hook stamps
// req._info.user); a gateway running without auth serves a single local
// operator, so every caller shares one identity.
function callerId (req) {
  return (req._info.user && req._info.user.userId) || 'local'
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

module.exports = { callerId, create, get, remove }

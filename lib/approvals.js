'use strict'

const crypto = require('crypto')

const pending = new Map()

// Fail-safe by construction: the promise resolves false unless an explicit
// approved decision lands inside the window, so an unanswered approval never
// runs the write. decide() and the timer both delete the entry first, which
// makes double-decide and decide-after-timeout indistinguishable from an
// unknown approvalId.
function create (sessionId, timeoutMs) {
  const approvalId = crypto.randomUUID()
  let resolve
  const promise = new Promise((_resolve) => { resolve = _resolve })
  const timer = setTimeout(() => {
    pending.delete(approvalId)
    resolve(false)
  }, timeoutMs)
  pending.set(approvalId, { resolve, timer, sessionId })
  return { approvalId, promise }
}

function decide (sessionId, approvalId, approved) {
  const entry = pending.get(approvalId)
  if (!entry || entry.sessionId !== sessionId) {
    throw Object.assign(new Error('ERR_AGENT_APPROVAL_NOT_FOUND'), { statusCode: 404 })
  }
  pending.delete(approvalId)
  clearTimeout(entry.timer)
  entry.resolve(approved === true)
}

function cancel (approvalId) {
  const entry = pending.get(approvalId)
  if (!entry) return
  pending.delete(approvalId)
  clearTimeout(entry.timer)
  entry.resolve(false)
}

module.exports = { create, decide, cancel }

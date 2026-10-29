'use strict'

const crypto = require('crypto')

const { config } = require('@tetherto/mdk-gateway/plugin')
const { EVENT, AgentEventSchema, isTerminal } = require('@tetherto/mdk-agent')
const store = require('../lib/sessions')
const approvals = require('../lib/approvals')
const sse = require('../lib/sse')

const APPROVAL_TIMEOUT_MS = config.agent?.approvalTimeoutMs || 120000

// Streams one agent turn as SSE, stamping the wire envelope the library
// deliberately does not: turnId, per-turn monotonic seq, approvalId only on
// pending_approval. Exactly one terminal event (done | error), always last.
// A client that disconnects ends the turn: the model call is aborted, a pending
// approval is rejected, and the generator is returned at the next event.
module.exports = async function postMessage (req, res) {
  const entry = store.get(req.params.id, store.callerId(req))
  if (entry.busy) throw Object.assign(new Error('ERR_AGENT_TURN_ACTIVE'), { statusCode: 409 })

  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : ''
  if (!text) throw Object.assign(new Error('ERR_AGENT_MESSAGE_TEXT_REQUIRED'), { statusCode: 400 })

  entry.busy = true
  const turnId = crypto.randomUUID()
  let seq = 0
  let pendingId = null
  let terminalSeen = false

  let gone = false
  const turn = new AbortController()
  res.on('close', () => {
    if (res.writableEnded) return
    gone = true
    turn.abort()
    if (pendingId) approvals.cancel(pendingId)
  })

  sse.open(res)
  const iter = entry.session.send(text, { signal: turn.signal })
  try {
    let sent
    while (true) {
      if (gone) {
        await iter.return()
        break
      }
      const { value: ev, done } = await iter.next(sent)
      sent = undefined
      if (done) break
      // Unknown or malformed events are dropped (contract invariant 5), and
      // after the terminal event the generator is only drained — never
      // written — so the library's own turn cleanup still runs.
      if (terminalSeen || !AgentEventSchema.safeParse(ev).success) continue

      const wire = { ...ev, turnId, seq: seq++, ts: Date.now() }
      if (ev.type === EVENT.PENDING_APPROVAL) {
        const approval = approvals.create(req.params.id, APPROVAL_TIMEOUT_MS)
        pendingId = approval.approvalId
        wire.approvalId = approval.approvalId
        sse.writeEvent(res, ev.type, wire)
        sent = await approval.promise
        pendingId = null
        continue
      }

      sse.writeEvent(res, ev.type, wire)
      if (isTerminal(ev)) terminalSeen = true
    }
  } finally {
    entry.busy = false
    if (pendingId) approvals.cancel(pendingId)
    sse.close(res)
  }
}

'use strict'

const { getAgent } = require('../lib/agent')
const store = require('../lib/sessions')

// Identity comes from the resolved token (req._info), never the body —
// sessions bind to the caller's stable userId.
module.exports = async function createSession (req) {
  const agent = await getAgent()
  const userId = store.callerId(req)
  const session = await agent.createSession({ userId })
  const sessionId = store.create(userId, session)
  return { sessionId }
}

module.exports.remove = async function removeSession (req) {
  store.remove(req.params.id, store.callerId(req))
  return { sessionId: req.params.id, deleted: true }
}

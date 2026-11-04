'use strict'

const { config, logger } = require('@tetherto/mdk-gateway/plugin')
const { createAgent } = require('@tetherto/mdk-agent')

// One agent per gateway: the handle owns the provider and MCP connections,
// sessions are cheap and hang off it. The create promise is cached so
// concurrent first requests share one agent; a failed create clears the
// cache so the next request retries.
let agent = null

async function getAgent () {
  if (!config.agent) throw unavailable('config.agent missing')
  if (!agent) agent = createOnce()
  return agent
}

async function createOnce () {
  // config.agent.factory is the test seam: production configs are JSON and
  // can never carry a function, so real gateways always hit createAgent.
  const makeAgent = config.agent.factory || createAgent
  let created
  try {
    created = await makeAgent(config.agent)
  } catch (err) {
    agent = null
    logger.error('agent create failed: %s', err.message)
    throw unavailable(err.message)
  }
  logToolAdmission(created)
  return created
}

// Tool admission is silent otherwise: under the default strictToolGating, MCP
// tools generated from app routes carry no agent contract and are skipped, so
// the agent starts cleanly and then cannot answer questions those routes cover.
// Say which tools were withheld and why, once, when the agent is created.
function logToolAdmission (created) {
  const admitted = created?.tools ?? []
  const skipped = created?.skipped ?? []
  logger.info('agent admitted %d MCP tool(s): %s', admitted.length, admitted.map(t => t.name).join(', ') || 'none')
  if (!skipped.length) return
  const reasons = skipped.map(s => `${s.name} (${s.reason})`).join(', ')
  logger.warn('agent skipped %d MCP tool(s): %s. Tools generated from app routes are not agent-enabled under the default strictToolGating; set agent.strictToolGating to false with agent.capability "mid" or higher to admit them', skipped.length, reasons)
}

function unavailable (msg) {
  return Object.assign(new Error(`ERR_AGENT_UNAVAILABLE: ${msg}`), { statusCode: 503 })
}

module.exports = { getAgent }

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
  try {
    return await makeAgent(config.agent)
  } catch (err) {
    agent = null
    logger.error('agent create failed: %s', err.message)
    throw unavailable(err.message)
  }
}

function unavailable (msg) {
  return Object.assign(new Error(`ERR_AGENT_UNAVAILABLE: ${msg}`), { statusCode: 503 })
}

module.exports = { getAgent }

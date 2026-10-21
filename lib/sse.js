'use strict'

// SSE framing per the agent contract: `event: <type>\ndata: <WireEvent JSON>\n\n`.
// Writes no-op once the client is gone — a disconnect mid-turn must not crash
// the loop that is still draining the agent's generator.

function open (res) {
  res.on('error', () => {})
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive'
  })
}

function writeEvent (res, type, wire) {
  if (res.destroyed || res.writableEnded) return
  res.write(`event: ${type}\ndata: ${JSON.stringify(wire)}\n\n`)
}

function close (res) {
  if (res.destroyed || res.writableEnded) return
  res.end()
}

module.exports = { open, writeEvent, close }

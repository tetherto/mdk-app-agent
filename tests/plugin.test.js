'use strict'

const test = require('brittle')
const path = require('path')
const { EventEmitter } = require('events')
const { loadPlugin } = require('@tetherto/mdk-gateway/workers/lib/plugin-loader')
const { EVENT } = require('@tetherto/mdk-agent')

const PLUGIN_DIR = path.resolve(__dirname, '..')
const APPROVAL_TIMEOUT_MS = 60

// Scripted session double: yields the scripted events as pure AgentEvents;
// on pending_approval it captures the boolean injected via iter.next() and
// branches the way the library's loop does, recording whether the write ran.
function scriptedSession (events, record) {
  return {
    send: async function * (text) {
      record.sent = text
      for (const ev of events) {
        if (ev.type === EVENT.PENDING_APPROVAL) {
          const approved = yield ev
          record.approved = approved
          if (approved) {
            record.writeInvoked = true
            yield { type: EVENT.TOOL_RESULT, name: ev.name, text: '{"status":"SUCCESS"}' }
            yield { type: EVENT.TOKEN, text: 'Rebooted.' }
            yield { type: EVENT.DONE, text: 'Rebooted.' }
          } else {
            yield { type: EVENT.TOOL_RESULT, name: ev.name, text: '(rejected by operator — not executed)' }
            yield { type: EVENT.TOKEN, text: 'Not executed.' }
            yield { type: EVENT.DONE }
          }
          return
        }
        yield ev
      }
    }
  }
}

function loadAgentPlugin (events, record, opts = {}) {
  const context = Object.freeze({
    config: Object.freeze({
      agent: Object.freeze({
        approvalTimeoutMs: opts.approvalTimeoutMs || APPROVAL_TIMEOUT_MS,
        // async, like the real createAgent's createSession — a synchronous double
        // let a missing `await` in the controller pass every test in this file.
        factory: async () => ({ createSession: async () => opts.session || scriptedSession(events, record) })
      })
    }),
    logger: { error () {}, warn () {}, info () {}, debug () {} },
    dataProxy: {}
  })
  const plugin = loadPlugin(PLUGIN_DIR, context)
  const [create, message, approve, remove] = plugin.routes.map(r => r._handler)
  return { create, message, approve, remove }
}

function makeReq (user, perms, extra = {}) {
  return {
    params: extra.params || {},
    query: {},
    body: extra.body || {},
    headers: {},
    _info: { user: { userId: user }, perms, authToken: `tok-${user}` }
  }
}

function makeRes () {
  const res = {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    frames: [],
    head: null,
    writeHead (status, headers) { res.headersSent = true; res.head = { status, headers } },
    write (chunk) { res.frames.push(String(chunk)); return true },
    end () { res.writableEnded = true },
    on () {},
    once () {},
    removeListener () {}
  }
  return res
}

// makeRes() that emits 'close' like a real response whose client went away.
function makeLiveRes () {
  const res = Object.assign(new EventEmitter(), makeRes())
  delete res.on
  delete res.once
  delete res.removeListener
  res.disconnect = () => { res.destroyed = true; res.emit('close') }
  return res
}

function parseFrames (res) {
  return res.frames.map(frame => {
    const match = /^event: (.+)\ndata: (.+)\n\n$/.exec(frame)
    return { type: match[1], data: JSON.parse(match[2]) }
  })
}

async function waitFor (predicate, timeoutMs = 2000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

const CHAT = ['agent:chat']
const CHAT_WRITE = ['agent:chat', 'device:write']

const PLAIN_TURN = [
  { type: EVENT.TOKEN, text: 'All ' },
  { type: EVENT.TOKEN, text: 'good.' },
  { type: EVENT.DONE, text: 'All good.', usage: { totalTokens: 4 } }
]

const WRITE_TURN = [
  { type: EVENT.TOKEN, text: 'Rebooting…' },
  { type: EVENT.TOOL_CALL, name: 'act_device', args: { ref: 'antminer-3', action: 'reboot' } },
  { type: EVENT.PENDING_APPROVAL, name: 'act_device', args: { ref: 'antminer-3', action: 'reboot' } }
]

test('agent plugin - plain turn: envelope stamping and exactly one terminal event', async (t) => {
  const record = {}
  const { create, message } = loadAgentPlugin(PLAIN_TURN, record)

  const { sessionId } = await create(makeReq('op-a', CHAT))
  t.ok(sessionId, 'session created')

  const res = makeRes()
  await message(makeReq('op-a', CHAT, { params: { id: sessionId }, body: { text: 'status?' } }), res)

  t.is(record.sent, 'status?', 'operator text reached the session')
  t.is(res.head.headers['content-type'], 'text/event-stream', 'SSE content type')

  const frames = parseFrames(res)
  t.alike(frames.map(f => f.type), ['token', 'token', 'done'], 'typed events forwarded in order')

  const turnIds = new Set(frames.map(f => f.data.turnId))
  t.is(turnIds.size, 1, 'turnId constant across the turn')
  t.alike(frames.map(f => f.data.seq), [0, 1, 2], 'seq monotonic from 0')
  t.ok(frames.every(f => typeof f.data.ts === 'number'), 'ts stamped')
  t.ok(frames.every(f => !('approvalId' in f.data)), 'no approvalId outside pending_approval')

  const terminals = frames.filter(f => f.type === 'done' || f.type === 'error')
  t.is(terminals.length, 1, 'exactly one terminal event')
  t.is(frames[frames.length - 1].type, 'done', 'terminal event is last')
  t.ok(res.writableEnded, 'stream closed after the terminal event')
})

test('agent plugin - unknown event types are dropped without seq gaps', async (t) => {
  const record = {}
  const script = [PLAIN_TURN[0], { type: 'telemetry_blob', x: 1 }, PLAIN_TURN[1], PLAIN_TURN[2]]
  const { create, message } = loadAgentPlugin(script, record)

  const { sessionId } = await create(makeReq('op-a', CHAT))
  const res = makeRes()
  await message(makeReq('op-a', CHAT, { params: { id: sessionId }, body: { text: 'hi' } }), res)

  const frames = parseFrames(res)
  t.alike(frames.map(f => f.type), ['token', 'token', 'done'], 'unknown event not forwarded')
  t.alike(frames.map(f => f.data.seq), [0, 1, 2], 'seq stays contiguous')
})

test('agent plugin - approve resumes tool_result -> token -> done and runs the write', async (t) => {
  const record = {}
  const { create, message, approve } = loadAgentPlugin(WRITE_TURN, record)

  const { sessionId } = await create(makeReq('op-a', CHAT_WRITE))
  const res = makeRes()
  const streaming = message(makeReq('op-a', CHAT_WRITE, { params: { id: sessionId }, body: { text: 'reboot antminer-3' } }), res)

  await waitFor(() => res.frames.some(f => f.startsWith('event: pending_approval')))
  const pending = parseFrames(res).find(f => f.type === 'pending_approval')
  t.ok(pending.data.approvalId, 'pending_approval carries approvalId')
  t.is(pending.data.name, 'act_device', 'pending_approval names the tool')

  // A second message on the same session while the turn is paused is refused.
  try {
    await message(makeReq('op-a', CHAT_WRITE, { params: { id: sessionId }, body: { text: 'again' } }), makeRes())
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_AGENT_TURN_ACTIVE', 'one turn at a time per session')
  }

  const decision = await approve(makeReq('op-a', CHAT_WRITE, {
    params: { id: sessionId, approvalId: pending.data.approvalId },
    body: { approved: true }
  }))
  t.is(decision.approved, true, 'decision acknowledged')

  await streaming
  const frames = parseFrames(res)
  t.alike(frames.map(f => f.type), ['token', 'tool_call', 'pending_approval', 'tool_result', 'token', 'done'], 'resume order tool_result -> token -> done')
  t.is(record.approved, true, 'library iterator received approved=true')
  t.ok(record.writeInvoked, 'write tool ran')
  t.alike(frames.map(f => f.data.seq), [0, 1, 2, 3, 4, 5], 'seq monotonic across the pause')
  t.is(frames.filter(f => 'approvalId' in f.data).length, 1, 'approvalId only on pending_approval')
  t.ok(res.writableEnded, 'stream closed')

  // The consumed approval id is gone.
  try {
    await approve(makeReq('op-a', CHAT_WRITE, { params: { id: sessionId, approvalId: pending.data.approvalId }, body: { approved: true } }))
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_AGENT_APPROVAL_NOT_FOUND', 'double-decide rejected')
  }
})

test('agent plugin - approved:false rejects the write and still terminates cleanly', async (t) => {
  const record = {}
  const { create, message, approve } = loadAgentPlugin(WRITE_TURN, record)

  const { sessionId } = await create(makeReq('op-a', CHAT_WRITE))
  const res = makeRes()
  const streaming = message(makeReq('op-a', CHAT_WRITE, { params: { id: sessionId }, body: { text: 'reboot it' } }), res)

  await waitFor(() => res.frames.some(f => f.startsWith('event: pending_approval')))
  const pending = parseFrames(res).find(f => f.type === 'pending_approval')

  await approve(makeReq('op-a', CHAT_WRITE, { params: { id: sessionId, approvalId: pending.data.approvalId }, body: { approved: false } }))
  await streaming

  const frames = parseFrames(res)
  t.is(record.approved, false, 'library iterator received approved=false')
  t.absent(record.writeInvoked, 'write tool never invoked')
  t.ok(frames.find(f => f.type === 'tool_result').data.text.includes('rejected'), 'rejected tool_result forwarded')
  t.is(frames[frames.length - 1].type, 'done', 'turn still ends with done')
})

test('agent plugin - no decision inside the window means reject', async (t) => {
  const record = {}
  const { create, message, approve } = loadAgentPlugin(WRITE_TURN, record, { approvalTimeoutMs: 40 })

  const { sessionId } = await create(makeReq('op-a', CHAT_WRITE))
  const res = makeRes()
  await message(makeReq('op-a', CHAT_WRITE, { params: { id: sessionId }, body: { text: 'reboot it' } }), res)

  t.is(record.approved, false, 'timeout resolves the approval to false')
  t.absent(record.writeInvoked, 'write tool never ran')
  const frames = parseFrames(res)
  t.ok(frames.find(f => f.type === 'tool_result').data.text.includes('rejected'), 'reject path taken')
  t.is(frames[frames.length - 1].type, 'done', 'turn terminates')

  const pending = frames.find(f => f.type === 'pending_approval')
  try {
    await approve(makeReq('op-a', CHAT_WRITE, { params: { id: sessionId, approvalId: pending.data.approvalId }, body: { approved: true } }))
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_AGENT_APPROVAL_NOT_FOUND', 'expired approval cannot be decided late')
  }
})

test('agent plugin - works without auth: an empty _info binds to the local operator', async (t) => {
  const record = {}
  const { create, message, remove } = loadAgentPlugin(PLAIN_TURN, record)

  // No auth plugin installed: nothing stamped _info, every caller is 'local'.
  const bare = (extra = {}) => ({ params: {}, query: {}, body: {}, headers: {}, _info: {}, ...extra })

  const { sessionId } = await create(bare())
  t.ok(sessionId, 'session created with no identity on the request')

  const res = makeRes()
  await message(bare({ params: { id: sessionId }, body: { text: 'status?' } }), res)
  t.is(parseFrames(res).pop().type, 'done', 'full turn streamed without auth')

  const gone = await remove(bare({ params: { id: sessionId } }))
  t.is(gone.deleted, true, 'session deleted without auth')
})

test('agent plugin - identity comes from the token, never the body', async (t) => {
  const record = {}
  const { create, message } = loadAgentPlugin(PLAIN_TURN, record)

  // The body claims another user; the session still binds to the token user.
  const { sessionId } = await create(makeReq('op-a', CHAT, { body: { user: 'op-b' } }))

  const res = makeRes()
  await message(makeReq('op-a', CHAT, { params: { id: sessionId }, body: { text: 'hi', user: 'op-b' } }), res)
  t.is(parseFrames(res).pop().type, 'done', 'token user can use the session')

  try {
    await message(makeReq('op-b', CHAT, { params: { id: sessionId }, body: { text: 'hi' } }), makeRes())
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_AGENT_SESSION_NOT_FOUND', 'the body claim bought op-b nothing')
  }
})

test('agent plugin - another user cannot touch a session or its approvals', async (t) => {
  const record = {}
  const { create, message, approve } = loadAgentPlugin(WRITE_TURN, record)

  const { sessionId } = await create(makeReq('op-a', CHAT_WRITE))

  try {
    await message(makeReq('op-b', CHAT_WRITE, { params: { id: sessionId }, body: { text: 'hi' } }), makeRes())
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_AGENT_SESSION_NOT_FOUND', 'foreign session reads as missing')
    t.is(err.statusCode, 404, 'not a 403 — existence never leaks')
  }

  const res = makeRes()
  const streaming = message(makeReq('op-a', CHAT_WRITE, { params: { id: sessionId }, body: { text: 'reboot it' } }), res)
  await waitFor(() => res.frames.some(f => f.startsWith('event: pending_approval')))
  const pending = parseFrames(res).find(f => f.type === 'pending_approval')

  try {
    await approve(makeReq('op-b', CHAT_WRITE, { params: { id: sessionId, approvalId: pending.data.approvalId }, body: { approved: true } }))
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_AGENT_SESSION_NOT_FOUND', 'user B cannot decide user A approvals')
  }

  await approve(makeReq('op-a', CHAT_WRITE, { params: { id: sessionId, approvalId: pending.data.approvalId }, body: { approved: false } }))
  await streaming
  t.pass()
})

test('agent plugin - delete session removes it for good', async (t) => {
  const record = {}
  const { create, message, remove } = loadAgentPlugin(PLAIN_TURN, record)

  const { sessionId } = await create(makeReq('op-a', CHAT))
  const gone = await remove(makeReq('op-a', CHAT, { params: { id: sessionId } }))
  t.alike(gone, { sessionId, deleted: true }, 'delete acknowledged')

  try {
    await message(makeReq('op-a', CHAT, { params: { id: sessionId }, body: { text: 'hi' } }), makeRes())
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_AGENT_SESSION_NOT_FOUND', 'deleted session is gone')
  }

  try {
    await remove(makeReq('op-a', CHAT, { params: { id: sessionId } }))
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_AGENT_SESSION_NOT_FOUND', 'double delete is 404')
    t.is(err.statusCode, 404, 'carries 404')
  }
})

test('agent plugin - delete is gated on ownership', async (t) => {
  const record = {}
  const { create, remove } = loadAgentPlugin(PLAIN_TURN, record)

  const { sessionId } = await create(makeReq('op-a', CHAT))

  try {
    await remove(makeReq('op-b', CHAT, { params: { id: sessionId } }))
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_AGENT_SESSION_NOT_FOUND', 'user B cannot delete user A session')
    t.is(err.statusCode, 404, 'reads as missing — existence never leaks')
  }
})

test('agent plugin - delete is refused while a turn is active', async (t) => {
  const record = {}
  const { create, message, approve, remove } = loadAgentPlugin(WRITE_TURN, record)

  const { sessionId } = await create(makeReq('op-a', CHAT_WRITE))
  const res = makeRes()
  const streaming = message(makeReq('op-a', CHAT_WRITE, { params: { id: sessionId }, body: { text: 'reboot it' } }), res)

  await waitFor(() => res.frames.some(f => f.startsWith('event: pending_approval')))
  try {
    await remove(makeReq('op-a', CHAT_WRITE, { params: { id: sessionId } }))
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_AGENT_TURN_ACTIVE', 'no delete under a paused turn')
    t.is(err.statusCode, 409, 'carries 409')
  }

  const pending = parseFrames(res).find(f => f.type === 'pending_approval')
  await approve(makeReq('op-a', CHAT_WRITE, { params: { id: sessionId, approvalId: pending.data.approvalId }, body: { approved: false } }))
  await streaming

  await remove(makeReq('op-a', CHAT_WRITE, { params: { id: sessionId } }))
  t.pass('delete succeeds once the turn is over')
})

test('agent plugin - unknown session is 404', async (t) => {
  const record = {}
  const { message } = loadAgentPlugin(PLAIN_TURN, record)
  try {
    await message(makeReq('op-a', CHAT, { params: { id: 'nope' }, body: { text: 'hi' } }), makeRes())
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_AGENT_SESSION_NOT_FOUND', 'missing session rejected')
    t.is(err.statusCode, 404, 'carries 404')
  }
})

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

test('agent plugin - a client that disconnects ends the turn and frees the session', async (t) => {
  const record = { yielded: 0 }
  const session = {
    send: async function * (text, { signal }) {
      record.signal = signal
      try {
        for (let i = 0; i < 50; i++) {
          record.yielded++
          yield { type: EVENT.TOKEN, text: `t${i} ` }
          await sleep(10)
        }
        yield { type: EVENT.DONE }
      } finally {
        record.returned = true
      }
    }
  }
  const { create, message } = loadAgentPlugin([], record, { session })
  const { sessionId } = await create(makeReq('op-a', CHAT))

  const res = makeLiveRes()
  const streaming = message(makeReq('op-a', CHAT, { params: { id: sessionId }, body: { text: 'long answer' } }), res)
  await waitFor(() => res.frames.length >= 2)
  res.disconnect()
  await streaming

  t.ok(record.signal.aborted, 'the turn signal the session got was aborted')
  t.ok(record.returned, 'the session generator was returned')
  t.ok(record.yielded < 10, `the turn stopped early (${record.yielded} of 50 events)`)

  record.returned = false
  const next = makeLiveRes()
  await message(makeReq('op-a', CHAT, { params: { id: sessionId }, body: { text: 'again' } }), next)
  t.is(parseFrames(next).pop().type, 'done', 'the session takes the next turn: no ERR_AGENT_TURN_ACTIVE')
})

test('agent plugin - a disconnect during a pending approval rejects the write at once', async (t) => {
  const record = {}
  const { create, message } = loadAgentPlugin(WRITE_TURN, record, { approvalTimeoutMs: 10000 })
  const { sessionId } = await create(makeReq('op-a', CHAT_WRITE))

  const res = makeLiveRes()
  const started = Date.now()
  const streaming = message(makeReq('op-a', CHAT_WRITE, { params: { id: sessionId }, body: { text: 'reboot it' } }), res)
  await waitFor(() => res.frames.some(f => f.startsWith('event: pending_approval')))
  res.disconnect()
  await streaming

  t.absent(record.writeInvoked, 'the write never ran')
  t.ok(Date.now() - started < 5000, 'without waiting for the approval timeout')
})

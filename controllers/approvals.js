'use strict'

const store = require('../lib/sessions')
const approvals = require('../lib/approvals')

module.exports = async function decideApproval (req) {
  store.get(req.params.id, store.callerId(req))
  const approved = req.body?.approved === true
  // Only an identity the Gateway verified is named; a local, unauthenticated caller is not.
  const sub = req._info?.sub
  approvals.decide(req.params.id, req.params.approvalId, approved, typeof sub === 'string' && sub ? sub : undefined)
  return { approvalId: req.params.approvalId, approved }
}

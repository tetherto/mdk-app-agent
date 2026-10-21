'use strict'

const store = require('../lib/sessions')
const approvals = require('../lib/approvals')

module.exports = async function decideApproval (req) {
  store.get(req.params.id, store.callerId(req))
  const approved = req.body?.approved === true
  approvals.decide(req.params.id, req.params.approvalId, approved)
  return { approvalId: req.params.approvalId, approved }
}

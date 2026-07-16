// /api/handoff.js — C4 Orchestrator handoff route
// GET (list/filter) + POST (create | action:done) + PATCH (close-out)
// Edit source: SquadDeep\02_Projects\c4-mesh\api\handoff.js -> push via GitHub API -> Vercel auto-deploy
//
// 2026-07-16 REPAIR. The previous version was written against a schema that does not exist.
// It validated on `agent` then inserted `agent`/`notes` into a table that has neither, so every
// POST 500'd with "Could not find the 'agent' column of 'handoffs' in the schema cache" and every
// PATCH failed the same way on close_notes/updated_at/closed_at. Handoff create AND close were
// both dead; last successful create was id 17 on 2026-07-13. verify.ps1 and handoff.ps1 send the
// {action, from_hub, to_hub, task, context} shape and had been failing silently against it.
//
// REAL columns (confirmed by live GET, 2026-07-16):
//   id, from_hub, to_hub, task, context, status, created_at, claimed_at, done_at,
//   priority, resolution, project_name
// There is no agent / notes / close_notes / updated_at / closed_at column.
//
// This version writes ONLY real columns and accepts both call shapes, so handoff.ps1 and
// verify.ps1 work unchanged while `agent`-style callers keep working (agent maps to to_hub).

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

// Existing rows use both 'closed' and 'done'. The old route rejected 'done', which is what
// 12 of the 17 live rows actually carry — so the validator disagreed with the data too.
const VALID_STATUSES = ['open', 'claimed', 'in_progress', 'done', 'closed', 'cancelled']
const CLOSING_STATUSES = ['done', 'closed', 'cancelled']

function setCors(res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v))
}

function authCheck(req) {
  const auth = req.headers.authorization || ''
  return auth === `Bearer ${process.env.C4_SECRET}`
}

async function closeHandoff(res, { id, status = 'done', resolution = '' }) {
  if (!id) return res.status(400).json({ error: 'id is required' })
  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` })
  }

  const update = {
    status,
    ...(resolution && { resolution }),
    ...(CLOSING_STATUSES.includes(status) && { done_at: new Date().toISOString() }),
  }

  const { data, error } = await supabase
    .from('handoffs').update(update).eq('id', id).select().single()

  if (error) {
    console.error('[handoff close]', error)
    return res.status(500).json({ error: error.message })
  }
  return res.status(200).json({ success: true, handoff: data })
}

export default async function handler(req, res) {
  setCors(res)

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (!authCheck(req)) return res.status(401).json({ error: 'unauthorized' })

  if (req.method === 'GET') {
    const { status, agent, to_hub, limit = 50, offset = 0 } = req.query

    let query = supabase
      .from('handoffs')
      .select('*')
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1)

    if (status) query = query.eq('status', status)

    // `agent` is kept as an alias for the recipient. It filters to_hub, not a column named
    // `agent` — that filter was also broken. ilike because live values are mixed-case
    // ('Main Hub', 'Satellite Hub', 'Recon', 'Claude-Code'); the old .toUpperCase() matched nothing.
    const recipient = to_hub || agent
    if (recipient) query = query.ilike('to_hub', recipient)

    const { data, error } = await query

    if (error) {
      console.error('[handoff GET]', error)
      return res.status(500).json({ error: error.message })
    }

    return res.status(200).json({ success: true, count: data.length, handoffs: data })
  }

  if (req.method === 'POST') {
    const {
      action, id, resolution, close_notes,
      agent, to_hub, from_hub, task, context, notes, priority, status,
    } = req.body || {}

    // Legacy close path — verify.ps1 posts { action:'done', id } rather than using PATCH.
    if (action === 'done' || action === 'close') {
      return closeHandoff(res, { id, status: status || 'done', resolution: resolution || close_notes || '' })
    }

    const recipient = to_hub || agent
    if (!recipient || !task) {
      return res.status(400).json({ error: 'task and a recipient (to_hub, or agent) are required' })
    }

    const row = {
      from_hub: from_hub || 'Main Hub',
      to_hub: recipient,
      task,
      context: context || notes || null,
      // Live rows use 'normal'. The old default was 'P2', which nothing else in the mesh emits.
      priority: priority || 'normal',
      status: 'open',
      created_at: new Date().toISOString(),
    }

    const { data, error } = await supabase.from('handoffs').insert([row]).select().single()

    if (error) {
      console.error('[handoff POST]', error)
      return res.status(500).json({ error: error.message })
    }

    return res.status(200).json({ success: true, handoff: data })
  }

  if (req.method === 'PATCH') {
    const { id, status, resolution, close_notes } = req.body || {}
    return closeHandoff(res, {
      id,
      status: status || 'done',
      resolution: resolution || close_notes || '',
    })
  }

  return res.status(405).json({ error: `method ${req.method} not allowed` })
}

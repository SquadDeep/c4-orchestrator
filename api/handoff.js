// /api/handoff.js — FULL REPLACEMENT
// Adds GET (list/filter) and PATCH (close-out) to existing POST handler

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

function setCors(res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v))
}

function authCheck(req) {
  const auth = req.headers.authorization || ''
  return auth === `Bearer ${process.env.C4_SECRET}`
}

export default async function handler(req, res) {
  setCors(res)

  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }

  if (!authCheck(req)) {
    return res.status(401).json({ error: 'unauthorized' })
  }

  if (req.method === 'GET') {
    const { status, agent, limit = 50, offset = 0 } = req.query

    let query = supabase
      .from('handoffs')
      .select('*')
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1)

    if (status) query = query.eq('status', status)
    if (agent) query = query.eq('agent', agent.toUpperCase())

    const { data, error } = await query

    if (error) {
      console.error('[handoff GET]', error)
      return res.status(500).json({ error: error.message })
    }

    return res.status(200).json({ success: true, count: data.length, handoffs: data })
  }

  if (req.method === 'POST') {
    const { agent, task, priority = 'P2', notes = '' } = req.body

    if (!agent || !task) {
      return res.status(400).json({ error: 'agent and task are required' })
    }

    const { data, error } = await supabase
      .from('handoffs')
      .insert([{ agent: agent.toUpperCase(), task, priority, notes, status: 'open', created_at: new Date().toISOString() }])
      .select()
      .single()

    if (error) {
      console.error('[handoff POST]', error)
      return res.status(500).json({ error: error.message })
    }

    return res.status(200).json({ success: true, handoff: data })
  }

  if (req.method === 'PATCH') {
    const { id, status, close_notes = '' } = req.body

    if (!id) {
      return res.status(400).json({ error: 'id is required' })
    }

    const validStatuses = ['open', 'in_progress', 'closed', 'cancelled']
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` })
    }

    const update = {
      ...(status && { status }),
      ...(close_notes && { close_notes }),
      updated_at: new Date().toISOString(),
      ...(status === 'closed' && { closed_at: new Date().toISOString() }),
    }

    const { data, error } = await supabase
      .from('handoffs')
      .update(update)
      .eq('id', id)
      .select()
      .single()

    if (error) {
      console.error('[handoff PATCH]', error)
      return res.status(500).json({ error: error.message })
    }

    return res.status(200).json({ success: true, handoff: data })
  }

  return res.status(405).json({ error: `method ${req.method} not allowed` })
}

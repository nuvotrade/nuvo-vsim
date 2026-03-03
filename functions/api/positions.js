export async function onRequestGet({ env }) {
  const res = await env.DB.prepare(
    "SELECT json FROM positions"
  ).all()

  return Response.json(res.results || [])
}

export async function onRequestPost({ request, env }) {
  const body = await request.json()

  await env.DB.prepare(
    "INSERT OR REPLACE INTO positions (id,json,updated_at) VALUES (?,?,?)"
  )
    .bind(body.id, JSON.stringify(body), Date.now())
    .run()

  return Response.json({ ok: true })
}
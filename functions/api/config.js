export async function onRequestGet({ env }) {
  const res = await env.DB.prepare(
    "SELECT json FROM config WHERE id='main'"
  ).first()

  return Response.json(res || {})
}

export async function onRequestPost({ request, env }) {
  const body = await request.json()

  await env.DB.prepare(
    "INSERT OR REPLACE INTO config (id,json,updated_at) VALUES ('main',?,?)"
  )
    .bind(JSON.stringify(body), Date.now())
    .run()

  return Response.json({ ok: true })
}


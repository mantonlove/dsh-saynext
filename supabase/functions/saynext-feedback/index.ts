import { receive } from '../_shared/receiver.mjs'

const base = Deno.env.get('SUPABASE_URL')
const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}')
const key = keys.default || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
if (!base || !key) throw Error('Missing server-side database configuration')
const rpc = new URL('/rest/v1/rpc/write_saynext_sample', base)
const headers = new Headers({apikey: key, 'Content-Type': 'application/json'})
if (!keys.default) headers.set('Authorization', 'Bearer ' + key)

Deno.serve(request => receive(request, async (sample: unknown) => {
  const reply = await fetch(rpc, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers,
    body: JSON.stringify({sample}),
  })
  await reply.body?.cancel()
  if (!reply.ok) throw Error('Database write failed')
}))

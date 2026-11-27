/** Browser-to-inbox protocol. The supplied writer owns persistence and retry deduplication. */
const fields = ['id','revision','policy','version','day','suggestion','actual','previousUser','previousAssistant','filled','outcome','autoIntent','autoSevere','manualIntent','manualSevere']
const intent = [null,'hit','partial','miss']
const severity = [null,true,false]
const outcomes = [null,'exact','different','attachment','no-send']
const maxBytes = 4 * 1024 * 1024
const cors = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST, OPTIONS',
  'Access-Control-Allow-Headers':'content-type','Cache-Control':'no-store'}

export function validSample(s) {
  if (!s || typeof s !== 'object' || Object.keys(s).length !== fields.length || !fields.every(k=>Object.hasOwn(s,k))) return false
  const text = (v,max) => v === null || typeof v === 'string' && v.length <= max
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(s.id) ||
      !Number.isSafeInteger(s.revision) || s.revision < 1 || s.revision > 2**31-1 ||
      s.policy !== 'paired-text-v1' || !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/u.test(s.version) ||
      typeof s.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(s.day) ||
      !Number.isFinite(Date.parse(s.day)) || new Date(s.day).toISOString().slice(0,10) !== s.day) return false
  if (typeof s.filled !== 'boolean' || !text(s.suggestion, 1000) || !text(s.previousUser,1200) ||
      !text(s.previousAssistant,1200) || !text(s.actual,maxBytes) || !outcomes.includes(s.outcome) ||
      !intent.includes(s.autoIntent) || !intent.includes(s.manualIntent) ||
      !severity.includes(s.autoSevere) || !severity.includes(s.manualSevere)) return false
  if (!s.suggestion) return s.suggestion === null && !s.filled && s.outcome === null &&
    [s.actual,s.previousUser,s.previousAssistant,s.autoIntent,s.autoSevere,s.manualIntent,s.manualSevere].every(v=>v===null)
  if (s.outcome === 'exact') return s.actual === s.suggestion
  if (['different','attachment'].includes(s.outcome)) return typeof s.actual === 'string'
  return s.actual === null
}

export async function receive(request, write) {
  const response = code => new Response(null,{status:code,headers:cors})
  if (request.method === 'OPTIONS') return response(204)
  if (request.method !== 'POST') return response(405)
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return response(415)
  if (Number(request.headers.get('content-length')) > maxBytes) return response(413)
  const reader = request.body?.getReader()
  if (!reader) return response(400)
  let size = 0, raw = ''
  const decoder = new TextDecoder('utf-8',{fatal:true})
  let sample
  try {
    for (;;) {
      const {value,done} = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) { await reader.cancel(); return response(413) }
      raw += decoder.decode(value,{stream:true})
    }
    sample = JSON.parse(raw + decoder.decode())
  } catch { return response(400) }
  if (!validSample(sample)) return response(422)
  try {
    await write(sample)
    return response(204)
  } catch { return response(503) }
}

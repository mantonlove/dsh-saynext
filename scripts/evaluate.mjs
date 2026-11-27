/** 比较独立留出的预测；所有输入都由评测者提供，仅在执行此脚本时读取。 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const failures = new Set(['skip', 'failure', 'late', 'ineligible', 'unknown'])
const mistakes = new Set(['authorization', 'goal-change', 'invented-decision', 'wrong-actor'])
const assert = (condition, message) => { if (!condition) throw Error(message) }
const rate = (n, d) => ({n, d, percent: d ? Number((100 * n / d).toFixed(1)) : null})
const digest = data => createHash('sha256').update(data).digest('hex')

function indexed(rows) {
  assert(Array.isArray(rows), '缺少回合数组')
  const result = new Map()
  for (const row of rows) {
    assert(typeof row.id === 'string' && row.id && !result.has(row.id), '样本标识缺失或重复：' + row.id)
    result.set(row.id, row)
  }
  return result
}

export function validate(run) {
  assert(['observed', 'replay'].includes(run.mode) && typeof run.version === 'string' && run.version, '缺少版本或评测类型')
  for (const r of indexed(run.cases).values()) {
    const positive = r.status === (run.mode === 'observed' ? 'shown' : 'candidate')
    assert(positive || failures.has(r.status), '状态与评测类型不符：' + r.id)
    assert([true, false, null].includes(r.opportunity), '缺少展示机会判定：' + r.id)
    assert(!positive || (r.opportunity === true && typeof r.text === 'string' && r.text.trim()), '缺少机会或建议正文：' + r.id)
    assert(positive || r.text == null, '未展示的回合混入建议：' + r.id)
    assert((r.opportunity !== false || r.status === 'ineligible') && (r.status !== 'ineligible' || r.opportunity === false), '展示机会与状态矛盾：' + r.id)
    assert(r.opportunity !== null || r.status === 'unknown', '机会未知却已填观测结果：' + r.id)
    assert(typeof r.context === 'string' && r.context.length > 0, '缺少不含下一句的上下文标识：' + r.id)
  }
}

export function score(run, reviews = []) {
  validate(run)
  const labels = indexed(reviews)
  const rows = indexed(run.cases)
  let opportunities = 0, exposed = 0, unknownOpportunity = 0, unknownDisplay = 0
  let hits = 0, partial = 0, judged = 0, severe = 0, reviewed = 0
  let sent = 0, exact = 0, edited = 0, unsent = 0, unknownSend = 0
  const reasons = {}, categories = {}
  for (const id of labels.keys()) assert(rows.has(id), '评阅记录找不到预测：' + id)
  for (const r of rows.values()) {
    const positive = ['candidate','shown'].includes(r.status)
    const label = labels.get(r.id) ?? {}
    if (r.opportunity === null) unknownOpportunity++
    if (r.opportunity && r.status === 'unknown') unknownDisplay++
    if (r.opportunity) opportunities++
    reasons[r.status] = (reasons[r.status] ?? 0) + 1
    if (!positive) {
      assert(!labels.has(r.id), '只能评阅实际展示或回放产出的建议：' + r.id)
      continue
    }
    exposed++
    if (label.intent != null) {
      assert(['hit','partial','miss'].includes(label.intent), '无效意图标签：' + r.id)
      judged++
      hits += Number(label.intent === 'hit')
      partial += Number(label.intent === 'partial')
    }
    if (label.errors != null) {
      assert(Array.isArray(label.errors) && label.errors.every(e => mistakes.has(e)), '无效严重误判标签：' + r.id)
      reviewed++
      severe += Number(label.errors.length > 0)
      for (const e of new Set(label.errors)) categories[e] = (categories[e] ?? 0) + 1
    }
    if (run.mode === 'replay') {
      assert(label.send == null && label.filled == null, '历史下一句不能充当使用行为')
      continue
    }
    assert(label.filled == null || typeof label.filled === 'boolean', '填入草稿的状态无效')
    if (label.send === undefined || label.send === null) { unknownSend++; continue }
    if (label.send === false) { unsent++; continue }
    if (label.send?.attachments === true) { sent++; continue }
    assert(typeof label.send === 'string' && label.send.length > 0, '应填入已确认发送的下一句或 false')
    sent++
    if (label.send === r.text) exact++
    else if (label.filled === true) edited++
  }
  const coverage = rate(exposed, opportunities)
  // 已知有机会、但没观察到展示结局时给出范围，避免把观测缺失算成留空。
  if (unknownDisplay) coverage.percent = null
  const result = {
    version: run.version, mode: run.mode, rounds: rows.size,
    displayCoverage: run.mode === 'observed' ? coverage : null,
    replayOutputRate: run.mode === 'replay' ? coverage : null,
    unknownOpportunity, unknownDisplay, reasons, intent: rate(hits, judged), partial,
    unjudgedIntent: exposed - judged, severe: rate(severe, reviewed), categories,
    unreviewedSeverity: exposed - reviewed,
    directUse: run.mode === 'observed' ? rate(exact, sent) : null,
    editedAfterFill: edited, knownNoSend: unsent, unknownSend,
  }
  if (unknownDisplay) result.coverageBounds = [rate(exposed, opportunities), rate(exposed + unknownDisplay, opportunities)]
  return result
}

/** 先对齐整个固定样本和证据来源，再按预先声明的五个百分点判断覆盖是否接近。 */
export function compare(a, b) {
  validate(a); validate(b)
  const other = indexed(b.cases)
  assert(a.mode === b.mode && a.cases.length === b.cases.length && a.cases.every(r => {
    const match = other.get(r.id)
    return match && match.context === r.context && match.opportunity === r.opportunity
  }), '两个版本的样本、上下文、机会或评测类型不一致')
  const coverage = run => {
    const report = score(run)
    const m = report.displayCoverage ?? report.replayOutputRate
    return m.percent === null || report.unknownOpportunity ? null : m.n / m.d
  }
  const left = coverage(a), right = coverage(b)
  const delta = left === null || right === null ? null : Math.abs(left - right)
  return {coverageGapPoints: delta === null ? null : Number((delta * 100).toFixed(1)), comparableCoverage: delta !== null && delta <= 0.05 + Number.EPSILON}
}

/** 同题内容对照可混用实测与回放；每项仅计入双方都有该项评阅的回合。 */
export function pairedContent(a, labelsA, b, labelsB) {
  score(a, labelsA)
  score(b, labelsB)
  const other = indexed(b.cases)
  const left = indexed(labelsA), right = indexed(labelsB)
  const statuses = {}, source = [a.version, b.version]
  let jointlySuggested = 0
  const intent = [0, 0], partial = [0, 0], severe = [0, 0]
  let judged = 0, reviewed = 0
  assert(a.cases.length === other.size, '同题回合数量不一致')
  for (const row of a.cases) {
    const match = other.get(row.id)
    assert(match && match.context === row.context, '回合或对话前缀不同：' + row.id)
    const pair = row.status + '/' + match.status
    statuses[pair] = (statuses[pair] ?? 0) + 1
    if (!row.text || !match.text) continue
    jointlySuggested++
    const labels = [left.get(row.id), right.get(row.id)]
    if (labels.every(label => label?.intent != null)) {
      judged++
      labels.forEach((label, i) => { intent[i] += Number(label.intent === 'hit'); partial[i] += Number(label.intent === 'partial') })
    }
    if (labels.every(label => label?.errors != null)) {
      reviewed++
      labels.forEach((label, i) => { severe[i] += Number(label.errors.length > 0) })
    }
  }
  return {source, total:a.cases.length, statuses, jointlySuggested,
    intent:intent.map(n => rate(n, judged)), partial, severe:severe.map(n => rate(n, reviewed))}
}

function readFrozen(path) {
  const data = readFileSync(path)
  assert(readFileSync(path + '.sha256', 'utf8').trim() === digest(data), '封存后预测发生变化')
  return JSON.parse(data)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, path, reviewFile, second, secondReview] = process.argv.slice(2)
  if (command === 'freeze') {
    const data = readFileSync(path)
    validate(JSON.parse(data))
    writeFileSync(path + '.sha256', digest(data) + '\n', {flag:'wx', mode:0o600})
  } else if (command === 'paired') {
    assert(secondReview, 'paired 需要两组已封存的预测和评阅')
    const labels = file => JSON.parse(readFileSync(file, 'utf8'))
    console.log(JSON.stringify(pairedContent(readFrozen(path), labels(reviewFile), readFrozen(second), labels(secondReview)), null, 2))
  } else if (command === 'score') {
    const a = readFrozen(path)
    const reports = [score(a, JSON.parse(readFileSync(reviewFile, 'utf8')))]
    let comparison
    if (second) {
      const b = readFrozen(second)
      comparison = compare(a, b)
      reports.push(score(b, JSON.parse(readFileSync(secondReview, 'utf8'))))
    }
    console.log(JSON.stringify({reports, comparison}, null, 2))
  } else throw Error('使用 freeze 预测.json 或 score 预测.json 评阅.json [另一版预测.json 另一版评阅.json]')
}

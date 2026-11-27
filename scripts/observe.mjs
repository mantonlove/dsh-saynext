function visibleInWindow(element) {
  if (!element.checkVisibility({opacityProperty:true, visibilityProperty:true})) return false
  const {top,left,bottom,right,width,height} = element.getBoundingClientRect()
  const view = element.ownerDocument.defaultView
  return width > 0 && height > 0 && bottom > 0 && right > 0 && top < view.innerHeight && left < view.innerWidth
}

/** 仅由开发者在受控界面测试中调用。每次取一帧，同会话同回合重复渲染只记一次。 */
export function observeFrame(document, rounds, isVisible = visibleInWindow) {
  if (document.visibilityState !== 'visible') return
  for (const anchor of document.querySelectorAll('[data-saynext-opportunity="eligible"]')) {
    const card = anchor.closest('[data-composer-card]')
    if (!card || !isVisible(card)) continue
    const id = JSON.stringify([anchor.dataset.saynextSession, anchor.dataset.saynextTurn])
    const current = rounds.get(id) ?? {id, opportunity: true, status: 'unknown'}
    for (const ghost of card.querySelectorAll('[data-saynext="ghost"]')) {
      if (ghost.dataset.saynextSession !== anchor.dataset.saynextSession || ghost.dataset.saynextTurn !== anchor.dataset.saynextTurn) continue
      if (isVisible(ghost) && ghost.textContent) {
        current.status = 'shown'
        current.text = ghost.textContent
        break
      }
    }
    rounds.set(id, current)
  }
}

/** 从受控测试的 DSH 日志确认后续发送；缺少完整观察期时保留未知。 */
export function followup(log, turn, observationClosed = false) {
  const end = log.findIndex(e => e.type === 'turn/end' && e.data.turn === turn)
  if (end < 0) return null
  const next = log.slice(end + 1).find(e => e.type === 'turn/end' || (e.type === 'user/message' && e.data.source?.kind === 'user'))
  if (next?.type === 'turn/end') return false
  if (!next) return observationClosed ? false : null
  const body = next.data.content
  if (typeof body === 'string') return body || null
  if (!Array.isArray(body)) return null
  if (body.some(b => b.type !== 'text')) return {attachments: true}
  return body.map(b => b.text).join('') || null
}

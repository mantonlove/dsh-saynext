# dsh-saynext 还能改哪儿（草稿清单）

审阅对象：dsh-saynext 0.1.2，宿主 lib/index.js（253 行）、界面 lib/client.js（191 行）、README。
下面按「必须修 / 值得修 / 可选」三档排列，每条给位置、为什么、不改会怎样。

## 必须修

1. **并发生成时旧快照可能覆盖新快照**（lib/index.js L190-215）
   `publish()` 在调用时就序列化 `bank`，然后 `await settings.update(...)`；两条会话同时收尾时，A 先算出 rev=5 的载荷、B 后算出 rev=6 的载荷，若 B 的写入先落地、A 的后落地，最终 hint 里是 rev=5 的旧内容，刚生成的建议消失，直到下一轮才恢复。
   改法：把写入串成一条 promise 链，或写入前比对已落盘 rev，小于等于已写 rev 的直接丢弃。
   最小复现：两条会话在同一秒内先后收尾，让 update 的 resolve 顺序反过来（或直接在 settings.update 里注入 50-200ms 的随机延迟），读回 hint 看 rev 是否回退。

2. **流以 error 收尾时会把半截话入库**（lib/index.js L161-172）
   循环里遇到 `chunk.type === 'finish'` 且 `reason.kind === 'error'` 时只写了一行 trace（L165-167），`raw` 不动，最后照样 `return tidy(raw)`。上游中途报错时，已经拼到的半截话会被当成建议显示，用户按 Enter 填进去的是一句断掉的指令。
   （20 秒超时那条路径是抛异常，会被 `.catch` 吃掉、不写库，所以只限制在「流正常结束但 reason 是 error」这一种情形。）
   改法：置错误标志，这种收尾下返回空串，`ask()` 直接 return。
   最小复现：stub 一个先吐两段 text-delta、再以 `finish(reason.kind='error')` 结束的流，看 `tidy()` 是否把半截话写了进去。

## 值得修

3. **成本没有闸门**（lib/index.js L28-33、L68-80、L51-53）
   每条会话每一轮都调一次模型，没有冷却、没有最小内容门槛、Config 里也没有开关。用户开三条会话连续问短问题时会连发请求。
   改法：Config 增加 `enabled`、`cooldownMs`、`minTranscriptChars`；同一会话在冷却期内或转写过短时跳过。

4. **旧建议会滞留，界面上又没有任何「这一轮还没算完」的标记**（lib/index.js L73-79、L95-108；lib/client.js L141-144）
   两个叠加的问题：
   - 宿主侧：`busy` 命中时直接 return，不排队、不补发；上一轮的建议还在生成时新的一轮又结束了，这次收尾就没有新建议。
   - 界面侧：`show` 只看「有文本、草稿为空、会话没在跑」，不判断这条建议属于哪个回合。于是从 turn 结束到新建议写回这段时间（实测生成 1-11 秒），屏幕上一直是上一轮的旧建议，用户这时按 Enter 会填进去一句过时的话；生成失败时这条旧建议会一直挂着，直到同一会话后面某一轮成功。
   改法：宿主在 turn/end 时先把该会话的条目从 bank 里摘掉（或标成 pending），写入新的才恢复；界面按 `turn`/`rev` 判断是否属于当前回合，不匹配就不显示。

5. **隐私说明不完整，日志还落明文**（lib/index.js L14-24、L99；README L59-70、L82）
   README 已经写了「取最近 4 轮对话发给模型」和「建议存在 saynext 的 hint 字段」，没写的是：对话发往的是**用户自己在 DSH 里配置的那个 provider**，以及这条外发意味着什么。
   另一处：`DSH_SAYNEXT_TRACE=1` 时把建议正文和会话 id 写进 `/tmp/dsh-saynext.log`。`appendFileSync` 不带 `mode` 时按 Node 默认（0o666 减 umask，通常 0644）；而且 `mode` 只在创建新文件时生效，既有的旧文件权限不会因此改变。
   改法：README「数据去哪了」补一句接收方；日志改到用户目录、创建时传 `{ mode: 0o600 }`，并对既有文件补一次 chmod，或只记长度不记正文。

6. **setDraft 不存在时仍然吃掉 Enter**（lib/client.js L148-158，兼容性防御）
   先 `preventDefault()` 再 `inputActions?.setDraft?.(text)`；一旦槽位没给 inputActions（版本差异、注册方式变化），用户按 Enter 什么都不会发生，比不接管更糟。
   改法：先判断 `typeof inputActions?.setDraft === 'function'`，不可用就整个 return。

7. **缓存是 FIFO 不是 LRU**（lib/index.js L102-107）
   `bank.set` 更新已有会话时不会把它挪到队尾，长期活跃的会话可能因为位置靠前被先淘汰。
   改法：写入前先 `delete` 再 `set`。

8. **provider/model 取不到时整条链路静默停摆**（lib/index.js L88-93）
   用 `session.requestHeader()?.config` 拿 provider 与 model，拿不到就 return，界面上永远不会有建议，也没有任何提示。会话如果用全局默认模型，这里可能取空。
   改法：取不到时回退到会话的默认配置来源，或在 README 里明确这条前置条件。
   待核实：`requestHeader()` 在「会话没有显式指定模型、走全局默认」时到底返回什么——trace 里能看到 `provider=undefined`，但没有验证是否所有默认路径都会这样。

## 可选

9. **轮询没有退避**（lib/client.js L116-139）
   每秒一次 RPC，窗口最小化、会话空闲时照拉。改法：`document.hidden` 时暂停，rev 连续多次不变时把间隔拉长到 3-5 秒。

10. **无障碍缺位**（lib/client.js L162-171）
    建议正文没有 `role="status"` / `aria-live`，`⏎` 只是一个符号；`aria-hidden: 'false'` 无实际作用。
    改法：正文加 `role="status"`，另放一段视觉隐藏文本「按 Enter 填入输入框」。

11. **建议字数与提示词不一致**（lib/index.js L185 与 L38）
    提示词要求 30 个汉字以内，`tidy()` 实际截到 60 字。界面是 `whiteSpace: 'nowrap'` 单行省略，所以不会换行，只是被截短的建议会以省略号出现，语义可能不完整。改法：把两处对齐成同一个常量（低优先级）。

12. **`remote` 只在 apply 时取一次**（lib/client.js L177-178，防御性）
    `const remote = ctx.get('remote')` 在注册时求值，`readHint` 闭包里捕获的是那一刻的对象；如果将来槽位注册早于 remote 就绪，读建议会永远拿不到、而且没有重试。
    改法：`const readHint = () => ctx.get('remote')?.settings`，每次轮询现取。
    注意：界面侧 `inject` 已经声明了 `'remote'` 与 `'remote.settings'`（L174），按 Cordis 语义 apply 执行时依赖应当已就绪，所以这条是面向未来注册顺序变化的加固，不是当前已发生的故障。

13. **未使用的服务声明**（lib/index.js L54）
    `inject` 里声明了 `sessions`，代码里只用了 `ctx.llm` 和 `session/event`，没用 `ctx.sessions`。要么删掉，要么用它做会话删除时的缓存清理。

14. **`publish()` 每次都新建一个 inject 作用域**（lib/index.js L201-214，待核实）
    每轮收尾都 `ctx.inject(['settings'], cb)` 一次。按 Cordis 语义，这会在依赖就绪时执行回调并保留该 fiber；settings 一直可用时大概只是「建了就用完」，但缺少生命周期证据，不能断定不会累积。
    若真会累积，还会和第 1 条叠加：settings 服务重启时这些回调一起触发，会用各自捕获的旧载荷重复 update，放大旧快照覆盖新快照。
    建议：把 `settings` 写进静态 `inject` 直接用 `ctx.settings`，或补一份「连续 50 轮后 ctx 里 fiber 数量不变」的验证。

---

## 审稿人补充（PASS 之后给的建议，未改上面的条目）

- **第 14 条还有一个更坏的失败模式**：`settings` 服务如果一直不可用，`publish()` 里那个 Promise 永不 resolve，`ask()` 就一直挂着，`.finally` 永远不执行，`busy` 里这条会话永远不会被清掉——此后该会话每一轮都会被静默跳过。建议直接给 `publish()` 加超时兜底。
- **第 5 条的日志还有一层风险**：`/tmp/dsh-saynext.log` 是固定文件名，多用户主机上 `appendFileSync` 会跟随别人预先放好的符号链接。改到用户目录正好把这一条也消掉。
- **第 4 条界面侧的改法需要前提**：`NextLine` 的 props 和 `useSession` 快照里有没有「当前回合号」目前没有证据。如果拿不到，只做宿主侧「turn/end 时先摘掉该会话条目」也能闭环，不必两边都改。
- **第 8 条的升级条件**：如果真机确认「走全局默认模型的会话稳定取空 provider/model」，这条要从「值得修」升到「必须修」——功能对这类会话完全失效，而且没有任何提示。

# dsh-saynext

给 DSH 输入框加一条「下一句」：每轮回答结束后，宿主拿这段对话去问一次模型，
猜你紧接着最可能说的那句话，显示成输入框上方的一条灰字。

输入框留空时它才出现；按 **Enter** 把这句话搬进输入框（**不发送**），
再按一次 **Enter** 才真正发出去。输入框里有字时它自动让开。

## 装法（本地 link）

```bash
# 1. 本仓库放进 profile 的依赖里
cd ~/.dsh/profiles/desktop
# package.json 的 dependencies 加：
#   "dsh-saynext": "link:/绝对路径/到/dsh-saynext"
# 再把它加进 dsh.profile.bundles
pnpm install
```

`lib/index.js` 依赖运行时的 `@deepseek-ai/schemastery`（DSH 自带，不在 npm 上）。
若装在别的目录、Node 解析不到它，就在本仓库里放一条软链：

```bash
mkdir -p node_modules/@deepseek-ai
ln -s ~/.dsh/profiles/desktop/node_modules/@deepseek-ai/schemastery \
      node_modules/@deepseek-ai/schemastery
```

改完 `lib/` 下的代码要**重启 App** 才生效（宿主插件只在启动时加载一次）；
只改客户端表现时刷新窗口即可。

## 配置

插件配置只有一格：

| 键 | 作用 |
| --- | --- |
| `hint` | 宿主写给界面的载荷（JSON 字符串），界面每秒读一次。人不填 |

想关掉它，把 `dsh.profile.bundles` 里的 `dsh-saynext` 去掉即可。

## 它怎么工作

- **宿主**（`lib/index.js`）：监听 `session/event`，只在
  `turn/end` 且 `reason.kind === 'completed'` 时动手；把最近 4 轮对话拼成一段
  纯文本，走会话自己的 provider/model 调一次 `ctx.llm.stream`，把结果收拾成
  一行（≤30 字、去引号、去前缀），存进内存小本子（每个会话一条，最多 8 条），
  再用 `settings.update('saynext', { hint })` 写进配置。
- **界面**（`lib/client.js`）：注册在 `conversation.input.overlay`
  槽位上（session 级），每秒读一次 `hint`，只认 `sessionId` 与自己相同的那条；
  草稿为空时显示，捕获阶段吃掉裸 Enter 并 `setDraft`。

两边的唯一耦合就是 `hint` 这一格 JSON：

```json
{ "rev": 4, "items": [{ "sessionId": "…", "text": "…", "turn": 25, "rev": 1, "at": 1794960197699 }] }
```

## 已知边界

- 建议只对「这一轮正常收尾」触发；中断、报错收尾不生成。
- 生成要一次模型调用，实测 1–3 秒；模型是推理型时会把预算花在思考上，
  所以 `MAX_TOKENS` 给了 400，不是 96。
- `hint` 是明文写在 `cordis.patch.yml` 里的，会包含你说过的话。介意的话
  可以在设置里关掉插件，或把 `publish()` 改成写临时文件。
- App 每次启动后要等第一条会话收尾才会有新建议。

## 许可

MIT，见 [LICENSE](./LICENSE)。

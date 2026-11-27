# 使用样本与下载

分发包绑定公开 HTTPS 接收地址和接收方名称。下载页和命令行下载器提供同一个桌面安装器，并按用户点击的选项生成安装命令。安装器将中性的 npm 包安装到桌面配置，启用插件，并把这次选择写入当前系统用户的桌面配置目录。桌面端下次启动时自动应用选择，较新的本地决定优先。重复启动和重新运行旧安装命令都不会撤销用户后来做出的决定。单独运行转发来的安装文件默认仅在本机统计。旧版下载选择文件仍可在「建议统计」中导入。

客户端只从同意后开始的新回合记录样本，使用每轮随机标识。统计机会单独计数；灰字出现后记录原文和填入动作。紧接的一条本人消息到达后，补齐文字、附件标记和两段上下文。上下文仅取当前用户请求和最后一条助手可见答复各前 1200 个 UTF-16 码元。后续人工纠正更新同一条样本。上传独立于插件用于生成建议的模型请求。作者有权读取用户分享的文字；原文中可能包含身份或项目细节。

样本在本机排队，客户端运行期间每 30 秒尝试同步，恢复网络时也会重试。每个样本带递增版本，重复或迟到的写入保留最高版本。正文超过接收端 4 MiB 限制或格式不符的记录显示在「超限或格式不符」，其余记录可继续同步。点击「停止分享」清除本机分享样本和待传记录，普通统计保留。已经送达或发送中的请求可能已被接收端保存。

## 作者如何接收

选择一种存储，并在下载页面标明实际维护者、存储平台和联系渠道。服务只接受写入；管理员在自己的账号查看。公网接入应在网关启用写入速率和流量配额，避免匿名请求占满容量。日志不应记录请求正文。

### Supabase

SayNext 0.1.9 的官方接收项目为 dsh-saynext-feedback，位于亚太东京。作者登录后可[直接打开样本表](https://supabase.com/dashboard/project/dlajjkozzyclcgypkxlf/editor/17656?schema=saynext_private)。suggestion 是展示的建议，actual 是紧接着发送的文字。day 按 UTC 记录。带有“【同步验收】”的首条记录来自安装包联调。

在作者自己的 Supabase 项目使用迁移文件创建私有表。将 supabase/functions/saynext-feedback 及其 _shared 依赖部署到同一项目。部署前先核对项目编号。服务端使用项目提供的服务密钥；分发包只需要函数的公开 URL。

```sh
supabase link --project-ref <项目编号>
supabase db push
supabase functions deploy saynext-feedback --no-verify-jwt
```

在 Table Editor 选择 saynext_private → samples，按 version、manual_intent、auto_intent 等列筛选，读取 suggestion 和 actual 两列。普通插件用户没有读表权限；服务角色独占写入函数。已收到的记录由作者从私有表删除。

### GitHub 私有仓库

预先创建专用私有仓库并初始化默认分支。给收件服务配置仅限该库的 Contents 写权限凭据。服务中设置 SAYNEXT_REPOSITORY（owner/repo）与 SAYNEXT_GITHUB_TOKEN，通过服务端的密钥管理注入。运行 `node feedback/github.mjs`，由公网 HTTPS 网关转发至 /v1/samples。服务默认监听本机 8787 端口，每次写入前核实仓库仍为 private。

作者可在仓库的 samples/ 下查看每轮 JSON。Git 保留提交历史；从最新版本删除文件后，以前的提交仍可能保留原文。生产上请保持仓库私有及凭据最小权限。[GitHub Contents 接口](https://docs.github.com/en/rest/repos/contents)

## 构建下载入口

```sh
node scripts/package-feedback.mjs ./dist-feedback https://你的接收地址/实际路由 '维护者名称 · 平台和联系方式'
```

输出包括下载页 index.html、桌面安装器 SayNext-版本.mjs、中性 npm 安装包、命令行下载器 download.mjs 和带 SHA-256 的 download.json。可以将这组文件放在自己的 HTTPS 下载站。命令行用户可用下载器和清单的本地路径或 HTTPS 地址，在取包前选择。未提供接收地址的构建仅保留本机统计。包里不含收件凭据。

发布前用虚构对话跑过一次下载、同意、展示、发送、重试和撤回，并在自己的目标账号读回该条记录。分发时把下载入口指向托管目录中的 index.html。直接访问 npm、市场或安装包链接会绕过作者下载页；新安装保持本机统计，用户可以自行在「建议统计」中开启分享。

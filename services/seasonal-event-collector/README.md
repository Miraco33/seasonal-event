# Seasonal Event Collector

独立的活动采集与标准化服务。它使用 Node.js、TypeScript 和 Playwright，输出新版 `events-v2.json`、旧客户端兼容文件 `events.json` 和候选诊断报告。收录传统季节活动以及 FF15、妖怪手表、糖豆人等国服游戏内限时联动；不收录莫古莫古大收集及抽奖、充值、商城、社区等运营活动。

## 运行方式

本地调试：

```powershell
npm ci
npm run build
npm test
npm run discover
npm start -- --dry-run
node scripts/verify-live.mjs --rounds=3
```

如需把本机 dry-run 的预览保存为文件，可先设置 `PREVIEW_OUTPUT_FILE`；不设置时完整预览仍会输出到终端：

```powershell
$env:PREVIEW_OUTPUT_FILE = Join-Path $PWD "output/preview.json"
npm start -- --dry-run
```

历史官网模板兼容性可用 `npm run audit:history` 复查；页面清单、结果基线和已知图片字段限制见 `../../docs/HISTORICAL_COMPATIBILITY.md`。

若本机没有 Playwright 管理的 Chromium，但已经安装 Chrome 或 Edge，可把 `PLAYWRIGHT_EXECUTABLE_PATH` 指向浏览器可执行文件；Docker 镜像已自带匹配的浏览器，不需要设置。

已有公共来源、稳定活动 ID 和人工核验数据统一保存在 `config/collector.json`。环境变量仍可追加来源或覆盖同名活动的数据，兼容已部署的旧 `.env`。新来源使用规范化专题 URL 哈希生成稳定 ID，不随活动标题改变；已有显式 ID 映射继续使用，保护角色提醒和忽略状态。

`npm run discover` 只执行发现与候选诊断，不发布活动。发现阶段默认回看 180 天，并以有界分页读取盛趣新闻 API，从传统季节活动或明确游戏内限时联动的公告中提取官方专题。它不依赖 `【季节活动】` 标题前缀，避免漏掉联动公告。

正式运行会自动采集新发现的来源：标题、起止时间和官方 HTTPS 来源均可核验时，已获得资料自动进入 schema 2 数据。未知任务、NPC、地点保持 `null`，尚未提取的奖励为 `[]`，不会为了通过校验补造数据。标题或时间仍无法可靠获取的专题进入待审核报告，不能发布为活动。已经发布且仍开放或尚未开始的活动持续追踪公告与专题，不受首次发现的 180 天窗口限制。退出码 `2` 表示存在待审核候选或运营告警；退出码 `1` 表示运行失败。

Docker：

```powershell
Copy-Item .env.example .env
docker compose build
docker compose run --rm collector
```

Oracle 云服务器使用同一镜像和同一 `.env`，由 cron 或 systemd 定期执行即可，不需要修改容器代码。

## 发布模式

- `PUBLISH_MODE=filesystem`：新版写入 `OUTPUT_FILE`（`events-v2.json`），兼容子集写入 `LEGACY_OUTPUT_FILE`（`events.json`），适合本机、Docker 挂载和 GitHub Actions。
- `PUBLISH_MODE=github`：使用最小权限 `GITHUB_TOKEN` 调用 GitHub Contents API 更新数据文件。

schema 2 允许部分资料，最低要求为可靠标题、有效起止时间、稳定 ID、HTTPS 来源及验证时间。旧 `events.json` 保持 schema 1，只包含任务名称、NPC、已核验世界坐标和奖励均完整的活动子集；资料不完整的活动不会混入旧文件导致 1.0.0 客户端整份数据校验失败。

采集器只在活动语义或采集告警状态发生变化时发布并递增 `dataVersion`。比较时忽略文档级 `dataVersion`、`publishedAt` 和每个活动的 `lastVerifiedAt`；其他字段、字段值和数组顺序都参与比较。内容未变化时日志包含 `changed=false`，不会覆盖文件或调用 GitHub 更新接口，已有版本号和时间戳保持不变。对象属性的书写顺序不影响比较。

每次运行向标准输出写一条 `seasonal-event-collector-status` JSON。网络重试另写 `seasonal-event-collector-diagnostic` JSON。设置 `STATUS_OUTPUT_FILE` 后，最新完整状态会原子写入该文件；`CANDIDATE_OUTPUT_FILE` 则保存不含运行 ID、时间戳或剩余小时数的语义稳定报告，便于 GitHub 自动化在状态真正变化时通知维护者。dry-run 总会把已经通过完整校验、但不会正式发布的预览文档写到标准输出；设置 `PREVIEW_OUTPUT_FILE` 后还会原子保存到指定文件。

仓库的 `candidate-alert.yml` 在候选报告变为待审核、换期告警或采集错误时创建或更新一个 GitHub Issue；状态恢复为明确的 `ok` 后自动关闭。它监听报告的 Git 变化，不按每次云端运行重复发消息；GitHub 个人通知还取决于仓库/Issue 订阅设置。状态页公开展示候选和采集告警，插件通过 schema 2 的 `collectionStatus` 明确提示列表可能不完整。

单个来源抓取或解析失败时，保留该来源上次已核验活动，同时将 `collectionStatus.status` 设为 `alert` 并列出无法核验的来源。没有可靠标题或时间的新来源不能冒充有效活动。致命运行错误不会用失败输出替换正式活动文件；Oracle 包装脚本仍可发布候选诊断以暴露故障。

`filesystem` 模式读取 `OUTPUT_FILE`，并用同目录锁文件阻止两个定时或手动任务同时发布；获得锁后还会重新核对语义和版本，目标已被其他任务更新时会跳过重复内容或安全失败。`github` 模式读取目标分支的当前 JSON，并以同一次读取取得的 SHA 做条件更新。目标文件尚不存在时从 `1` 开始。已有文件无法读取、JSON 损坏或缺少有效 `dataVersion` 时任务会失败，不会把版本重置为 `1`。

进程正常结束时会清理锁文件。如果宿主机在发布过程中断电或被强制结束，需确认没有采集进程仍在运行，再删除 `OUTPUT_FILE` 同目录下残留的 `.lock` 文件。

采集结果为空时任务默认失败，防止官网 DOM 变化把已有 feed 覆盖为空。只有确认空 feed 是预期结果时，才可显式设置 `ALLOW_EMPTY_EVENTS=true`；其他值（包括 `false` 和 `TRUE`）都不会解除保护。

`--dry-run` 仍会抓取、执行空列表保护和校验、读取当前版本并计算 `changed`，但不会替换正式新版或旧版活动文件，也不会向 GitHub 发送更新请求。若配置了状态、候选或预览输出，它只写这些诊断文件。生产定时任务应先核对预览内容、`eventCount`、采集告警及旧客户端子集。

采集和校验失败时进程返回非零状态，不覆盖已有的正式活动数据。Oracle 包装脚本可以单独提交状态为 `error` 的候选运营报告以触发告警；`github` 发布模式仍只在活动数据校验通过后提交。

## 当前限制

官网活动页格式并不稳定，有些任务、NPC、时间或奖励只出现在图片中。采集器优先读可核验的页面文字、图片说明及官方公告；无法确定的字段保持未知，不把“活动概要”等栏目名称当作任务。经人工核验的补充资料可放在版本化覆盖配置中。

页面坐标只作为显示坐标；地图世界坐标必须由活动级映射提供，缺失时 schema 2 的 `location` 为 `null`，客户端禁用地图按钮。页面没有可提取的显示坐标时，只要活动级映射已经提供可靠世界坐标，仍可使用该映射。

`config/collector.json` 中的 `overrides.locations` 是按稳定活动 ID 保存的世界坐标映射。有地图资料的活动必须独立提供有效 `territoryId`、`mapId`、`x`、`y` 和 `z`；不可把官网显示坐标当作世界坐标。旧的 `LOCATION_OVERRIDES` 环境变量继续可用，并覆盖文件中的同名条目。例如：

```json
{
  "seasonal-aae61e8dfaea": {
    "territoryId": 128,
    "mapId": 11,
    "x": -9.61439,
    "y": 39.9998,
    "z": 82.0985
  }
}
```

缺失映射不会阻断 schema 2 的活动时间提醒；已提供但无效的映射仍拒绝发布。没有地图映射的活动不会进入 schema 1 兼容子集。

官网经常只用图片展示奖励，当前抽样历史页仍需要人工核验。使用 `overrides.rewards` 提供奖励数组；旧 `REWARD_OVERRIDES` 环境变量继续作为覆盖层。每项包含 `name`、`category`、`description` 和字符串数组 `flags`。例如：

```json
{
  "seasonal-aae61e8dfaea": [
    {
      "name": "迷你乌克·拉玛特",
      "category": "宠物",
      "description": "",
      "flags": []
    }
  ]
}
```

schema 2 在尚未提取奖励时保留 `[]`，客户端显示“官网信息尚未提取”，不推断活动没有奖励。已提取的每个奖励必须有有效名称；只读到部分奖励时不能声称完整清单。schema 1 兼容子集仍要求至少一项有效奖励。

## 完成状态数据

官网活动页通常不提供数字形式的游戏任务与成就 ID。使用 `overrides.completion` 提供经人工核验的 `questId`、`achievementId`，以及需要时的 `teleport`；旧 `COMPLETION_OVERRIDES` 环境变量继续作为覆盖层。例如：

```json
{
  "seasonal-aae61e8dfaea": {
    "questId": 71046,
    "achievementId": 3875,
    "teleport": {
      "aetheryteId": 8,
      "subIndex": 0
    }
  }
}
```

`questId` 和 `achievementId` 可以省略或设为 `null`；此时插件无法用对应状态排除已完成活动。两种映射都缺失时，数据本身无法自动判断完成状态。

## 发现、补充资料与待审核处理

1. 运行 `npm run discover`。候选同时出现在标准输出和 `CANDIDATE_OUTPUT_FILE`；该命令不采集正式来源，也不发布。
2. 正式采集自动处理符合产品范围的新专题，可靠核心资料不再依赖维护者每次手动批准。无关或误识别候选仍可加入 `sources.ignored`；需要持续观察的链接可加入 `sources.pending`。
3. 对真正缺少标题或时间的专题核对公告与页面。保留已有稳定 ID，不因标题或资料补齐更换 ID；确有外部约定时才新增显式 `eventIds` 映射。
4. 根据可靠证据补充任务/NPC 元数据、`overrides.locations`、`overrides.rewards` 和 `overrides.completion`。不能猜测地图、任务或成就 ID，也不能把未知字段补为占位数据。
5. 运行 `npm start -- --dry-run`，从标准输出或 `PREVIEW_OUTPUT_FILE` 核对 v2 活动、缺字段、`collectionStatus` 和 schema 1 子集。已经发布的活动失败时，应确认上一版资料仍保留且告警可见。
6. 新模板或修复应加入解析/发现回归，并运行三轮实时官网验收。配置和代码提交后，云端仍需按批准范围重建采集器镜像并验证，再允许完整发布流程。

默认 `NEXT_EVENT_WARNING_HOURS=168`。没有已发布的下一活动时，当前活动即将结束或已结束仍可产生换期告警，写入稳定候选报告并以退出码 `2` 结束。服务成功运行且没有 Git 差异不等于已经收录全部官网活动，应同时检查候选、采集状态和公开状态页。

## 调度示例

容器是一次执行、无状态的任务，不在内部常驻调度。Docker Desktop、Oracle Cloud 或其他 Linux 主机均可用同一个镜像：

```sh
0 */6 * * * cd /opt/oracle-services/seasonal-event/services/seasonal-event-collector/deploy/oracle && docker compose -f compose.yml run --rm collector >> collector.log 2>&1
```

`filesystem` 模式使用挂载的 `output/` 目录；`github` 模式只需把最小权限 Token 作为环境变量或 Docker Secret 提供给容器。不要把 `.env` 或 Token 提交到仓库。

发布前应先运行 `npm start -- --dry-run`。该模式会采集和校验，但不会替换正式活动文件，适合在本机和 Oracle 云主机上做定时任务前验证。更新采集器代码后必须重建镜像；已有云端服务升级时应遵循 Oracle README 的定时器暂停、任务排空、重建和验证顺序，防止旧镜像按新版输出路径写入错误格式。

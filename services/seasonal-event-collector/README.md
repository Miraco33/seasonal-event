# Seasonal Event Collector

独立的活动采集与标准化服务。它使用 Node.js、TypeScript 和 Playwright，输出与 Dalamud 插件约定的 `events.json`。

## 运行方式

本地调试：

```powershell
npm install
npm run build
npm test
npm run discover
npm start -- --dry-run
```

历史官网模板兼容性可用 `npm run audit:history` 复查；页面清单、结果基线和已知图片字段限制见 `../../docs/HISTORICAL_COMPATIBILITY.md`。

若本机没有 Playwright 管理的 Chromium，但已经安装 Chrome 或 Edge，可把 `PLAYWRIGHT_EXECUTABLE_PATH` 指向浏览器可执行文件；Docker 镜像已自带匹配的浏览器，不需要设置。

公共来源、稳定活动 ID 和人工核验数据统一保存在 `config/collector.json`。环境变量仍可追加来源或覆盖同名活动的数据，兼容已部署的旧 `.env`；新活动应优先修改可审查、可回滚的版本化配置。

`npm run discover` 只读取盛趣新闻 API 中标题以 `【季节活动】` 开头、且在 `DISCOVERY_LOOKBACK_DAYS` 范围内的新闻，再从新闻详情提取官方专题链接。发现结果始终标记为 `pending`，不会自动加入正式来源或发布为活动数据。退出码 `2` 表示发现待审核候选或存在运营告警；退出码 `1` 表示采集器本身运行失败。

Docker：

```powershell
Copy-Item .env.example .env
docker compose build
docker compose run --rm collector
```

Oracle 云服务器使用同一镜像和同一 `.env`，由 cron 或 systemd 定期执行即可，不需要修改容器代码。

## 发布模式

- `PUBLISH_MODE=filesystem`：写入 `OUTPUT_FILE`，适合本机、Docker 挂载和 GitHub Actions。
- `PUBLISH_MODE=github`：使用最小权限 `GITHUB_TOKEN` 调用 GitHub Contents API 更新数据文件。

采集器只在活动语义发生变化时发布并递增 `dataVersion`。比较时忽略文档级 `dataVersion`、`publishedAt` 和每个活动的 `lastVerifiedAt`；其他字段、字段值和数组顺序都参与比较。内容未变化时日志包含 `changed=false`，不会覆盖文件或调用 GitHub 更新接口，已有版本号和时间戳保持不变。对象属性的书写顺序不影响比较。

每次运行向标准输出写一条 `seasonal-event-collector-status` JSON。网络重试另写 `seasonal-event-collector-diagnostic` JSON。设置 `STATUS_OUTPUT_FILE` 后，最新完整状态会原子写入该文件；`CANDIDATE_OUTPUT_FILE` 则保存不含运行 ID、时间戳或剩余小时数的语义稳定报告，便于 GitHub 自动化在状态真正变化时通知维护者。

`filesystem` 模式读取 `OUTPUT_FILE`，并用同目录锁文件阻止两个定时或手动任务同时发布；获得锁后还会重新核对语义和版本，目标已被其他任务更新时会跳过重复内容或安全失败。`github` 模式读取目标分支的当前 JSON，并以同一次读取取得的 SHA 做条件更新。目标文件尚不存在时从 `1` 开始。已有文件无法读取、JSON 损坏或缺少有效 `dataVersion` 时任务会失败，不会把版本重置为 `1`。

进程正常结束时会清理锁文件。如果宿主机在发布过程中断电或被强制结束，需确认没有采集进程仍在运行，再删除 `OUTPUT_FILE` 同目录下残留的 `.lock` 文件。

采集结果为空时任务默认失败，防止官网 DOM 变化把已有 feed 覆盖为空。只有确认空 feed 是预期结果时，才可显式设置 `ALLOW_EMPTY_EVENTS=true`；其他值（包括 `false` 和 `TRUE`）都不会解除保护。

`--dry-run` 仍会抓取、执行空列表保护和校验、读取当前版本并计算 `changed`，但不会写入临时文件、挂载目录或向 GitHub 发送更新请求。生产定时任务应先在日志中确认 `eventCount` 与预期一致。

采集和校验失败时进程返回非零状态，不覆盖已有输出。`github` 模式只在校验通过后提交。

## 当前限制

官网活动页格式并不稳定。采集器读取页面数据和 tooltip，但页面坐标只作为显示坐标；地图世界坐标必须由活动级映射提供，缺失时不会发布错误旗标。页面没有可提取的显示坐标时，只要活动级映射已经提供可靠世界坐标，采集仍可继续。

`config/collector.json` 中的 `overrides.locations` 是按稳定活动 ID 必填的世界坐标映射，每个活动都必须独立提供 `territoryId`、`mapId`、`x`、`y` 和 `z`。旧的 `LOCATION_OVERRIDES` 环境变量继续可用，并覆盖文件中的同名条目。例如：

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

任一活动缺失映射都会让整次采集失败，并保留已有的上一版 JSON。

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

发布数据中的每个活动必须至少有一项有效奖励。页面提取和 `REWARD_OVERRIDES` 都未提供奖励时，校验会失败并保留上一版 JSON。

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

## 下一活动审核流程

1. 运行 `npm run discover`。候选同时出现在标准输出和 `CANDIDATE_OUTPUT_FILE`；该命令不采集正式来源，也不发布。
2. 打开候选专题，确认它属于插件的产品范围。无关候选加入 `sources.ignored`；需要持续观察但尚未确认的链接加入 `sources.pending`。
3. 对确认收录的页面先在 `eventIds` 中指定永久 ID。ID 与来源 URL 绑定，不随官网标题变化；缺少映射的正式来源会立即失败。
4. 在 `overrides.locations`、`overrides.rewards` 和 `overrides.completion` 补充人工核验数据。候选报告中的 `reviewGaps` 会列出尚缺的稳定 ID 和各类覆盖项；`detail_fields_not_inspected` 表示仍需人工核对标题、时间、NPC、等级和页面奖励。
5. 临时通过 `SOURCE_URLS` 加入该 URL，运行 `npm start -- --dry-run`，核对结构化结果且确认 `eventCount` 正确。
6. dry-run 通过后把 URL 加入 `sources.approved`，从 `sources.pending` 移除，再提交配置。正式定时任务只采集 `sources.approved`，不会把自动发现结果直接上线。

默认 `NEXT_EVENT_WARNING_HOURS=168`。当前没有已审核的未来活动时，任一进行中活动进入最后 168 小时会产生 `event_ending_without_candidate`；活动已经结束且仍无候选时产生 `no_active_event_without_candidate`。两者都写入稳定候选报告并以退出码 `2` 结束，使 systemd 明确显示需要维护者处理。

## 调度示例

容器是一次执行、无状态的任务，不在内部常驻调度。Docker Desktop、Oracle Cloud 或其他 Linux 主机均可用同一个镜像：

```sh
0 */6 * * * cd /opt/oracle-services/seasonal-event/services/seasonal-event-collector/deploy/oracle && docker compose -f compose.yml run --rm collector >> collector.log 2>&1
```

`filesystem` 模式使用挂载的 `output/` 目录；`github` 模式只需把最小权限 Token 作为环境变量或 Docker Secret 提供给容器。不要把 `.env` 或 Token 提交到仓库。

发布前应先运行 `npm start -- --dry-run`。该模式会采集和校验，但不会替换已有 `events.json`，适合在本机和 Oracle 云主机上做定时任务前验证。

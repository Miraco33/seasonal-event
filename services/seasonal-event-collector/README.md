# Seasonal Event Collector

独立的活动采集与标准化服务。它使用 Node.js、TypeScript 和 Playwright，输出与 Dalamud 插件约定的 `events.json`。

## 运行方式

本地调试：

```powershell
npm install
npm run build
npm test
npm start -- --dry-run
```

若本机没有 Playwright 管理的 Chromium，但已经安装 Chrome 或 Edge，可把 `PLAYWRIGHT_EXECUTABLE_PATH` 指向浏览器可执行文件；Docker 镜像已自带匹配的浏览器，不需要设置。

`SOURCE_URLS` 必须列出已经核验为季节活动详情页的完整 URL，多个地址用逗号分隔。盛趣综合新闻页同时包含版本专题、运营活动和常驻入口，不能可靠自动推断季节活动；缺少 `SOURCE_URLS` 时采集器会明确失败。

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

每次发布都会在现有版本上递增 `dataVersion`。`filesystem` 模式读取 `OUTPUT_FILE`，并用同目录锁文件阻止两个定时或手动任务同时发布；获得锁后还会重新核对版本，目标已被其他任务更新时安全失败。`github` 模式读取目标分支的当前 JSON，并以同一次读取取得的 SHA 做条件更新。目标文件尚不存在时从 `1` 开始。已有文件无法读取、JSON 损坏或缺少有效 `dataVersion` 时任务会失败，不会把版本重置为 `1`。

进程正常结束时会清理锁文件。如果宿主机在发布过程中断电或被强制结束，需确认没有采集进程仍在运行，再删除 `OUTPUT_FILE` 同目录下残留的 `.lock` 文件。

采集结果为空时任务默认失败，防止官网 DOM 变化把已有 feed 覆盖为空。只有确认空 feed 是预期结果时，才可显式设置 `ALLOW_EMPTY_EVENTS=true`；其他值（包括 `false` 和 `TRUE`）都不会解除保护。

`--dry-run` 仍会抓取、执行空列表保护和校验，并读取当前版本，但不会写入临时文件、挂载目录或向 GitHub 发送更新请求。生产定时任务应先在日志中确认 `eventCount` 与预期一致。

采集和校验失败时进程返回非零状态，不覆盖已有输出。`github` 模式只在校验通过后提交。

## 当前限制

官网活动页格式并不稳定。采集器读取页面数据和 tooltip，但页面坐标只作为显示坐标；地图世界坐标必须由活动级映射提供，缺失时不会发布错误旗标。页面没有可提取的显示坐标时，只要活动级映射已经提供可靠世界坐标，采集仍可继续。

`LOCATION_OVERRIDES` 是按采集器生成的活动 ID 必填的世界坐标映射，每个活动都必须独立提供 `territoryId`、`mapId`、`x`、`y` 和 `z`。例如：

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

官网有时只用图片展示奖励，无法稳定提取物品名。可用 `REWARD_OVERRIDES` 按活动 ID 提供经人工核验的奖励数组，每项包含 `name`、`category`、`description` 和字符串数组 `flags`。例如：

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

官网活动页通常不提供数字形式的游戏任务与成就 ID。可用 `COMPLETION_OVERRIDES` 按活动 ID 提供经人工核验的 `questId`、`achievementId`，以及需要时的 `teleport`；例如：

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

## 调度示例

容器是一次执行、无状态的任务，不在内部常驻调度。Docker Desktop、Oracle Cloud 或其他 Linux 主机均可用同一个镜像：

```sh
0 */6 * * * cd /opt/oracle-services/seasonal-event/services/seasonal-event-collector/deploy/oracle && docker compose -f compose.yml run --rm collector >> collector.log 2>&1
```

`filesystem` 模式使用挂载的 `output/` 目录；`github` 模式只需把最小权限 Token 作为环境变量或 Docker Secret 提供给容器。不要把 `.env` 或 Token 提交到仓库。

发布前应先运行 `npm start -- --dry-run`。该模式会采集和校验，但不会替换已有 `events.json`，适合在本机和 Oracle 云主机上做定时任务前验证。

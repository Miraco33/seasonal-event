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
node scripts/verify-image-sources.mjs --rounds=3
```

如需把本机 dry-run 的预览保存为文件，可先设置 `PREVIEW_OUTPUT_FILE`；不设置时完整预览仍会输出到终端：

```powershell
$env:PREVIEW_OUTPUT_FILE = Join-Path $PWD "output/preview.json"
npm start -- --dry-run
```

历史官网模板兼容性可用 `npm run audit:history` 复查；页面清单、结果基线和已知图片字段限制见 `../../docs/HISTORICAL_COMPATIBILITY.md`。

若本机没有 Playwright 管理的 Chromium，但已经安装 Chrome 或 Edge，可把 `PLAYWRIGHT_EXECUTABLE_PATH` 指向浏览器可执行文件；Docker 镜像已自带匹配的浏览器，不需要设置。

已有公共来源、稳定活动 ID 和人工覆盖数据保存在 `config/collector.json`；通用游戏任务索引保存在 `config/game-quest-index.json`，已经人工交叉核验的兼容资料保存在 `config/verified-quests.json`。环境变量仍可追加来源或覆盖同名活动的数据，兼容已部署的旧 `.env`。新来源使用规范化专题 URL 哈希生成稳定 ID，不随活动标题改变；已有显式 ID 映射继续使用，保护角色提醒和忽略状态。

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

## 图片模板自动识别与游戏索引

采集器使用免费的本地 Tesseract 中英文 OCR，读取对应活动任务块的官方图片，再与版本化游戏索引交叉核验，不调用付费识别 API。当前索引来自国服 `2026.09.15.0000.0000`，包含该快照的全部 5377 条任务和 755 条任务相关成就；未来游戏版本新增任务需要重新提取并更新索引。云端读取索引即可，不需要安装或运行游戏。

目前按结构适配三种模板，任务名称可以是索引中的其他任务，不限于 FF15 和糖豆两条人工目录：

| 页面结构 | 活动任务与图片范围 |
| --- | --- |
| `.quest` 传统模板 | 从任务标题文字或图片 `alt` 取得任务名，读取该块及同一概览父级的直接 `.map` 图片 |
| `.fgs__howto__box` 糖豆模板 | 按所属列表项的任务标题匹配活动块，只读取该块图片，排除“前往游乐场”等前置任务 |
| `.content__event-info` 新版季节模板 | 从 `.content__event-info__quest--title` 取得任务名，仅读取同一块中的 `.content__event-info__area` 图片 |

自动地图补齐必须同时满足：任务名在索引中唯一匹配；实际 OCR 得到唯一且通过校验的 `X:… Y:…` 双轴坐标对，两轴与游戏表显示坐标一致；对应任务块中的 NPC 名或地图/地区名也能交叉核验。坐标预处理同时识别整行和独立 X、Y 两轴，规范化后必须精确一致；保留两轴真实置信度，使用其算术平均值作综合分数，达到 60 才接受，不把低分改为高分，也不要求每个词均达到 60。不能凭任务名直接套用地图，不能修补猜测的小数点，也不能把官网显示坐标写成世界坐标。通过核验后，世界坐标和地图 ID 才从 `Quest.IssuerLocation → Level → Map / TerritoryType` 取得。

任务图下载限定官方 HTTPS 主机，每张不超过 10 MiB、800 万像素；每个任务块最多读取四张候选图。当前尺寸校验支持 PNG/JPEG，不支持的图片会明确失败。原生懒加载图片可读取真实 `src`，不依赖滚动后截图。原图只在识别时临时保存并清理，不提交到仓库或公共活动数据；可选缓存仅保存识别结果。同一模板复用不同任务时仍重新核对实际图片，前置任务图和后续任务坐标不能借用。

这条自动路径仍需要先从正文、标题或 `alt` 确定任务名。完全没有任务名的纯图片专题、未适配的页面结构、索引中不存在或重名的任务继续保留未知字段。模型加载失败、OCR 执行失败、低置信度、坐标缺失/冲突或地图核验失败会写明确诊断；运行状态包含 `imageRecognitionIssues`，稳定候选报告在对应候选的 `reviewGaps` 中记录原因，公开资料显示 `collectionStatus.status=alert`。仅图片补充存在告警时，代码为 `image_enrichment_incomplete`。可靠活动时间仍可进入 schema 2，缺地图时禁用旗标。已经核验的人工目录和显式覆盖继续可用，不能把该兼容路径的成功称为新图片识别成功。

奖励优先读取页面表格、文字、`alt` 和 tooltip；自动游戏索引只在图片中识别到相应名称时补充任务直奖的物品资料。`Quest` 的直奖表不是活动商店或兑换奖励的完整清单，不能据此声明奖励已经收齐。完成条件也不能简单使用接取任务 ID：自动推导仅接受限定的非重复季节任务；多段任务须为同一活动和分类的单一连续链，并由唯一的最终任务直接成就支持，前段不能存在另一完成成就。分支、循环、重复任务或证据不够时完成状态仍未知，由客户端提示。

## OCR 运行配置

| 环境变量 | 用途 |
| --- | --- |
| `OCR_EXECUTABLE_PATH` | Tesseract 可执行文件；未设置时使用系统命令，Windows 也会检查标准安装位置 |
| `OCR_TESSDATA_DIR` | 含 `chi_sim.traineddata` 和 `eng.traineddata` 的模型目录；未设置时使用引擎默认模型目录 |
| `OCR_CACHE_DIR` | 可选的识别结果缓存目录；未设置时不写磁盘缓存，最多保留 32 个项目结果文件 |

Linux Docker 镜像独立安装免费的 Tesseract 与简体中文模型，使用容器内系统模型，不修改宿主机 OCR 或共享环境。Windows 本地验证使用单独放在被 Git 忽略的 `output/` 下的轻量中英文模型（合计约 6.3 MiB），通过 `OCR_TESSDATA_DIR` 指定，不覆盖现有共享安装中的模型。模型必须能实际加载，不能仅凭 `--list-langs` 中有名称判断健康。

本机已准备专用模型后，可在采集器目录设置以下路径再进行 dry-run；模型不随仓库提交，缺失或损坏时识别必须报告失败：

```powershell
$env:OCR_TESSDATA_DIR = Join-Path $PWD "output/ocr-probe/tessdata"
$env:OCR_CACHE_DIR = Join-Path $PWD "output/ocr-cache"
npm start -- --dry-run
```

Oracle Compose 限制为 0.5 CPU、768 MiB 内存、256 pids，OCR 每进程限一个 OpenMP 线程。本轮 ARM64 验收在这些限制下通过，最高观测 cgroup 内存峰值约 612.55 MiB，未发生 OOM；这是所测页面的样本，不保证未来所有页面都有相同资源需求。项目 OCR 结果缓存最多 32 个文件，每个不超过 2 MiB，总计不超过 32 MiB；新增前按写入时间淘汰较旧结果，超限结果不能写入。Oracle 默认缓存目录为 `/app/ocr-cache`，由宿主机 `status/ocr-cache` 独立持久挂载，不受每轮 `/app/status` 的 staging 路径覆盖或清理影响；目录权限须允许采集账号写入。部署前检查模型、缓存、图片失败告警和两个活动文件的预览，不能仅检查容器退出码。

本次 OCR 与通用索引适配已完成本机与云端 ARM64 验收、正式数据发布及独立公开数据/展示页核验，上线完成。采集定时器已恢复为 enabled/active，按既有每 6 小时计划运行。配置限制与本轮实测值分别记录；现有 1.1.0 客户端的数据格式兼容，不需要为云端识别增加游戏依赖，游戏内旗标点击和完成状态行为仍需独立实测。

## 图片识别验收

`node scripts/verify-image-sources.mjs --rounds=3` 读取实时官网，关闭人工任务目录及活动级地点、奖励、完成覆盖，使用真实 OCR 与通用游戏索引验证三种模板。FF15 的图片时间使用已核验公告时间回退，图片验收重点是任务、NPC、地图及完成条件；糖豆同时核对页面的 23 项兑换奖励。结果保存到被忽略的 `output/image-source-verification.json`，不发布活动数据。

2026-10-09 已通过 FF15、糖豆人、2025 新生庆典、2026 守护天四场活动各三轮，共 12/12 次关闭全部人工游戏资料补充的真实采集管线验收，均无图片补充告警。另用五张官网原图（含糖豆人前置任务图）验证真实坐标识别，三轮共 15/15 通过，报告为 `output/ocr-probe/ts-helper-five-image-three-rounds.json`；该单图检查与页面任务块隔离验收分别计数。单元测试中的 OCR 替身用于验证边界和错误处理，不计入这两项真实验收。

本机完整自动发现与采集流程也连续通过三轮，运行状态的 `imageRecognitionIssues` 均为空，四条保留活动资料的地图均已核验，报告为 `output/live-verification-3gqDmz/results.json`。本轮 Node 测试 128 项、客户端纯校验 39 项全部通过；统一编译入口及完整 Release 打包均为 0 warning、0 error。

云端 ARM64 容器关闭人工任务目录与游戏资料覆盖后，四场活动各三轮也通过 12/12，合计 65.159 秒；冷缓存首轮每页约 4.6–8.0 秒，后续约 3.1–4.6 秒。两次完整包装脚本 dry-run 用时 32.745/28.587 秒，四条活动地图均核验且图片识别问题为空，三个正式数据文件 SHA 未变。独立持久缓存形成四个结果文件、合计 15,510 字节，跨容器运行仍保留。

2026-10-09 15:48:55（北京时间）正式采集完成，用时 24.298 秒，状态 healthy、四条活动，发布提交为 `d52c195989a915ffdfd4cf2e511b0231988d37a8`：新版 schema 2 的数据版本为 7，旧版 schema 1 为 3。再次正式采集用时 23.006 秒，healthy、`changed=false`，包装脚本返回 unchanged/exit 0，未产生新提交。镜像、资源及调度快照见 [Oracle 部署说明](deploy/oracle/README.md)。

对应发布提交的数据校验与 Pages 部署均成功，独立公开验收确认新版 v7 有四条资料且 healthy、旧版 v3 有三条完整子集、候选为空，FF15/糖豆人/守护天字段一致；展示页在本次验收时显示两个开放活动、一个未来活动和数据版本 7。

上述结果覆盖已列出的三种布局、任务索引和图片。同布局可使用索引中的其他唯一任务，但游戏更新新增任务须更新索引；未适配布局仍可能需要修复。结果不能证明任意官网图片都能识别，也不代替游戏内旗标点击与完成状态测试。

## 已核验任务目录

`config/verified-quests.json` 保存国服离线游戏表与官方活动页面、图片交叉确认的资料。采集器按规范化任务名和官方专题路径关键词查找，名称规范化包含全半角标点及空白处理；只有唯一匹配才自动补齐 NPC、等级、世界地图坐标、活动完成条件和已核验奖励。未知任务继续保留部分资料；多个匹配会报告冲突，不能挑选第一项。明确的人工元数据、地图、完成条件和奖励覆盖仍有优先级，包括用于保留未知状态的显式值。

当前目录依据国服 `2026.09.15.0000.0000` 游戏表核验，仅覆盖以下两场活动。完整证据、游戏行号及地图变换参数见目录文件：

| 接取任务 | NPC / 地图 | 完成条件 | 奖励补充 |
| --- | --- | --- | --- |
| 黑衣青年 `68694` | 琪琵·嘉奇亚；乌尔达哈现世回廊 `130/13`，显示 X:8.5 Y:9.7 | 黑衣青年 → 暗夜来访者 → 风之使者；最终任务 `68696`，成就 `2241` | 13 项已唯一匹配的 FF15 物品 |
| 抓紧胜利的王冠！ `70337` | 莱维娜；金碟游乐场 `144/196`，显示 X:4.8 Y:6.1 | 活动接取解锁任务 `70337` | 官网兑换表按页面提取 |

FF15 展示首任务的接取地点，完成判断使用整条任务链的最终任务；不能用 `68694` 提前隐藏活动。糖豆人的 `70337` 完成只表示活动任务完成，不表示 23 项兑换奖励已经收齐；前置任务“前往游乐场”`65970` 不能替代它。解析器先定位活动任务块，再读该块中的 NPC、等级和坐标，避免读到前置任务；已核验的显示坐标不会被全页首个坐标覆盖。

该目录作为已核验资料的兼容路径保留，与通用 OCR/游戏索引分别校验。同一任务的后续复刻可复用目录；游戏数据更新后应重新生成离线报告并交叉核验，Excel 校验和不兼容时必须停止核验，不能绕过版本检查。实际识别出的地图坐标与目录冲突时不使用冲突地点，并明确告警。

在已有离线报告的采集器目录中验证目录与游戏表一致：

```powershell
npm run build
node scripts/verify-game-data.mjs output/game-data-verification.json
```

报告由 [`tools/game-data`](tools/game-data/README.md) 只读提取本机游戏文件生成，属于被 Git 忽略的核验材料。生产采集器只读取版本化目录和索引，不读取这份本机报告，云端无需安装游戏。目录补齐和 OCR 适配已完成本轮部署；后续生产更新仍需按授权流程部署采集器并验证输出。

页面坐标只作为显示坐标；地图世界坐标必须来自有效活动级映射、已核验目录或通过图片核验的游戏索引，缺失时 schema 2 的 `location` 为 `null`，客户端禁用地图按钮。页面没有可提取的显示坐标时，只要活动级映射已经提供可靠世界坐标，仍可使用该映射。

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

`questId` 和 `achievementId` 可以省略或设为 `null`；此时插件无法用对应状态排除已完成活动。两种映射都缺失时，数据本身无法自动判断完成状态。没有显式完成覆盖时，采集器优先使用唯一匹配的已核验目录，再使用已通过图片核验且满足上述保守链规则的游戏索引条件；`questId` 可以指向活动最终任务，与展示的首个接取任务名称不同。完成任务不代表活动商店的所有奖励已经兑换。

## 发现、补充资料与待审核处理

1. 运行 `npm run discover`。候选同时出现在标准输出和 `CANDIDATE_OUTPUT_FILE`；该命令不采集正式来源，也不发布。
2. 正式采集自动处理符合产品范围的新专题，可靠核心资料不再依赖维护者每次手动批准。无关或误识别候选仍可加入 `sources.ignored`；需要持续观察的链接可加入 `sources.pending`。
3. 对真正缺少标题或时间的专题核对公告与页面。保留已有稳定 ID，不因标题或资料补齐更换 ID；确有外部约定时才新增显式 `eventIds` 映射。
4. 根据可靠证据补充已核验任务目录或任务/NPC 元数据、`overrides.locations`、`overrides.rewards` 和 `overrides.completion`。目录变更需重新执行离线游戏表与官方资料交叉核验；不能猜测地图、任务或成就 ID，也不能把未知字段补为占位数据。
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

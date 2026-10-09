# Seasonal Event

国服 Final Fantasy XIV 游戏内季节活动提醒插件。客户端实现位于本目录；活动采集与发布服务位于 `services/seasonal-event-collector/`，公共数据位于 `data/seasonal-event/`。

## 在线安装

当前版本为 1.1.0。在游戏中打开 `/xlsettings`，进入 **Experimental**，将下面的地址加入 **Custom Plugin Repositories** 并保存：

```text
https://raw.githubusercontent.com/Miraco33/seasonal-event/refs/heads/main/repo.json
```

随后在 `/xlplugins` 的可安装插件中搜索 `Seasonal Event`。第三方仓库清单会从 GitHub Release 下载与清单版本一致的插件 ZIP；状态页、活动 JSON 和 Schema 都不是插件安装地址。

## 构建

该目录是可独立克隆和发布的仓库。安装 `global.json` 固定的 .NET SDK，并准备 Dalamud 开发环境后执行：

```powershell
& ".\build.ps1"
& ".\build.ps1" -Mode Release
```

在本机插件合集内开发时，外层统一入口仍可同时构建所有插件；外层目录和 AutoFarm 不属于本仓库。

## 产品边界

- 收录国服游戏内、可接任务的传统季节活动和限时联动，包含 FF15、妖怪手表及糖豆人。
- 不收录官网抽奖、充值、商城、社区活动、莫古力日随或其他纯运营活动。
- 国服专属但具备游戏内任务、剧情、奖励或成就的季节活动可以收录。
- 只在活动已经开始且尚未结束时提醒；未开始和已过期活动不提示。
- 只展示已核验的任务接取 NPC 地图旗标，不处理活动商店、兑换地点或副本入口；缺少世界坐标时禁用地图按钮。
- Teleporter 联动为可选功能；只有活动数据提供传送目标且 Teleporter 可用时才显示传送按钮，未安装前置插件时仍保留地图旗标功能。

## 用户可见行为

插件在角色进入游戏后检查当前开放的活动；在已经登录时热加载插件也会立即检查。在线期间会低频重新判断活动起止时间和北京时间日期，并每 6 小时联网更新活动数据；失败后从 1 分钟开始逐步退避重试，最长间隔 1 小时。用户也可以在窗口中立即刷新。因此跨过活动开始时刻、数据源更新或午夜后不需要重新登录。默认每个角色、每个活动每天只自动弹窗提醒一次；手动打开 `/seasonalevent` 时仍会列出当天已经提醒过、但尚未忽略或完成的开放活动。

用户可以对当前活动执行“忽略”操作，并在活动仍开放时从窗口恢复提醒。忽略状态按角色和活动 ID 独立保存；忽略一个活动不会影响其他同时开放的活动。

活动完成状态优先使用稳定的任务 ID 判断，并以成就状态作为补充。游戏尚未发送完整成就列表且数据没有任务 ID 时，插件仍会显示活动和提醒，同时明确标注完成状态暂时未知，避免活动被永久静默。没有稳定任务或成就映射时，用户可以在完成后忽略该活动。

展示的任务名称和地图用于开始活动，数据中的 `questId` 用于判断活动完成，可以指向后续最终任务。FF15 接取任务为“黑衣青年”`68694`，完整链依次为 `68694 → 68695 → 68696`，完成判断使用“风之使者”`68696`，成就“战友”`2241` 也指向该任务。糖豆人使用活动任务“抓紧胜利的王冠！”`70337`；完成该任务表示接取解锁任务已完成，不代表 23 项兑换奖励收齐，不能使用前置“前往游乐场”`65970` 作为活动完成条件。

1.1.0 默认从 GitHub Pages 的公开 HTTPS 地址 [`events-v2.json`](https://miraco33.github.io/seasonal-event/events-v2.json) 获取数据。用户可以在 `/seasonalevent` 窗口的“数据源设置”中改用其他兼容地址，再点击“保存并刷新”。开发版占位地址、旧官方 GitHub Raw 地址和旧官方 Pages `events.json` 地址会自动迁移到 v2；用户自行填写的其他数据源及角色状态保持不变。客户端同时接受 schema 1 的完整数据和 schema 2 的部分资料，不把已提供但无效的字段当作缺失字段。

schema 2 中未知的任务名称、NPC 和地点可为 `null`，尚未提取的奖励可为 `[]`。这些缺口在窗口中明确显示；地图缺失时不能打开旗标，奖励为空时引导查看官网。活动的标题、起止时间和 HTTPS 来源仍必须可靠。`collectionStatus.status=alert` 会显示“当前列表可能不完整”，空列表不会被静默解释为官网没有活动。

## 时间规则

活动数据使用带时区的 ISO 8601 时间保存，例如：

```json
{
  "startAt": "2026-08-27T15:00:00+08:00",
  "endAt": "2026-09-10T23:00:00+08:00"
}
```

插件按时间点比较，不依赖用户操作系统时区。官网若把结束时间写到分钟（例如 `22:59`），数据源中的 `endAt` 使用下一个整分钟（`23:00:00`）作为排他边界，表示 `22:59` 这一整分钟仍可参加。

## 三层架构

### 1. 用户本地 Dalamud 插件

由插件仓库分发给用户。只负责：

- 下载并缓存标准化活动数据；
- 判断活动是否在开放时间内；
- 查询当前角色成就完成状态；
- 保存本地角色状态（已提醒、已忽略）；
- 显示活动详情和任务接取地图旗标；
- 发现 Teleporter IPC 时提供可选传送按钮。

用户状态不上传云端。

### 2. 公共静态数据源

GitHub Pages 发布新版 [`events-v2.json`](https://miraco33.github.io/seasonal-event/events-v2.json) 和对应的 `events-v2.schema.json`，同时保留 [`events.json`](https://miraco33.github.io/seasonal-event/events.json) 与 [`events.schema.json`](https://miraco33.github.io/seasonal-event/events.schema.json)。旧文件只含符合 schema 1 完整要求的活动子集，让 1.0.0 客户端继续读取；地图、任务或奖励尚不完整的活动只出现在 v2。状态页位于 [`https://miraco33.github.io/seasonal-event/`](https://miraco33.github.io/seasonal-event/)，公开呈现候选及采集告警。发布工作流把 `site/` 与这些公共数据文件组合到 Pages 根目录。

数据源只保存公共活动资料，不保存角色、账号或反馈隐私信息。插件使用 HTTPS、缓存和 ETag，网络失败时继续使用本地缓存。

推送到 `main` 且网页或公共数据发生变化时，`.github/workflows/pages.yml` 会自动部署 Pages；也可以从 GitHub Actions 页面手动触发。仓库需要在 GitHub Pages 设置中选择 **GitHub Actions** 作为发布来源。

### 3. 活动采集与标准化服务

定时读取盛趣新闻和活动专题，执行动态页面脚本，提取活动时间、任务、NPC、奖励 tooltip 和坐标，转换成统一 JSON 后发布到第二层。发现范围为最近 180 天的有界分页，识别传统季节活动及明确的游戏内限时联动。新来源默认使用规范化专题 URL 的哈希作为稳定活动 ID；已存在的 ID 映射保持不变。

标题、活动时间和官方 HTTPS 来源通过校验后，采集器自动发布已提取资料。缺地图或奖励不会阻断整场活动；未知字段保留为未知。标题或时间仍无法核验的专题进入待审核报告。已经发布且仍开放或尚未开始的活动持续追踪公告与专题，不因原公告离开发现窗口而丢失。单个来源失败时保留该来源上次已核验活动，并在 v2 中发布采集告警。

该服务可以：

- 手动定期执行；
- 在本机 Docker 中持续运行；
- 部署到 Oracle Cloud 免费实例或其他小型云主机。

采集服务与插件分离，网页解析、异常重试、OCR 和历史数据整理不进入插件端。采集器使用免费的本地中英文 Tesseract 和版本化游戏索引自动核验任务图片，已核验人工目录继续作为兼容路径；识别或匹配不足的字段保留未知并明确告警。

## 活动数据字段

新版文档使用 `schemaVersion: 2`，活动可以只提供可靠的核心资料；例如：

```json
{
  "schemaVersion": 2,
  "dataVersion": 1,
  "publishedAt": "2026-10-02T00:00:00+08:00",
  "collectionStatus": { "status": "ok", "code": "healthy" },
  "events": [
    {
      "id": "seasonal-example",
      "title": "已核验的活动标题",
      "startAt": "2026-10-07T16:00:00+08:00",
      "endAt": "2026-10-27T23:00:00+08:00",
      "questName": null,
      "questLevel": null,
      "questNpc": null,
      "location": null,
      "rewards": [],
      "sourceUrl": "https://actff1.web.sdo.com/",
      "lastVerifiedAt": "2026-10-02T00:00:00+08:00"
    }
  ]
}
```

这是字段结构示例，不是发布活动。资料补齐后可包含以下完整字段；schema 1 仍要求非空任务、NPC、有效世界坐标和至少一项奖励：

```json
{
  "id": "seasonal-aae61e8dfaea",
  "title": "新生庆典与音乐的轨迹",
  "startAt": "2026-08-27T15:00:00+08:00",
  "endAt": "2026-09-10T23:00:00+08:00",
  "questName": "新生庆典与音乐的轨迹",
  "questLevel": 15,
  "questNpc": "异国的诗人",
  "questId": 71046,
  "location": {
    "territoryId": 128,
    "mapId": 11,
    "x": -9.61439,
    "y": 39.9998,
    "z": 82.0985,
    "displayX": 11.0,
    "displayY": 12.8
  },
  "achievementId": 3875,
  "rewards": [
    {
      "name": "迷你乌克·拉玛特",
      "category": "宠物",
      "description": "获得新宠物“迷你乌克·拉玛特”。",
      "flags": ["珍稀", "独占", "不可出售", "不可在市场出售"]
    }
  ],
  "sourceUrl": "https://actff1.web.sdo.com/",
  "lastVerifiedAt": "2026-09-04T09:04:03+08:00"
}
```

奖励应尽量保存名称、分类、描述和交易限制。任务接取坐标与商店坐标必须分开建模；当前插件只使用任务接取坐标。

## 自动化边界

奖励优先通过页面文字、表格、图片 `alt` 和浏览器执行后的 tooltip 自动读取。任务地图仅存在于图片中时，采集器先确定活动任务名及任务块，再对该块原图执行免费的本地 Tesseract 中英文 OCR，与 `config/game-quest-index.json` 唯一匹配。当前索引是国服 `2026.09.15.0000.0000` 的全部 5377 条任务和 755 条任务相关成就快照，不限于两条人工目录；新游戏版本的任务需要更新索引。

当前适配 `.quest` 传统模板、`.fgs__howto__box` 糖豆模板和 `.content__event-info` 新版季节模板。任务名从标题文字、正文或 `alt` 获取；地图图片按所属活动块定位，传统模板包含同一父级的兄弟地图，新模板只读取活动地区图。前置任务块及全页其他坐标不能混入。自动地图必须有唯一且通过校验的实际 OCR 双轴坐标对，两轴均与索引一致，再由 NPC 或地图/地区名称交叉核验；任务名本身不能代替图片证据。坐标预处理分别识别整行及独立 X、Y 轴，规范化后必须精确一致，保留原始轴分数，以两轴置信度的算术平均值达到 60 为门槛；该门槛不表示每个词均达到 60。世界坐标来自 `Quest.IssuerLocation → Level → Map / TerritoryType`，NPC 来自 `ENpcResident`，物品名称和限制来自 `Item`；官网显示坐标不能直接当作世界坐标。

没有任务名的纯图片专题、未适配模板、索引缺失或重名继续保留部分资料。OCR 模型加载失败、低置信度、缺失/冲突坐标或地图核验失败会写明确诊断，运行状态含 `imageRecognitionIssues`，候选报告用 `reviewGaps` 记录原因，并通过 `collectionStatus` 暴露告警。原图识别时临时保存后清理，不入库；可选缓存只保存识别结果。完成条件不能通用地取首任务 ID：自动推导要求非重复季节任务和单一连续链，多段链须有唯一的最终任务直接成就且前段没有另一完成成就；分支、循环或证据不足继续提示完成未知。`Quest` 直奖只覆盖任务发放的物品，不能代表完整活动商店；仍应以实际页面奖励及名称证据为准。

`config/verified-quests.json` 保留 FF15 和糖豆的人工交叉核验资料及 FF15 的 13 项物品，按任务名和官方专题路径关键词唯一匹配，显式人工覆盖仍优先。该兼容目录可用于同任务复刻，但不能把目录回填称为新图片识别成功。游戏更新后目录和索引均需重新提取核验；Excel 表校验和不兼容时停止。离线原始报告位于被 Git 忽略的 `output/game-data-verification.json`，生产只读取版本化目录与索引，不动态读取本机游戏文件或报告，云端无需安装游戏。提取步骤见 `services/seasonal-event-collector/tools/game-data/README.md`。

OCR 的运行配置为 `OCR_EXECUTABLE_PATH`、`OCR_TESSDATA_DIR` 和可选 `OCR_CACHE_DIR`。Linux 独立容器安装免费系统 OCR 及模型；Windows 本地验证使用被忽略的 `output/` 下专用轻量中英文模型，合计约 6.3 MiB，不修改共享安装模型。Oracle Compose 限制为 0.5 CPU、768 MiB、256 pids，OCR 每进程限一个线程；本轮 ARM64 验收在该限制下通过，最高观测 cgroup 内存峰值约 612.55 MiB，样本不保证未来所有页面的资源需求。项目结果缓存最多 32 文件、单文件 2 MiB、合计 32 MiB，默认由宿主机 `status/ocr-cache` 独立持久挂载到 `/app/ocr-cache`，新增前淘汰较旧结果，不受状态 staging 覆盖和清理影响。诊断先写 staging，校验后再保存至持久状态目录；原图及模型不提交公共数据。具体配置见采集器 README。

采集流程按字段校验：可靠核心资料自动发布，未知字段明确保留，已提供的错误字段拒绝发布。官网解析失败不能被静默解释为“没有活动”；应保留上次已核验资料并暴露告警。每条数据保留来源和最后验证时间，便于追踪错误。`announcementUrl` 可保存官方公告 API 来源，客户端的“查看官网”打开活动专题 `sourceUrl`。

## 部署和成本判断

首版公共数据源可以是免费的静态托管，不需要域名、用户登录或数据库。自定义域名不是必需项，但正式长期使用时可以增加稳定性和迁移自由度。

采集服务才是主要运行成本。本实现需要完整浏览器和本地 OCR，可使用本机 Docker、具备这些依赖的 GitHub Actions 或 Oracle Cloud 免费实例，不调用付费识别 API。公开数据接口应使用 HTTPS、CDN 缓存、请求超时和简单限流，不必一开始建设复杂的防 DDoS 系统。

历史活动日历不是首版必须功能，但若实现，历史活动数据同样存放在公共静态数据源，用户的筛选和查看状态仍保存在本地。

## 当前状态与验证边界

已实现的客户端能力包括：角色登录或插件热加载后异步获取数据、运行期间定时刷新与失败退避、手动立即刷新、按数据源绑定 ETag 与本地缓存、按中国时区低频重算开放时间、按 Content ID 和活动 ID 保存日内提醒/忽略状态、恢复忽略、任务与成就完成判断、地图旗标和条件式 Teleporter IPC。缓存以带数据源地址和 ETag 的封装格式原子替换；无法证明来源的旧版裸 JSON 缓存会先忽略，并在成功刷新后自动升级。数据不可用且没有同源本地缓存时会打开窗口显示明确错误，不会把该情况解释为“没有活动”。窗口可以复制经过脱敏的诊断信息，包括插件与数据版本、数据源路径、缓存状态、刷新时间和最近错误，不包含角色 ID、本地路径或 URL 查询参数。

奖励条目显示名称；鼠标悬浮时会展示采集到的类别、描述和限制。地图 `x/y/z` 是 `IGameGui.OpenMapWithMapLink` 所需的游戏世界坐标；官网显示坐标单独保存在 `displayX/displayY`，不能直接混用。

2026-09-05 已在兼容的 Dalamud 环境中手动验证第三方仓库安装与加载、登录提醒、远程数据刷新、成就完成识别和任务地图旗标。诊断信息显示数据源、缓存、最近刷新、数据版本和错误状态均正常；完成活动后，数据源中的活动仍保留，但客户端能够正确将其从待办列表中排除。

上述 2026-09-05 检查针对旧版完整资料，不覆盖 1.1.0。新版本尚需在游戏内验证官方数据源迁移、部分资料显示、无坐标地图禁用、采集告警、官网按钮、多个同时开放活动、忽略/恢复及可选 Teleporter IPC。无游戏测试可以核验 JSON 兼容和校验、解析器、发现规则、保留旧资料及发布边界；不能代替 UI 和游戏 API 实测。具体采集与 Docker/Oracle 部署步骤见 `services/seasonal-event-collector/README.md`。

此前 1.1.0 发布前的无游戏验证已通过：92 项采集器检查、39 项客户端校验、6 轮实时官网验收和 21 个历史专题兼容检查。工作区编译与 Release 打包、版本一致性和 ZIP 结构检查也已通过。该次发布已有用户授权，游戏内 UI 和 API 行为留待后续实测；本轮 OCR 扩展的授权、部署及验收结果另见下文。

无游戏自动化验证入口：

```powershell
dotnet run --project tests/client-validation -c Release
cd services/seasonal-event-collector
npm run build
npm test
node scripts/verify-live.mjs --rounds=3
node scripts/verify-image-sources.mjs --rounds=3
```

客户端验证项目只链接模型与纯校验逻辑，不加载游戏。实时官网验收连续读取三轮，用于确认实际公告与专题模板；不执行正式发布。若本机使用固定 SDK，可将 `dotnet` 替换为该 SDK 的绝对路径。Playwright 浏览器路径按采集器 README 设置；不应为验证修改锁文件或升级共享依赖。

2026-10-09 本次新增 OCR 的真实验收已通过：`verify-image-sources.mjs` 对 FF15、糖豆人、2025 新生庆典、2026 守护天四场活动各读取三轮，共 12/12 次关闭全部人工游戏资料补充的采集管线验收，无人工任务目录、地点、奖励或完成覆盖，图片补充告警均为空。FF15 日期使用已核验公告时间回退，图片验收核对实际任务、NPC、地图和完成条件；糖豆人另核对 23 项页面奖励。五张官网原图（含糖豆人前置图）的坐标 helper 独立三轮通过 15/15；这些结果来自实际 OCR，不含单元测试替身。结果保存在被忽略的 `output/image-source-verification.json` 及 `output/ocr-probe/ts-helper-five-image-three-rounds.json`。

本机完整自动发现与采集流程连续三轮均无 `imageRecognitionIssues`，四条保留活动资料的地图均核验，报告为 `output/live-verification-3gqDmz/results.json`。本轮 Node 128 项、客户端纯校验 39 项全部通过，统一编译入口及完整 Release 打包均为 0 warning、0 error；实际执行的是 `./build.ps1 -NoRestore` 与 `./build.ps1 -Mode Release -NoRestore`。

2026-10-09 云端 ARM64 镜像已构建并验收：关闭人工任务目录及游戏资料覆盖的四场活动各三轮通过 12/12，合计 65.159 秒；两次完整包装脚本 dry-run 用时 32.745/28.587 秒，四条活动地图均核验，图片识别问题为空，三个正式数据文件 SHA 不变。实际配置限制为 0.5 CPU、768 MiB、256 pids；独立图片管线内存峰值约 558.24 MiB，完整 dry-run 最高观测值约 612.55 MiB，未发生 OOM。独立持久缓存四文件、15,510 字节跨容器保留，32 MiB 仍是缓存上限，不能当作实测用量。

正式采集于 2026-10-09 15:48:55（北京时间）完成，用时 24.298 秒，healthy、四条活动，数据发布提交为 `d52c195989a915ffdfd4cf2e511b0231988d37a8`，新版 schema 2 数据版本 7、旧版 schema 1 数据版本 3。再次正式采集用时 23.006 秒，healthy、`changed=false`、unchanged/exit 0，未产生新提交；定时器已恢复 enabled/active，按既有每 6 小时计划运行。详细代码、镜像及资源记录见 `services/seasonal-event-collector/deploy/oracle/README.md`。

对应数据发布提交的校验与 Pages 部署均成功；独立公开验收确认新版 v7 有四条资料且 healthy、旧版 v3 有三条完整子集、候选为空，FF15/糖豆人/守护天字段一致。展示页在本次验收时显示两个开放活动、一个未来活动和数据版本 7，上线验收已完成；游戏内旗标点击和完成状态仍需独立实测。

现有三种布局可以结合版本化任务索引识别其他唯一任务；游戏更新新增任务须更新索引，未适配布局仍可能需要修复，本轮验收不能证明未来所有官网图片均可自动识别。

已有离线原始报告时，在采集器目录增加以下一致性检查：

```powershell
npm run build
node scripts/verify-game-data.mjs output/game-data-verification.json
```

该检查比对目录与原报告中的游戏版本、语言、唯一任务和物品匹配、NPC、地图及世界坐标、任务链、成就指向和奖励字段。本次目录补齐、通用游戏索引和 OCR 适配已完成上述本机与云端验收，并正式部署及发布活动数据；数据兼容现有 1.1.0 客户端，无需更改插件版本。后续生产部署和发布仍按授权范围执行，游戏内地图旗标及完成状态显示仍需实测。新增 OCR 的验收与此前 1.1.0 的历史检查分别记录；维护时仍须核对模型故障、低置信、前置任务隔离和无人工目录的新任务。

## 自定义仓库发布流程

本项目通过自己的 `repo.json` 分发，无需提交到 Dalamud 主库。用户添加仓库地址后，安装器依据 `AssemblyVersion` 和安装、更新下载链接获取 Release ZIP。

1. 同步 `SeasonalEvent.csproj` 的三个版本字段、`seasonalevent.json`、`repo.json` 的版本和更新说明；新版本必须高于已发布版本。更新 `repo.json` 的下载地址与 `LastUpdate`。
2. 更新用户说明，执行 `build.ps1 -Mode Release`。核对 ZIP 根目录只有插件 DLL、插件清单和 deps.json，且版本一致。
3. 提交并创建对应 Git 标签。先推标签，创建普通 GitHub Release 并上传 `seasonalevent.zip`；核对公开下载内容与本地 SHA-256 一致。
4. 若同时升级云端采集器，在推送 `main` 前暂停其独立定时器并确认采集任务没有运行。安装包可下载后再推送 `main`，让固定仓库地址与 GitHub Pages 指向新版本。检查 Pages、数据和相关 Actions，再按 Oracle 部署规范更新镜像、验证并恢复原定时器状态。
5. 验证全新安装目录与旧版覆盖升级的包结构和配置兼容性，记录自动化范围和后续游戏内验证项。游戏内安装、加载及升级结果须另行实测，单独记录结果。

云端采集器在获得部署批准后同步代码、重建镜像并验证 dry-run，再运行正式发布流程；定时任务不会自动重建镜像。升级期间应按 Oracle 部署规范暂停独立采集器定时器，确认没有运行中的采集任务，避免新代码与旧镜像混用。公开分发地址保持不变：`https://raw.githubusercontent.com/Miraco33/seasonal-event/refs/heads/main/repo.json`。

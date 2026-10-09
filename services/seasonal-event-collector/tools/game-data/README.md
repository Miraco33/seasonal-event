# 离线游戏数据核验

此工具只读本机国服游戏 `sqpack`，支持指定任务核验与通用任务索引导出。它不会启动或控制游戏，也不会修改采集器配置、活动数据或游戏文件。

使用工作区已有 .NET 10 SDK，引用现有 Dalamud 开发目录中的 `Lumina.dll` 和 `Lumina.Excel.dll`。项目没有包依赖。默认 DLL 目录为 `%APPDATA%/XIVLauncher/addon/Hooks/dev`；可通过 `-p:LuminaDirectory=...` 指定另一套已有 DLL。

在插件仓库根目录（包含 `SeasonalEvent.csproj`）构建、运行。以下命令使用已有 `dotnet`；也可替换为插件合集已有 `.dotnet/dotnet.exe` 的绝对路径。`LuminaDirectory` 指向已有且兼容当前国服表格式的开发 DLL 目录：

```powershell
dotnet build services/seasonal-event-collector/tools/game-data/GameDataTool.csproj `
  '-p:LuminaDirectory=<已有 Dalamud 开发 DLL 目录>'
dotnet services/seasonal-event-collector/tools/game-data/bin/Debug/net10.0/GameDataTool.dll `
  --game-path '<游戏目录>/game/sqpack' `
  --quest-name '黑衣青年' `
  --quest-name '抓紧胜利的王冠！' `
  --achievement-keyword '风之使者' `
  --item-name '路西斯王子的外套'
```

任务和物品名称按游戏表完整名称精确匹配；报告保留零匹配和多匹配结果，不自动猜测。任务名可重复指定，成就关键词可重复指定。报告中的任务后续关系来自 `Quest.PreviousQuest`，最多展开 64 行；终末任务只是候选，仍需与官方活动说明交叉核验，不能把有分支的前置任务终末节点直接当作某一活动完成条件。

地点来源是 `Quest.IssuerLocation → Level → Map / TerritoryType`，接取 NPC 名称来自对应 `ENpcResident` 行。`world.y` 保留 Level 表实际高度。显示坐标使用 Map 的 `SizeFactor` 和 `OffsetX/OffsetY` 从世界 X/Z 转换，报告同时给出截取到一位小数的显示坐标及逆变换误差。黑衣青年和抓紧胜利的王冠的官方坐标用作额外交叉检查，不参与生成世界坐标。

Excel 表校验和不匹配会立即失败；不会忽略版本差异后输出看似有效的 ID。输出是核验材料，人工确认后才能进入生产目录或配置。物品的独占、交易限制等保留游戏表布尔值，不把未知限制补成推测的成功结果。

## 生成完整核验报告

工具把 JSON 写到标准输出。下面的 PowerShell 7 示例重复指定两场任务和 13 项 FF15 物品，成功后保存完整报告；游戏目录和 SDK/DLL 路径使用本机已有环境：

```powershell
$collectorRoot = 'services/seasonal-event-collector'
$probeArguments = @(
  '--game-path', '<游戏目录>/game/sqpack',
  '--quest-name', '黑衣青年',
  '--quest-name', '抓紧胜利的王冠！',
  '--achievement-keyword', '风之使者'
)
$itemNames = @(
  '路西斯王子的外套', '路西斯王子的半指手套',
  '路西斯王子的打底裤', '路西斯王子的皮靴',
  '雷迦利亚G型取车证', '发型样式：诺克提斯',
  '九宫幻卡：诺克提斯·路西斯·切拉姆',
  '管弦乐琴乐谱：锤头鲨', '管弦乐琴乐谱：幻想圆舞曲',
  '管弦乐琴乐谱：休息与反省', '管弦乐琴乐谱：黑暗遮蔽',
  '管弦乐琴乐谱：夜之启示', '管弦乐琴乐谱：快速加油'
)
foreach ($itemName in $itemNames) { $probeArguments += @('--item-name', $itemName) }
$reportLines = & dotnet "$collectorRoot/tools/game-data/bin/Debug/net10.0/GameDataTool.dll" @probeArguments
if ($LASTEXITCODE -ne 0) { throw '离线核验失败，未保存报告。' }
New-Item -ItemType Directory -Path "$collectorRoot/output" -Force | Out-Null
$reportLines | Set-Content -LiteralPath "$collectorRoot/output/game-data-verification.json" -Encoding utf8
```

生成后进入采集器目录验证生产目录与原始报告一致：

```powershell
cd services/seasonal-event-collector
npm run build
node scripts/verify-game-data.mjs output/game-data-verification.json
```

检查涵盖游戏版本和语言、任务与物品的唯一匹配、NPC、地点和地图变换、完整任务链、成就指向及奖励名称、描述和限制。报告保留完整原始关系，属于被 Git 忽略的核验材料；生产采集器只读取经审查的 `config/verified-quests.json`，不动态加载本机游戏数据或这份报告，云端无需安装游戏。

## 导出通用任务索引

`--export-index` 是独立模式，只需游戏路径和目标文件，不要求 `--quest-name`，不能同时指定任务、成就或物品筛选。它导出所有有名称的 Quest 行，供新的官网任务名称唯一查找，不按活动 URL 或当前两场活动人工填写数据。名称使用 NFKC、移除 Unicode 空白、小写规范化；同名行均保留，调用方必须拒绝多匹配。

```powershell
dotnet services/seasonal-event-collector/tools/game-data/bin/Debug/net10.0/GameDataTool.dll `
  --game-path '<游戏目录>/game/sqpack' `
  --export-index services/seasonal-event-collector/output/game-quest-index.json
node services/seasonal-event-collector/tools/game-data/verify-index.mjs `
  services/seasonal-event-collector/output/game-quest-index.json `
  services/seasonal-event-collector/output/game-data-verification.json
```

输出为 UTF-8 无 BOM、LF、紧凑 JSON，通过临时文件完成后替换目标；目标不得位于只读游戏目录中。成功时标准输出只报告任务数、歧义名称数、分类计数、坐标逆变换最大误差与文件大小。索引默认放在被 Git 忽略的 `output/`，不包含机器路径、脚本、图片或游戏原始资源。

顶层为 `schemaVersion: 1`、游戏版本、语言、`verifiedAt`、DLL 版本、校验策略、规范化方式、坐标公式、`quests` 和 `achievements`。任务含 ID、原名、规范化名、真实 NPC、最低非零职业等级、接取地点世界 X/Y/Z、原始显示 X/Y、一位小数地图坐标、地图变换和名称、前置关系与连接方式、全部后继 ID、Festival、JournalGenre、重复任务标记、直接关联成就 ID，以及固定和可选物品奖励。

`nextQuestIds` 从整个 Quest 表生成，包含没有名称、因而未导出任务行的后继；消费者遇到缺失后继应保留完成条件未知。`achievementIds` 只使用 `Achievement.Key` 实际类型为 Quest 的直接关联；成就列表另保留 `type`、`keyQuestId` 与 Key/Data 中真实 Quest 引用，不能把多个条件的成就一概解释成完成一个任务。奖励只导出 Quest 明确引用的 Item 及实际数量、可选标记、名称、分类、描述和 `isUnique/isUntradable/isIndisposable` 限制；它不代表活动兑换商店的完整奖励。不存在的数据保留 `null` 或空列表，不猜测 NPC、等级、地图、成就和奖励。

当前国服表导出 5,377 个有名任务，规范化后 5,295 个名称、70 组重名，5,269 个可用接取地点；其中 314 行 Festival 非零，5,063 行为零。JournalGenre“来访者任务”也包含 Festival 为零的任务，例如“王在顶点沉睡”，不能单凭此类别把任务归为季节活动；Festival 名称当前普遍为空，也不能作为活动名称证据。索引保留分类事实，由官网活动筛选限定使用场景。

索引本身不指定“整个活动完成”的任务。自动判定至少应要求唯一根任务、非重复、非零 Festival，以及全部后继都存在、属于同一 Festival 和 JournalGenre、没有分支与循环的完整线性链；涉及未知行、跨类别后继、重复任务或分支时保留未知，并核对官方活动说明。这些只是结构约束，不能证明末端就是官网主活动完成点：当前“新生庆典与音乐的轨迹”有同类非重复后续任务，但对应成就在首任务，红莲节也有成就在首任务、后续任务重复的情况。接取任务完成、完成整个任务链和全部兑换奖励收齐仍是不同含义。游戏更新后需重新导出，校验不兼容时失败；固定旧索引不能证明新增任务已收录。

## 当前核验范围与维护

当前目录基于国服 `2026.09.15.0000.0000` 游戏表和官方页面、图片双证据，仅包含 FF15 的“黑衣青年”和糖豆人的“抓紧胜利的王冠！”。接取任务的显示名称经过全半角标点和空白规范化后，还必须匹配官方专题路径关键词；只有唯一目录匹配才补齐资料。未知任务保留部分资料，多匹配报告冲突；显式人工覆盖继续优先。

FF15 接取任务 ID 为 `68694`，完整任务链 `68694 → 68695 → 68696`，完成条件使用最终任务“风之使者”`68696` 和成就“战友”`2241`。坐标来自首任务的接取地点 `130/13`，对应官方显示 X:8.5 Y:9.7；13 项奖励均在 Item 表唯一匹配。不能因为首任务完成就判定整个活动完成。

糖豆人活动任务为 `70337`，莱维娜位于地图 `144/196`，对应显示 X:4.8 Y:6.1。完成该任务只表示活动接取解锁任务完成，不表示 23 项兑换奖励收齐；前置任务“前往游乐场”`65970` 不可替代活动任务，也不能使用它的乌尔达哈地图。采集器读取对应任务块，避免混入其他任务的 NPC 和坐标。

同一任务的后续复刻可以复用核验目录；游戏数据更新后应重跑工具并核对官方说明，校验和不兼容时先准备兼容的已有开发 DLL 再重新核验，禁止跳过检查。指定任务核验模式与通用索引导出均不识别图片；官网图片识别由采集器流程负责，索引只提供游戏表交叉核验，不把未知图片字段补成猜测结果。

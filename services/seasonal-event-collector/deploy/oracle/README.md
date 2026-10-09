# Oracle A1 部署

该目录用于把采集器部署为东京 OCI A1 上的一次性 Docker Compose 任务。容器不监听端口、不加入现有业务网络，也不持有 GitHub 凭据。容器读取仓库内版本化的 `config/collector.json`，把活动数据、候选报告和诊断先写入宿主机的临时 staging 目录；包装脚本校验后再把采集状态原子保存到持久的 `status/collector.json`。OCR 缓存直接写入独立持久挂载，不随 staging 清理。包装脚本确认数据确有变化后，才通过仓库专用 SSH deploy key 提交并推送；包含 Git 同步和推送结果的最终状态保存在 `status/latest.json`。

2026-09-04 从该 A1 实例直连盛趣活动页连续返回 HTTP 200，页面主资源也可访问，无需设置代理。该记录为最初部署前网络快照；2026-10-09 的 ARM64 镜像、完整采集和正式发布验收见下文。

采集器支持自动发现、部分资料和双数据文件。本地修改或 `git pull` 不会自动更新已经构建的容器镜像；云端升级需取得部署授权，重建采集器镜像并检查 dry-run，之后再运行正式发布。

## 图片识别与运行资源

新增图片识别在采集器独立容器内执行免费的 Tesseract 中英文 OCR，不使用付费 API，也不要求云服务器安装游戏。镜像使用 Linux 系统 OCR 模型；版本化 `config/game-quest-index.json` 保存国服 `2026.09.15.0000.0000` 的 5377 条任务及 755 条任务相关成就。`config/verified-quests.json` 的两条人工核验资料仍作为兼容路径保留，通用图片识别不限定这两条任务。

目前适配传统 `.quest`、糖豆 `.fgs__howto__box` 和新版季节 `.content__event-info` 三种任务块。先通过文字或 `alt` 取得活动任务名并隔离前置任务，再读取对应原图。只有任务名唯一匹配、实际 OCR 获得唯一双轴坐标且与游戏表一致，并有 NPC 或地图/地区名称交叉核验，才补齐世界地图位置。坐标预处理的整行与独立两轴识别必须精确一致，使用真实轴置信度的算术平均值达到 60，不把某个低分伪造为高分。纯图片缺任务名、重名、低置信度或图片冲突继续保持未知；模型不能加载、识别失败或核验失败会进入诊断及候选告警。运行状态通过 `imageRecognitionIssues` 记录详情，候选报告通过 `reviewGaps` 记录缺口；可靠活动时间仍可发布到 schema 2，地图缺失时客户端禁用旗标。

OCR 配置为 `OCR_EXECUTABLE_PATH`、`OCR_TESSDATA_DIR`、`OCR_CACHE_DIR`。前两项在容器内通常留空，分别使用系统 `tesseract` 命令和系统模型目录；不能填 Windows 本机路径。缓存只保存识别结果，最多 32 个项目文件、单文件 2 MiB、总计 32 MiB，新增前淘汰较旧结果。默认 `/app/ocr-cache` 由宿主机 `./status/ocr-cache` 独立持久挂载，包装脚本会在持久 `STATUS_ROOT` 下创建该目录；每轮覆盖 `COLLECTOR_STATUS_DIR` 为 staging/status 不会改变这个缓存挂载，也不会在清理 staging 时删除缓存。原图临时使用后清理，不提交仓库。Windows 的专用轻量模型位于本机被忽略的 `output/`，不复制或替换宿主机共享安装模型。

Compose 限制为 0.5 CPU、768 MiB 内存、256 pids，OCR 每进程使用一个 OpenMP 线程。本轮 ARM64 镜像和所测页面已在该限制下通过，详细实测值见下文；配置上限不等于实际用量，也不能据单次样本保证所有未来页面的资源需求。自动完成条件只采用符合保守规则的直接成就任务链，分支或证据不足继续未知；游戏任务直奖也不等于完整活动商店奖励。

本次 OCR 和通用索引适配已完成本机与云端 ARM64 验收、正式数据发布及独立公开数据/展示页核验，上线完成。采集定时器已恢复为 enabled/active，按既有每 6 小时计划运行。以下部署步骤继续适用于获准的后续升级；游戏内旗标点击和完成状态行为仍需独立实测。

本地真实验收入口为 `node scripts/verify-image-sources.mjs --rounds=3`，需先编译采集器并准备可加载的中英文模型。2026-10-09 已通过 FF15、糖豆人、2025 新生庆典、2026 守护天四场活动各三轮，共 12/12 次关闭全部人工游戏资料补充的真实采集管线验收；五张官网原图含前置任务图的单图识别另通过三轮 15/15。完整自动发现流程三轮均无 `imageRecognitionIssues`，四条保留活动资料的地图均核验；Node 128 项和客户端 39 项测试通过，统一编译入口及完整 Release 打包均为 0 warning、0 error。该本机结果不含测试替身，与下述云端验收分别记录。

当前自动适配范围为已实现的三种布局与版本化任务索引，不承诺未来所有模板；游戏更新后新增任务须重新提取并更新索引。

## 本轮 ARM64 部署验收

2026-10-09 部署使用代码 `93c9d133939888abc99ca97743e66489797a2c93` 构建 ARM64 镜像，镜像 ID 为 `c4e7fd4414a3bd3b8f4d0a21ed3dec2025be4a0142c43edd2d1b1e2523c3ebb8`。Docker 报告镜像大小 976,696,578 字节，相比原镜像 963,790,609 字节增加 12,905,969 字节（约 12.31 MiB）；这不是宿主机实际磁盘占用增量。

容器实际限制为 `NanoCpus=500000000`、`Memory=805306368`、`PidsLimit=256`，即 0.5 CPU、768 MiB、256 pids。关闭人工任务目录及游戏资料覆盖后，FF15、糖豆人、2025 新生庆典、2026 守护天各三轮通过 12/12，合计 65.159 秒；冷缓存第一轮每页约 4.6–8.0 秒，后续约 3.1–4.6 秒。

| 云端验收 | 用时 | 观测到的 cgroup 内存峰值 |
| --- | --- | --- |
| 四场活动各三轮的独立图片管线 | 65.159 秒 | 585,359,360 字节，约 558.24 MiB |
| 第一次完整包装脚本 dry-run | 32.745 秒 | 542,928,896 字节，约 517.78 MiB |
| 第二次完整包装脚本 dry-run | 28.587 秒 | 642,301,952 字节，约 612.55 MiB |

独立图片管线采样到的 pids 最高值为 76，`OOMKilled=false`、exit 0。两次完整 dry-run 的四条活动地图均已核验，`imageRecognitionIssues=[]`，三个正式数据文件 SHA 均未变化。独立持久缓存从零增长到四个结果文件、合计 15,510 字节，并在后续容器运行中保留。表中是本轮样本观测值，32 MiB 是磁盘缓存上限，不能混作内存实测值。

正式 systemd 采集于 2026-10-09 15:48:55（北京时间）完成，用时 24.298 秒，healthy、四条活动，数据发布提交为 `d52c195989a915ffdfd4cf2e511b0231988d37a8`；新版为 schema 2、`dataVersion=7`，兼容文件为 schema 1、`dataVersion=3`。再次正式采集用时 23.006 秒，healthy、`changed=false`，包装脚本返回 unchanged/exit 0，未产生新提交。

定时器恢复为 enabled/active，按既有每 6 小时计划运行；恢复时 `systemctl` 显示下次预计运行时间为 2026-10-09 20:21:33（北京时间），该值是调度快照。最终只读检查确认 service `Result=success`、`ExecMainStatus=0`。

发布提交 `d52c195989a915ffdfd4cf2e511b0231988d37a8` 对应的 [Validate published data](https://github.com/Miraco33/seasonal-event/actions/runs/37901192331) 与 [Deploy GitHub Pages](https://github.com/Miraco33/seasonal-event/actions/runs/37901192430) 均成功。独立公开验收确认新版 v7 有四条资料且 healthy、旧版 v3 有三条完整子集、候选为空，FF15/糖豆人/守护天字段一致；展示页在本次验收时显示两个开放活动、一个未来活动和数据版本 7。公开上线验收已完成，游戏内旗标点击和完成状态仍需独立实测。

## 目录和发布过程

完整仓库位于 `/opt/oracle-services/seasonal-event/`，本目录为：

```text
/opt/oracle-services/seasonal-event/services/seasonal-event-collector/deploy/oracle/
```

每次任务会依次执行：

1. 用 `flock` 取得主机级非阻塞锁，避免定时任务重入。
2. 使用专用 deploy key 对 `main` 执行 `git pull --ff-only`，并拒绝带有已跟踪修改或偏离远端的部署检出。
3. 把仓库当前的 `events-v2.json`、兼容旧版的 `events.json` 和 `candidates.json` 复制到 `output/` 下的独立 staging 目录。
4. 以宿主机账号的非 root UID/GID 运行一次性容器；容器使用 `filesystem` 模式，把活动文件及诊断先写入 staging，OCR 结果直接写入 `/app/ocr-cache` 的独立持久挂载。
5. 校验新版资料、旧版完整子集、候选报告和诊断后，把诊断保存到持久 `status/`。活动和候选文件字节内容未变化时直接结束，不产生提交；变化时在临时仓库中只提交这三个数据文件，再通过 SSH deploy key 推送。

Compose 中 `OUTPUT_FILE` 指向 staging 的 `events-v2.json`，`LEGACY_OUTPUT_FILE` 指向 `events.json`，`CANDIDATE_OUTPUT_FILE` 指向 `candidates.json`。两个活动文件服务于不同客户端：新版允许明确的未知字段，旧版只保留 schema 1 完整活动。

`candidates.json` 不包含运行 ID 或时间戳，只在候选、审核状态或“下一活动缺失”状态变化时产生 Git 差异。容器的采集状态和预览先写入本轮 staging/status，包装脚本校验后更新持久状态文件。`status/collector.json` 包含页面采集时间、阶段、重试次数和错误详情；`status/latest.json` 记录包装脚本的最终结果，能够区分未变化、已推送、dry-run 和发布失败。成功的 dry-run 还会把完整待发布数据保存为 `status/preview.json`。这些状态和预览文件只保留在服务器，不提交。

单个来源失败时，采集器保留该来源上次已核验活动，在新版资料和候选报告中发布告警，避免错误地表现为活动消失。致命运行或输出校验失败不会用失败输出替换长期部署检出中的两个活动文件；包装脚本只允许发布错误候选诊断以触发告警。提交或推送失败时远端保持不变。推送使用临时仓库，也不会把 `.env`、输出文件或服务器上的其他改动加入提交。

## 准备仓库专用 deploy key

以 `ubuntu` 用户生成独立密钥；该私钥只用于这个仓库：

```sh
install -d -m 0700 /home/ubuntu/.ssh
ssh-keygen -t ed25519 -f /home/ubuntu/.ssh/seasonal-event-deploy -C seasonal-event-oracle
chmod 0600 /home/ubuntu/.ssh/seasonal-event-deploy
```

把 `.pub` 内容添加到 GitHub 仓库 **Settings → Deploy keys**，勾选 **Allow write access**。从 GitHub 官方 API 的 `ssh_keys` 生成专用 `/home/ubuntu/.ssh/seasonal-event-known_hosts`，不要关闭主机密钥验证；脚本只使用这个文件。服务器的 `origin` 必须是：

```text
git@github.com:Miraco33/seasonal-event.git
```

私钥、`.env` 和 `known_hosts` 都不得提交到仓库。deploy key 是仓库级凭据，不需要 GitHub Token。

## 首次部署和验证

把仓库检出到上述目录，将 `.env.example` 复制为 `.env`，权限设为 `600`。`COLLECTOR_UID` 和 `COLLECTOR_GID` 应与运行服务的账号一致；可用 `id -u` 和 `id -g` 核对。脚本运行时也会以实际账号值覆盖这两个变量，确保 staging 和状态目录可写。已有 `.env` 中的 `SOURCE_URLS`、`LOCATION_OVERRIDES`、`REWARD_OVERRIDES`、`COMPLETION_OVERRIDES` 继续有效并覆盖版本化配置；确认新镜像运行正常后可移除这些重复公共数据，只保留主机参数。

```sh
cd /opt/oracle-services/seasonal-event/services/seasonal-event-collector/deploy/oracle
cp .env.example .env
chmod 0600 .env
chmod 0755 run-and-publish.sh
docker compose -f compose.yml build collector
./run-and-publish.sh --dry-run
cat status/latest.json
cat status/collector.json
cat status/preview.json
```

镜像只在首次部署或采集器代码、依赖、Dockerfile 更新后手动构建。定时脚本只调用 `docker compose run`，不执行 `build`，因此不会每 6 小时重复构建。dry-run 会拉取仓库、读取当前数据并运行采集校验，但不会提交或推送。首次使用 OCR 时，还应检查中英文模型实际加载、图片坐标与 NPC/地区核验、运行状态的 `imageRecognitionIssues`、候选的 `reviewGaps`、缓存目录权限、冷缓存耗时和峰值内存；失败时必须明确告警，不能回填猜测坐标。核对 `eventCount`、来源和活动资料后，执行一次完整流程：

```sh
./run-and-publish.sh
```

数据不变时应看到 `no commit is needed`；数据变化时应看到提交和推送成功。退出码 `2` 表示存在待审核候选或采集/换期告警，包装脚本仍可发布已通过校验的数据和明确告警，再把 `2` 返回给 systemd。Compose 默认把手动运行的 filesystem 输出映射到本目录的 `output/`，且不会开放任何端口。

## 启用定时器

完整流程验证成功后安装 unit：

```sh
sudo install -m 0644 seasonal-event-collector.service /etc/systemd/system/
sudo install -m 0644 seasonal-event-collector.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now seasonal-event-collector.timer
```

定时器按 UTC 在每日 00:20、06:20、12:20、18:20 触发，并增加最多 10 分钟随机延迟：

```sh
systemctl list-timers seasonal-event-collector.timer
journalctl -u seasonal-event-collector.service -n 100 --no-pager
cat /opt/oracle-services/seasonal-event/services/seasonal-event-collector/deploy/oracle/status/latest.json
cat /opt/oracle-services/seasonal-event/services/seasonal-event-collector/deploy/oracle/status/collector.json
```

`status/preview.json` 只在成功 dry-run 后更新。只有同一次运行的 `status/latest.json` 中 `previewFile` 为 `preview.json` 时，才把它视为本次预览；日常定时运行不会刷新这个文件。

## 升级已运行的部署

新代码或 Compose 输出路径和旧镜像混用，可能把 schema 1 写到 `events-v2.json`，或丢失双文件输出。因此，在包含采集器升级的 `main` 推送前，先记录并暂停本采集器的定时器；只操作 `seasonal-event-collector.timer`，保留其 enabled 状态，确认 `seasonal-event-collector.service` 没有正在运行的任务。

```sh
systemctl is-active seasonal-event-collector.timer
sudo systemctl stop seasonal-event-collector.timer
systemctl is-active seasonal-event-collector.service
```

如果服务仍 active，等待现有采集任务结束再同步和构建。完成 Release 资源验证与主分支推送后，在云端显式更新检出，再构建和验证：

```sh
cd /opt/oracle-services/seasonal-event
git pull --ff-only origin main
cd services/seasonal-event-collector/deploy/oracle
docker compose -f compose.yml build collector
./run-and-publish.sh --dry-run
cat status/latest.json
cat status/collector.json
cat status/preview.json
./run-and-publish.sh
```

首次升级到双数据文件版本，必须先显式拉取仓库，让 `events-v2.json` 存在，再调用包装脚本。确认预览及正式输出中新版为 schema 2、兼容文件为 schema 1，活动数量和采集状态符合预期；格式检查可阻止旧镜像误写，但不能替代镜像重建。

验证完成后按升级前的 active 状态恢复；原本 active 的定时器执行：

```sh
sudo systemctl start seasonal-event-collector.timer
systemctl list-timers seasonal-event-collector.timer
```

自动化部署应在 `finally` 或 shell `trap` 中检查恢复条件，防止忘记恢复定时器。构建或验证失败时，先修复部署或恢复匹配的代码与镜像，再恢复原运行状态；在此之前明确记录采集器暂停，避免重新进入新旧版本混用的窗口。原本未运行的定时器保持未运行，其他业务服务无需操作。

## 活动换期

采集器通过盛趣新闻 API 的 180 天有界分页发现传统季节活动及明确游戏内限时联动，不再只匹配 `【季节活动】` 前缀。可靠标题、时间和官方来源通过校验后自动发布 schema 2 资料；缺地图时保留 `location: null`，缺奖励时保留 `[]`。只有核心资料无法核验时才等待审核。已经发布的开放或未来活动持续追踪其公告和专题，不因新闻移出窗口而丢失。

维护者可通过版本化配置补充已核验地图、奖励和完成状态映射，无需为自动时间提醒猜测这些字段。具体处理步骤见采集器 README 的“发现、补充资料与待审核处理”。新代码或配置完成后，先在获准部署的云端重建镜像并运行 `./run-and-publish.sh --dry-run`，确认两个数据文件的边界及故障告警，再执行正式流程。

默认告警阈值为 168 小时。没有已发布的下一活动时，当前活动进入最后 168 小时或已结束会产生换期告警；可通过 `.env` 的 `NEXT_EVENT_WARNING_HOURS` 调整阈值。`candidate-alert.yml` 只在候选报告有 Git 变化时创建或更新同一个 Issue，不会每 6 小时反复通知；是否收到 GitHub 个人通知取决于订阅设置。公开状态页和新版插件的 `collectionStatus` 警告也应一并检查，不能只看 timer 正常或退出码。

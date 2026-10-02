# Oracle A1 部署

该目录用于把采集器部署为东京 OCI A1 上的一次性 Docker Compose 任务。容器不监听端口、不加入现有业务网络，也不持有 GitHub 凭据。容器读取仓库内版本化的 `config/collector.json`，把活动数据和候选报告写入宿主机的临时 staging 目录，并把采集状态原子保存到持久的 `status/collector.json`。包装脚本确认数据确有变化后，才通过仓库专用 SSH deploy key 提交并推送；包含 Git 同步和推送结果的最终状态保存在 `status/latest.json`。

2026-09-04 从该 A1 实例直连当前盛趣活动页连续返回 HTTP 200，页面主资源也可访问，无需设置代理。该结果是部署前网络快照，上线前仍需用 ARM64 容器执行一次 dry-run。

采集器支持自动发现、部分资料和双数据文件。本地修改或 `git pull` 不会自动更新已经构建的容器镜像；云端升级需取得部署授权，重建采集器镜像并检查 dry-run，之后再运行正式发布。

## 目录和发布过程

完整仓库位于 `/opt/oracle-services/seasonal-event/`，本目录为：

```text
/opt/oracle-services/seasonal-event/services/seasonal-event-collector/deploy/oracle/
```

每次任务会依次执行：

1. 用 `flock` 取得主机级非阻塞锁，避免定时任务重入。
2. 使用专用 deploy key 对 `main` 执行 `git pull --ff-only`，并拒绝带有已跟踪修改或偏离远端的部署检出。
3. 把仓库当前的 `events-v2.json`、兼容旧版的 `events.json` 和 `candidates.json` 复制到 `output/` 下的独立 staging 目录。
4. 以宿主机账号的非 root UID/GID 运行一次性容器；容器使用 `filesystem` 模式，只能写 staging。
5. 校验新版资料、旧版完整子集及候选报告。字节内容未变化时直接结束，不产生提交；变化时在临时仓库中只提交这三个数据文件，再通过 SSH deploy key 推送。

Compose 中 `OUTPUT_FILE` 指向 staging 的 `events-v2.json`，`LEGACY_OUTPUT_FILE` 指向 `events.json`，`CANDIDATE_OUTPUT_FILE` 指向 `candidates.json`。两个活动文件服务于不同客户端：新版允许明确的未知字段，旧版只保留 schema 1 完整活动。

`candidates.json` 不包含运行 ID 或时间戳，只在候选、审核状态或“下一活动缺失”状态变化时产生 Git 差异。`status/collector.json` 包含页面采集时间、阶段、重试次数和错误详情；`status/latest.json` 记录包装脚本的最终结果，能够区分未变化、已推送、dry-run 和发布失败。成功的 dry-run 还会把完整待发布数据保存为 `status/preview.json`。这些状态和预览文件只保留在服务器，不提交。

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

镜像只在首次部署或采集器代码、依赖、Dockerfile 更新后手动构建。定时脚本只调用 `docker compose run`，不执行 `build`，因此不会每 6 小时重复构建。dry-run 会拉取仓库、读取当前数据并运行采集校验，但不会提交或推送。核对 `eventCount`、来源和活动资料后，执行一次完整流程：

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

# Oracle A1 部署

该目录用于把采集器部署为东京 OCI A1 上的一次性 Docker Compose 任务。容器不监听端口、不加入现有业务网络，也不持有 GitHub 凭据。容器读取仓库内版本化的 `config/collector.json`，把活动数据和候选报告写入宿主机的临时 staging 目录，并把采集状态原子保存到持久的 `status/collector.json`。包装脚本确认数据确有变化后，才通过仓库专用 SSH deploy key 提交并推送；包含 Git 同步和推送结果的最终状态保存在 `status/latest.json`。

2026-09-04 从该 A1 实例直连当前盛趣活动页连续返回 HTTP 200，页面主资源也可访问，无需设置代理。该结果是部署前网络快照，上线前仍需用 ARM64 容器执行一次 dry-run。

## 目录和发布过程

完整仓库位于 `/opt/oracle-services/seasonal-event/`，本目录为：

```text
/opt/oracle-services/seasonal-event/services/seasonal-event-collector/deploy/oracle/
```

每次任务会依次执行：

1. 用 `flock` 取得主机级非阻塞锁，避免定时任务重入。
2. 使用专用 deploy key 对 `main` 执行 `git pull --ff-only`，并拒绝带有已跟踪修改或偏离远端的部署检出。
3. 把仓库当前的 `events.json` 和 `candidates.json` 复制到 `output/` 下的独立 staging 目录。
4. 以宿主机账号的非 root UID/GID 运行一次性容器；容器使用 `filesystem` 模式，只能写 staging。
5. 字节内容未变化时直接结束，不产生提交。变化时在临时仓库中只提交这两个数据文件，再通过 SSH deploy key 推送。

`candidates.json` 不包含运行 ID 或时间戳，只在候选、审核状态或“下一活动缺失”状态变化时产生 Git 差异。`status/collector.json` 包含页面采集时间、阶段、重试次数和错误详情；`status/latest.json` 记录包装脚本的最终结果，能够区分未变化、已推送、dry-run 和发布失败。成功的 dry-run 还会把完整待发布数据保存为 `status/preview.json`。这些状态和预览文件只保留在服务器，不提交。

采集或校验失败不会覆盖长期部署检出中的 `events.json`；包装脚本只允许把状态为 `error` 的候选运营报告提交到仓库以触发告警。提交或推送失败时远端保持不变。推送使用临时仓库，也不会把 `.env`、输出文件或服务器上的其他改动加入提交。

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

数据不变时应看到 `no commit is needed`；数据变化时应看到提交和推送成功。退出码 `2` 表示采集成功但存在待审核候选或下一活动告警，包装脚本仍会安全发布已经审核的数据，然后把 `2` 返回给 systemd。Compose 默认把手动运行的 filesystem 输出映射到本目录的 `output/`，且不会开放任何端口。

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

## 活动换期

采集器通过盛趣新闻 API 发现标题带明确 `【季节活动】` 前缀的新专题，但只写入待审核报告。审核和上线步骤见采集器 README 的“下一活动审核流程”。完成 `config/collector.json` 中稳定 ID、地点、奖励和完成状态映射后，先运行 `./run-and-publish.sh --dry-run`，再把候选加入 `sources.approved`。

默认告警阈值为 168 小时。以当前 2026 新生庆典在北京时间 9 月 10 日 23:00 结束为例，在尚无下一活动候选或已审核未来活动时，服务会有意返回退出码 `2` 和 `event_ending_without_candidate`。这表示数据采集仍成功，但需要维护者处理下一活动；若临时调整阈值，可在 `.env` 设置 `NEXT_EVENT_WARNING_HOURS`。

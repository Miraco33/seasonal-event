# Oracle A1 部署

该目录用于把采集器部署为东京 OCI A1 上的一次性 Docker Compose 任务。容器不监听端口、不加入现有业务网络，也不持有 GitHub 凭据。容器只把结果写入宿主机的临时 staging 目录；`run-and-publish.sh` 确认数据确有变化后，才通过仓库专用 SSH deploy key 提交并推送。

2026-09-04 从该 A1 实例直连当前盛趣活动页连续返回 HTTP 200，页面主资源也可访问，无需设置代理。该结果是部署前网络快照，上线前仍需用 ARM64 容器执行一次 dry-run。

## 目录和发布过程

完整仓库位于 `/opt/oracle-services/seasonal-event/`，本目录为：

```text
/opt/oracle-services/seasonal-event/services/seasonal-event-collector/deploy/oracle/
```

每次任务会依次执行：

1. 用 `flock` 取得主机级非阻塞锁，避免定时任务重入。
2. 使用专用 deploy key 对 `main` 执行 `git pull --ff-only`，并拒绝带有已跟踪修改或偏离远端的部署检出。
3. 把仓库当前的 `data/seasonal-event/events.json` 复制到 `output/` 下的独立 staging 目录。
4. 以宿主机账号的非 root UID/GID 运行一次性容器；容器使用 `filesystem` 模式，只能写 staging。
5. 字节内容未变化时直接结束，不产生提交。变化时在临时仓库中只提交数据文件，再通过 SSH deploy key 推送。

采集、校验、提交或推送失败都不会用 staging 覆盖长期部署检出中的旧数据。推送使用临时仓库，也不会把 `.env`、输出文件或服务器上的其他改动加入提交。

## 准备仓库专用 deploy key

以 `ubuntu` 用户生成独立密钥；该私钥只用于这个仓库：

```sh
install -d -m 0700 /home/ubuntu/.ssh
ssh-keygen -t ed25519 -f /home/ubuntu/.ssh/seasonal-event-deploy -C seasonal-event-oracle
chmod 0600 /home/ubuntu/.ssh/seasonal-event-deploy
```

把 `.pub` 内容添加到 GitHub 仓库 **Settings → Deploy keys**，勾选 **Allow write access**。确认 `github.com` 的 SSH 主机密钥已在 `/home/ubuntu/.ssh/known_hosts` 中，并测试此密钥只能访问目标仓库。服务器的 `origin` 必须是：

```text
git@github.com:Miraco33/seasonal-event.git
```

私钥、`.env` 和 `known_hosts` 都不得提交到仓库。deploy key 是仓库级凭据，不需要 GitHub Token。

## 首次部署和验证

把仓库检出到上述目录，将 `.env.example` 复制为 `.env`，权限设为 `600`。`COLLECTOR_UID` 和 `COLLECTOR_GID` 应与运行服务的账号一致；可用 `id -u` 和 `id -g` 核对。脚本运行时也会以实际账号值覆盖这两个变量，确保 staging 可写。

```sh
cd /opt/oracle-services/seasonal-event/services/seasonal-event-collector/deploy/oracle
cp .env.example .env
chmod 0600 .env
chmod 0755 run-and-publish.sh
docker compose -f compose.yml build collector
./run-and-publish.sh --dry-run
```

镜像只在首次部署或采集器代码、依赖、Dockerfile 更新后手动构建。定时脚本使用 `docker compose run --no-build`，不会每 6 小时重复构建。dry-run 会拉取仓库、读取当前数据并运行采集校验，但不会提交或推送。核对 `eventCount`、来源和活动资料后，执行一次完整流程：

```sh
./run-and-publish.sh
```

数据不变时应看到 `no commit is needed`；数据变化时应看到提交和推送成功。Compose 默认把手动运行的 filesystem 输出映射到本目录的 `output/`，且不会开放任何端口。

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
```

## 活动换期

盛趣综合新闻页不能可靠区分季节活动与运营专题。换活动时需更新 `.env` 中的 `SOURCE_URLS`、`LOCATION_OVERRIDES`、`REWARD_OVERRIDES` 和 `COMPLETION_OVERRIDES`，先运行 `./run-and-publish.sh --dry-run`，核对结果后再恢复定时发布。

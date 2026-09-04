# Oracle A1 部署

该目录用于把采集器部署为东京 OCI A1 上的一次性 Docker Compose 任务。容器不监听端口、不加入现有业务网络，也不改变 AstrBot、NapCat、RSSHub 或 sub2api。活动 JSON 通过 GitHub Contents API 发布，服务器继续只对公网开放 SSH。

2026-09-04 从该 A1 实例直连当前盛趣活动页连续返回 HTTP 200，页面主资源也可访问；无需设置代理。该结果是部署前网络快照，正式上线前仍必须用 ARM64 容器执行一次 dry-run。

## 服务器目录

完整仓库放在：

```text
/opt/oracle-services/seasonal-event/
```

Compose 工作目录为：

```text
/opt/oracle-services/seasonal-event/services/seasonal-event-collector/deploy/oracle/
```

## 首次部署

1. 把仓库同步到上述目录。
2. 在 `services/seasonal-event-collector/deploy/oracle/` 中把 `.env.example` 复制为 `.env`，权限设为 `600`。
3. 填入目标 `GITHUB_REPOSITORY`，并把只允许目标仓库 Contents 读写的细粒度 Token 写入 `GITHUB_TOKEN`。不得提交 `.env`。
4. 构建 ARM64 镜像并先做无写入验证：

```sh
docker compose -f compose.yml build
docker compose -f compose.yml run --rm collector --dry-run
```

只有 dry-run 输出的 `eventCount`、来源和活动资料符合预期时，才执行一次正式发布：

```sh
docker compose -f compose.yml run --rm collector
```

## 启用定时器

确认一次正式发布成功后，将 unit 文件安装到 systemd：

```sh
sudo install -m 0644 seasonal-event-collector.service /etc/systemd/system/
sudo install -m 0644 seasonal-event-collector.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now seasonal-event-collector.timer
```

定时器按服务器 UTC 时钟在每日 00:20、06:20、12:20、18:20 触发，并增加最多 10 分钟随机延迟。查看计划和最近日志：

```sh
systemctl list-timers seasonal-event-collector.timer
journalctl -u seasonal-event-collector.service -n 100 --no-pager
```

采集失败、活动为空、版本冲突或 GitHub 条件更新失败都会保留上一版数据并使 unit 失败。若宿主机被强制结束后残留 `.lock`，先确认没有采集容器仍在运行，再按采集器 README 的说明清理。

## 活动换期

盛趣综合新闻页不能可靠区分季节活动与运营专题，因此每次换活动都需要更新 `.env` 中的 `SOURCE_URLS`、`LOCATION_OVERRIDES`、`REWARD_OVERRIDES` 和 `COMPLETION_OVERRIDES`，先运行 dry-run，再恢复定时发布。公开数据地址可使用 GitHub Pages，或目标仓库的 raw HTTPS 地址。

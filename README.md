# Seasonal Event

国服《最终幻想 XIV》季节活动提醒插件，帮助你及时发现当前开放、尚未完成的游戏内季节活动。

## 功能

- 角色登录后自动检查正在进行的季节活动，每个角色每天提醒一次。
- 显示活动时间、任务名称、接取 NPC、等级和奖励信息。
- 根据任务与成就状态判断活动是否已经完成。
- 一键在游戏地图上标记任务接取位置。
- 可忽略不想继续提醒的活动。
- 可在窗口中恢复当前仍开放但已忽略的活动。
- 运行期间定时更新活动数据；网络暂时不可用时使用本地缓存并自动重试。
- 当活动数据提供附近传送点且已启用 Teleporter 时，可以一键传送；未安装也不影响其他功能。

## 在线安装

1. 在游戏内输入 `/xlsettings`。
2. 打开 **Experimental** 页面。
3. 在 **Custom Plugin Repositories** 中添加以下链接并保存：

   ```text
   https://raw.githubusercontent.com/Miraco33/seasonal-event/refs/heads/main/repo.json
   ```

4. 输入 `/xlplugins`，搜索 `Seasonal Event` 并安装。

## 使用

插件会在登录后自动检查活动。输入 `/seasonalevent` 可以随时打开活动窗口，查看当前活动、奖励和任务位置，也可以立即刷新数据、忽略活动或恢复已忽略的当前活动。遇到问题时，可以在窗口的“诊断信息”中复制不含角色信息和本地路径的运行状态，随反馈一并提交。

## 当前版本

当前为 0.1.1 测试版，尚未完成游戏内完整验收。如果遇到活动信息不准确、提醒异常、地图位置错误或其他问题，请在 [GitHub Issues](https://github.com/Miraco33/seasonal-event/issues) 反馈。

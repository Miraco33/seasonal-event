# Seasonal Event

国服《最终幻想 XIV》季节活动提醒插件，帮助你及时发现当前开放、尚未完成的游戏内季节活动。

## 功能

- 角色登录后自动检查正在进行的季节活动，每个角色每天提醒一次。
- 显示活动时间、任务名称、接取 NPC、等级和奖励信息。
- 根据任务与成就状态判断活动是否已经完成。
- 一键在游戏地图上标记任务接取位置。
- 可忽略不想继续提醒的活动。
- 网络暂时不可用时使用本地缓存的活动数据。
- 安装 Teleporter 后可使用活动地点传送按钮；未安装也不影响其他功能。

## 在线安装

1. 在游戏内输入 `/xlsettings`。
2. 打开 **Experimental** 页面。
3. 在 **Custom Plugin Repositories** 中添加以下链接并保存：

   ```text
   https://raw.githubusercontent.com/Miraco33/seasonal-event/refs/heads/main/repo.json
   ```

4. 输入 `/xlplugins`，搜索 `Seasonal Event` 并安装。

## 使用

插件会在登录后自动检查活动。输入 `/seasonalevent` 可以随时打开活动窗口，查看当前活动、奖励和任务位置，也可以忽略不需要提醒的活动。

## 当前版本

当前为初始测试版，尚未完成游戏内完整验收。如果遇到活动信息不准确、提醒异常、地图位置错误或其他问题，请在 [GitHub Issues](https://github.com/Miraco33/seasonal-event/issues) 反馈。

using System.Numerics;
using System.Globalization;
using System.Text;
using Dalamud.Bindings.ImGui;
using Dalamud.Game.Command;
using Dalamud.Plugin;
using Dalamud.Plugin.Ipc;
using Dalamud.Plugin.Services;
using Lumina.Excel.Sheets;

namespace SeasonalEvent;

public sealed class Plugin : IDalamudPlugin
{
    private const string Command = "/seasonalevent";
    private static readonly TimeSpan RefreshInterval = TimeSpan.FromHours(6);
    private static readonly TimeSpan[] RefreshRetryDelays =
    {
        TimeSpan.FromMinutes(1),
        TimeSpan.FromMinutes(2),
        TimeSpan.FromMinutes(5),
        TimeSpan.FromMinutes(15),
        TimeSpan.FromMinutes(30),
        TimeSpan.FromHours(1),
    };
    private static readonly TimeZoneInfo ChinaTimeZone = TimeZoneInfo.FindSystemTimeZoneById(
        OperatingSystem.IsWindows() ? "China Standard Time" : "Asia/Shanghai");

    private readonly IDalamudPluginInterface pluginInterface;
    private readonly IClientState clientState;
    private readonly IFramework framework;
    private readonly IGameGui gameGui;
    private readonly IDataManager dataManager;
    private readonly IPlayerState playerState;
    private readonly IUnlockState unlockState;
    private readonly ICommandManager commandManager;
    private readonly IPluginLog log;
    private readonly PluginConfiguration config;
    private readonly EventDataService dataService;
    private readonly ICallGateSubscriber<uint, byte, bool> teleport;
    private readonly string cachePath;
    private readonly List<SeasonalEventData> activeEvents = new();
    private readonly List<SeasonalEventData> ignoredActiveEvents = new();
    private readonly HashSet<string> completionUnknownEventIds = new(StringComparer.Ordinal);
    private readonly Dictionary<string, List<string>> completionIssues = new(StringComparer.Ordinal);
    private CancellationTokenSource? refreshCts;
    private bool windowVisible;
    private volatile bool refreshComplete;
    private volatile bool refreshInProgress;
    private volatile bool disposed;
    private bool waitingForAchievements;
    private bool wasLoggedIn;
    private DateTimeOffset nextEvaluationAt = DateTimeOffset.MinValue;
    private long nextRefreshAtUnixSeconds;
    private int consecutiveRefreshFailures;
    private string eventsUrlInput;
    private string? statusMessage;

    public Plugin(
        IDalamudPluginInterface pluginInterface,
        IClientState clientState,
        IFramework framework,
        IGameGui gameGui,
        IDataManager dataManager,
        IPlayerState playerState,
        IUnlockState unlockState,
        ICommandManager commandManager,
        IPluginLog log)
    {
        this.pluginInterface = pluginInterface;
        this.clientState = clientState;
        this.framework = framework;
        this.gameGui = gameGui;
        this.dataManager = dataManager;
        this.playerState = playerState;
        this.unlockState = unlockState;
        this.commandManager = commandManager;
        this.log = log;
        config = pluginInterface.GetPluginConfig() as PluginConfiguration ?? new PluginConfiguration();
        if (config.Initialize(pluginInterface)) config.Save();
        eventsUrlInput = config.EventsUrl;
        cachePath = Path.Combine(pluginInterface.GetPluginConfigDirectory(), "events-cache.json");
        dataService = new EventDataService(log, cachePath);
        dataService.LoadCache(config.EventsUrl);
        teleport = pluginInterface.GetIpcSubscriber<uint, byte, bool>("Teleport");

        pluginInterface.UiBuilder.Draw += DrawUI;
        pluginInterface.UiBuilder.OpenConfigUi += OpenConfigUI;
        clientState.Login += OnLogin;
        clientState.Logout += OnLogout;
        framework.Update += OnFrameworkUpdate;
        commandManager.AddHandler(Command, new CommandInfo(OnCommand) { HelpMessage = "打开季节活动提醒" });

        // Login may already have fired when Dalamud hot-loads the plugin.
        if (clientState.IsLoggedIn) OnLogin();
    }

    public string Name => "Seasonal Event";

    private void OnLogin()
    {
        if (wasLoggedIn) return;
        wasLoggedIn = true;
        StartRefresh();
    }

    private void OnLogout(int type, int code)
    {
        wasLoggedIn = false;
        activeEvents.Clear();
        ignoredActiveEvents.Clear();
        completionUnknownEventIds.Clear();
        completionIssues.Clear();
        windowVisible = false;
        refreshComplete = false;
        waitingForAchievements = false;
        nextEvaluationAt = DateTimeOffset.MinValue;
        Interlocked.Exchange(ref nextRefreshAtUnixSeconds, 0);
        Interlocked.Exchange(ref consecutiveRefreshFailures, 0);
        Interlocked.Exchange(ref refreshCts, null)?.Cancel();
        refreshInProgress = false;
    }

    private void OnCommand(string command, string args) => windowVisible = true;

    private void StartRefresh()
    {
        if (disposed) return;
        statusMessage = null;
        var request = new CancellationTokenSource();
        Interlocked.Exchange(ref refreshCts, request)?.Cancel();
        refreshInProgress = true;
        _ = RefreshAndEvaluateAsync(request);
    }

    private async Task RefreshAndEvaluateAsync(CancellationTokenSource request)
    {
        try
        {
            var succeeded = await dataService.RefreshAsync(config.EventsUrl, request.Token).ConfigureAwait(false);
            if (disposed || request.IsCancellationRequested) return;

            var completedAt = DateTimeOffset.UtcNow;
            if (succeeded)
            {
                Interlocked.Exchange(ref consecutiveRefreshFailures, 0);
                ScheduleRefresh(completedAt.Add(RefreshInterval));
            }
            else
            {
                var failureCount = Interlocked.Increment(ref consecutiveRefreshFailures);
                var retryIndex = Math.Min(failureCount - 1, RefreshRetryDelays.Length - 1);
                ScheduleRefresh(completedAt.Add(RefreshRetryDelays[retryIndex]));
            }

            refreshComplete = true;
        }
        catch (OperationCanceledException) when (request.IsCancellationRequested)
        {
        }
        finally
        {
            if (ReferenceEquals(Interlocked.CompareExchange(ref refreshCts, null, request), request))
                refreshInProgress = false;
            request.Dispose();
        }
    }

    private void OnFrameworkUpdate(IFramework framework)
    {
        if (!clientState.IsLoggedIn || !playerState.IsLoaded || playerState.ContentId == 0) return;
        var now = DateTimeOffset.UtcNow;
        if (!refreshInProgress && IsRefreshDue(now)) StartRefresh();
        if (refreshComplete ||
            (waitingForAchievements && unlockState.IsAchievementListLoaded) ||
            (dataService.Cached != null && now >= nextEvaluationAt))
        {
            refreshComplete = false;
            waitingForAchievements = false;
            EvaluateActiveEvents(now);
        }
    }

    private void EvaluateActiveEvents(DateTimeOffset now)
    {
        activeEvents.Clear();
        ignoredActiveEvents.Clear();
        completionUnknownEventIds.Clear();
        completionIssues.Clear();
        nextEvaluationAt = now.AddMinutes(1);
        var document = dataService.Cached;
        if (document == null)
        {
            // The user must be able to distinguish an unavailable source from no open events.
            windowVisible = true;
            return;
        }

        var characterId = GetCharacterId();
        if (characterId == null) return;
        var character = config.ForCharacter(characterId);
        var today = TimeZoneInfo.ConvertTime(now, ChinaTimeZone).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        var shouldNotify = false;
        var stateChanged = false;

        foreach (var item in document.Events)
        {
            if (now < item.StartAt.ToUniversalTime() || now >= item.EndAt.ToUniversalTime()) continue;
            var state = character.Events.TryGetValue(item.Id, out var saved) && saved != null
                ? saved
                : new EventState();
            var issues = new List<string>();
            var questCompletionKnown = false;
            if (item.QuestId.HasValue)
            {
                var quest = dataManager.GetExcelSheet<Quest>().GetRowOrDefault(item.QuestId.Value);
                if (quest is { } questRow)
                {
                    questCompletionKnown = true;
                    if (unlockState.IsQuestCompleted(questRow)) continue;
                }
                else
                {
                    issues.Add($"活动数据中的任务 ID {item.QuestId.Value} 无法在当前游戏数据中找到，任务完成状态可能不准确。");
                }
            }
            if (item.AchievementId.HasValue)
            {
                var achievement = dataManager.GetExcelSheet<Achievement>()
                    .GetRowOrDefault(item.AchievementId.Value);
                if (achievement is not { } achievementRow)
                {
                    issues.Add($"活动数据中的成就 ID {item.AchievementId.Value} 无法在当前游戏数据中找到，成就完成状态可能不准确。");
                }
                else if (unlockState.IsAchievementListLoaded)
                {
                    if (unlockState.IsAchievementComplete(achievementRow)) continue;
                }
                else if (!questCompletionKnown)
                {
                    // The game only sends the full achievement list after the player requests it.
                    // Keep the activity visible so a missing list cannot suppress the reminder forever.
                    waitingForAchievements = true;
                    completionUnknownEventIds.Add(item.Id);
                }
            }
            if (!item.QuestId.HasValue && !item.AchievementId.HasValue)
                issues.Add("活动数据没有提供任务或成就完成映射；完成活动后可以手动忽略提醒。");
            if (state.Ignored)
            {
                ignoredActiveEvents.Add(item);
                continue;
            }
            if (issues.Count > 0) completionIssues[item.Id] = issues;

            activeEvents.Add(item);
            if (state.LastNotifiedDate == today) continue;
            shouldNotify = true;
            stateChanged = true;
            state.LastNotifiedDate = today;
            character.Events[item.Id] = state;
        }

        if (shouldNotify) windowVisible = true;
        if (stateChanged) config.Save();
    }

    private string? GetCharacterId()
    {
        if (!playerState.IsLoaded || playerState.ContentId == 0) return null;
        return playerState.ContentId.ToString(CultureInfo.InvariantCulture);
    }

    private void DrawUI()
    {
        if (!windowVisible) return;
        ImGui.SetNextWindowSize(new Vector2(620, 420), ImGuiCond.FirstUseEver);
        if (!ImGui.Begin("Seasonal Event", ref windowVisible))
        {
            ImGui.End();
            return;
        }

        if (ImGui.Button("立即刷新") && !refreshInProgress) StartRefresh();
        if (refreshInProgress)
        {
            ImGui.SameLine();
            ImGui.TextUnformatted("正在刷新活动数据……");
        }
        else if (dataService.LastSuccessAt.HasValue)
        {
            ImGui.SameLine();
            ImGui.TextUnformatted($"最近刷新：{FormatChinaTime(dataService.LastSuccessAt)}");
        }

        if (dataService.Cached == null)
            TextWrappedUnformatted(dataService.LastError ?? "正在获取活动数据……");
        else if (activeEvents.Count == 0)
            TextWrappedUnformatted("当前没有正在进行且尚未忽略或完成的季节活动。");
        else
        {
            foreach (var item in activeEvents.ToArray())
            {
                ImGui.Separator();
                ImGui.TextUnformatted(item.Title);
                var startAt = TimeZoneInfo.ConvertTime(item.StartAt, ChinaTimeZone);
                var endAt = TimeZoneInfo.ConvertTime(item.EndAt, ChinaTimeZone);
                ImGui.TextUnformatted($"时间：{startAt:yyyy-MM-dd HH:mm} - {endAt:yyyy-MM-dd HH:mm} (UTC+8)");
                ImGui.TextUnformatted($"任务：{item.QuestName}");
                ImGui.TextUnformatted($"接取：{item.QuestNpc}");
                if (item.QuestLevel.HasValue) ImGui.TextUnformatted($"等级：{item.QuestLevel.Value}");
                if (completionUnknownEventIds.Contains(item.Id))
                    DrawWarning("成就列表尚未加载，暂时无法确认该活动是否已经完成。");
                if (completionIssues.TryGetValue(item.Id, out var issues))
                {
                    foreach (var issue in issues) DrawWarning(issue);
                }
                if (ImGui.Button($"打开任务地图##{item.Id}"))
                {
                    if (gameGui.OpenMapWithMapLink(item.Location.TerritoryId, item.Location.MapId, new Vector3(item.Location.X, item.Location.Y, item.Location.Z)))
                        statusMessage = null;
                    else
                        statusMessage = "无法打开任务地图，请稍后重试。";
                }
                if (item.Teleport != null && teleport.HasFunction)
                {
                    ImGui.SameLine();
                    if (ImGui.Button($"传送到附近##{item.Id}"))
                    {
                        try
                        {
                            if (!teleport.InvokeFunc(item.Teleport.AetheryteId, item.Teleport.SubIndex))
                                statusMessage = "传送失败：目标可能未解锁或当前无法传送。";
                            else
                                statusMessage = null;
                        }
                        catch (Exception ex)
                        {
                            statusMessage = "传送插件不可用。";
                            log.Warning(ex, "Teleporter IPC invocation failed");
                        }
                    }
                }
                else if (item.Teleport != null)
                {
                    ImGui.SameLine();
                    ImGui.TextDisabled("启用 Teleporter 后可一键传送");
                }
                ImGui.SameLine();
                if (ImGui.Button($"忽略##{item.Id}")) Ignore(item);
                if (item.Rewards.Count > 0)
                {
                    ImGui.Text("奖励：");
                    foreach (var reward in item.Rewards)
                    {
                        ImGui.Bullet();
                        ImGui.SameLine();
                        ImGui.TextUnformatted(reward.Name);
                        if (ImGui.IsItemHovered() &&
                            (!string.IsNullOrWhiteSpace(reward.Description) ||
                             !string.IsNullOrWhiteSpace(reward.Category) ||
                             reward.Flags.Count > 0))
                        {
                            ImGui.BeginTooltip();
                            if (!string.IsNullOrWhiteSpace(reward.Category)) ImGui.TextUnformatted(reward.Category);
                            if (!string.IsNullOrWhiteSpace(reward.Description)) TextWrappedUnformatted(reward.Description);
                            if (reward.Flags.Count > 0) ImGui.TextUnformatted(string.Join(" | ", reward.Flags));
                            ImGui.EndTooltip();
                        }
                    }
                }
            }
        }

        if (ignoredActiveEvents.Count > 0 &&
            ImGui.CollapsingHeader($"已忽略的当前活动（{ignoredActiveEvents.Count}）"))
        {
            foreach (var item in ignoredActiveEvents.ToArray())
            {
                ImGui.TextUnformatted(item.Title);
                ImGui.SameLine();
                if (ImGui.Button($"恢复提醒##restore-{item.Id}")) Restore(item);
            }
        }

        if (!string.IsNullOrWhiteSpace(statusMessage)) DrawWarning(statusMessage);
        if (dataService.Cached != null && !string.IsNullOrWhiteSpace(dataService.LastError))
            DrawWarning(dataService.LastError);
        if (ImGui.CollapsingHeader("数据源设置"))
        {
            ImGui.InputText("活动 JSON 地址", ref eventsUrlInput, 1024);
            if (ImGui.Button("保存并刷新"))
            {
                if (!EventDataService.TryNormalizeSourceUrl(eventsUrlInput, out var normalizedUrl))
                {
                    statusMessage = "活动 JSON 地址必须是有效的 HTTPS 地址。";
                }
                else
                {
                    config.EventsUrl = normalizedUrl;
                    eventsUrlInput = normalizedUrl;
                    config.Save();
                    if (clientState.IsLoggedIn) StartRefresh();
                }
            }
            if (refreshInProgress)
                ImGui.TextUnformatted("正在刷新活动数据……");
        }
        if (ImGui.CollapsingHeader("诊断信息"))
        {
            var diagnosticText = BuildDiagnosticText();
            if (ImGui.Button("复制诊断信息")) ImGui.SetClipboardText(diagnosticText);
            TextWrappedUnformatted(diagnosticText);
        }
        ImGui.End();
    }

    private void Ignore(SeasonalEventData item)
    {
        var characterId = GetCharacterId();
        if (characterId == null) return;
        var character = config.ForCharacter(characterId);
        var state = character.Events.TryGetValue(item.Id, out var saved) && saved != null
            ? saved
            : new EventState();
        state.Ignored = true;
        character.Events[item.Id] = state;
        config.Save();
        EvaluateActiveEvents(DateTimeOffset.UtcNow);
    }

    private void Restore(SeasonalEventData item)
    {
        var characterId = GetCharacterId();
        if (characterId == null) return;
        var character = config.ForCharacter(characterId);
        if (!character.Events.TryGetValue(item.Id, out var state) || state == null) return;
        state.Ignored = false;
        config.Save();
        EvaluateActiveEvents(DateTimeOffset.UtcNow);
    }

    private void OpenConfigUI() => windowVisible = true;

    private static void TextWrappedUnformatted(string text)
    {
        ImGui.PushTextWrapPos();
        ImGui.TextUnformatted(text);
        ImGui.PopTextWrapPos();
    }

    private static void DrawWarning(string text)
    {
        ImGui.PushStyleColor(ImGuiCol.Text, new Vector4(1, 0.7f, 0.2f, 1));
        TextWrappedUnformatted(text);
        ImGui.PopStyleColor();
    }

    private void ScheduleRefresh(DateTimeOffset at) =>
        Interlocked.Exchange(ref nextRefreshAtUnixSeconds, at.ToUnixTimeSeconds());

    private bool IsRefreshDue(DateTimeOffset now)
    {
        var next = Interlocked.Read(ref nextRefreshAtUnixSeconds);
        return next <= 0 || now.ToUnixTimeSeconds() >= next;
    }

    private DateTimeOffset? GetNextRefreshAt()
    {
        var value = Interlocked.Read(ref nextRefreshAtUnixSeconds);
        return value > 0 ? DateTimeOffset.FromUnixTimeSeconds(value) : null;
    }

    private string BuildDiagnosticText()
    {
        var document = dataService.Cached;
        var builder = new StringBuilder();
        builder.AppendLine($"Seasonal Event {typeof(Plugin).Assembly.GetName().Version?.ToString() ?? "未知"}");
        builder.AppendLine($"数据源：{GetSafeSourceUrl()}");
        builder.AppendLine($"缓存：{(document == null ? "不可用" : dataService.CacheLoadedFromDisk ? "可用（启动时从磁盘加载）" : "可用（本次运行已联网更新）")}");
        builder.AppendLine($"缓存写入：{FormatChinaTime(dataService.LastCacheWriteAt)}");
        builder.AppendLine($"最近尝试：{FormatChinaTime(dataService.LastAttemptAt)}");
        builder.AppendLine($"最近成功：{FormatChinaTime(dataService.LastSuccessAt)}");
        builder.AppendLine($"最近失败：{FormatChinaTime(dataService.LastFailureAt)}");
        builder.AppendLine($"下次刷新：{(refreshInProgress ? "正在刷新" : FormatChinaTime(GetNextRefreshAt()))}");
        builder.AppendLine($"连续失败：{Interlocked.CompareExchange(ref consecutiveRefreshFailures, 0, 0)}");
        builder.AppendLine($"数据版本：{document?.DataVersion.ToString(CultureInfo.InvariantCulture) ?? "不可用"}");
        builder.AppendLine($"数据发布时间：{FormatChinaTime(document?.PublishedAt)}");
        builder.AppendLine($"活动条目：{document?.Events.Count.ToString(CultureInfo.InvariantCulture) ?? "不可用"}");
        builder.Append($"最近错误：{GetSafeFailureMessage()}");
        return builder.ToString();
    }

    private string GetSafeSourceUrl()
    {
        if (!Uri.TryCreate(config.EventsUrl, UriKind.Absolute, out var uri)) return "无效地址";
        var builder = new UriBuilder(uri.Scheme, uri.Host, uri.IsDefaultPort ? -1 : uri.Port, uri.AbsolutePath);
        return builder.Uri.AbsoluteUri;
    }

    private string GetSafeFailureMessage()
    {
        var message = dataService.LastFailureMessage;
        if (string.IsNullOrWhiteSpace(message)) return "无";
        if (!string.IsNullOrWhiteSpace(config.EventsUrl))
            message = message.Replace(config.EventsUrl, GetSafeSourceUrl(), StringComparison.Ordinal);
        var cacheDirectory = Path.GetDirectoryName(cachePath);
        if (!string.IsNullOrWhiteSpace(cacheDirectory))
            message = message.Replace(cacheDirectory, "<插件配置目录>", StringComparison.OrdinalIgnoreCase);
        message = message.Replace('\r', ' ').Replace('\n', ' ').Trim();
        return message.Length <= 500 ? message : $"{message[..500]}…";
    }

    private static string FormatChinaTime(DateTimeOffset? value) =>
        value.HasValue
            ? TimeZoneInfo.ConvertTime(value.Value, ChinaTimeZone).ToString("yyyy-MM-dd HH:mm:ss 'UTC+8'", CultureInfo.InvariantCulture)
            : "无";

    public void Dispose()
    {
        disposed = true;
        Interlocked.Exchange(ref refreshCts, null)?.Cancel();
        pluginInterface.UiBuilder.Draw -= DrawUI;
        pluginInterface.UiBuilder.OpenConfigUi -= OpenConfigUI;
        clientState.Login -= OnLogin;
        clientState.Logout -= OnLogout;
        framework.Update -= OnFrameworkUpdate;
        commandManager.RemoveHandler(Command);
        dataService.Dispose();
    }
}

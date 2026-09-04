using System.Numerics;
using System.Globalization;
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
    private readonly HashSet<string> completionUnknownEventIds = new(StringComparer.Ordinal);
    private CancellationTokenSource? refreshCts;
    private bool windowVisible;
    private volatile bool refreshComplete;
    private volatile bool refreshInProgress;
    private volatile bool disposed;
    private bool waitingForAchievements;
    private bool wasLoggedIn;
    private DateTimeOffset nextEvaluationAt = DateTimeOffset.MinValue;
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
        config.Initialize(pluginInterface);
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
        completionUnknownEventIds.Clear();
        windowVisible = false;
        refreshComplete = false;
        waitingForAchievements = false;
        nextEvaluationAt = DateTimeOffset.MinValue;
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
            await dataService.RefreshAsync(config.EventsUrl, request.Token).ConfigureAwait(false);
            if (!disposed && !request.IsCancellationRequested) refreshComplete = true;
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
        completionUnknownEventIds.Clear();
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
            if (state.Ignored) continue;
            var questCompletionKnown = false;
            if (item.QuestId.HasValue)
            {
                var quest = dataManager.GetExcelSheet<Quest>().GetRowOrDefault(item.QuestId.Value);
                if (quest is { } questRow)
                {
                    questCompletionKnown = true;
                    if (unlockState.IsQuestCompleted(questRow)) continue;
                }
            }
            if (item.AchievementId.HasValue)
            {
                if (unlockState.IsAchievementListLoaded)
                {
                    var achievement = dataManager.GetExcelSheet<Achievement>()
                        .GetRowOrDefault(item.AchievementId.Value);
                    if (achievement is { } row && unlockState.IsAchievementComplete(row)) continue;
                }
                else if (!questCompletionKnown)
                {
                    // The game only sends the full achievement list after the player requests it.
                    // Keep the activity visible so a missing list cannot suppress the reminder forever.
                    waitingForAchievements = true;
                    completionUnknownEventIds.Add(item.Id);
                }
            }

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
                    if (ImGui.Button($"传送至主城##{item.Id}"))
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
        activeEvents.Remove(item);
        config.Save();
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

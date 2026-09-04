using System.Net;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using Dalamud.Plugin.Services;

namespace SeasonalEvent;

public sealed class EventDataService : IDisposable
{
    private static readonly JsonSerializerOptions JsonOptions = CreateJsonOptions();
    private readonly IPluginLog log;
    private readonly HttpClient client = new() { Timeout = TimeSpan.FromSeconds(8) };
    private readonly SemaphoreSlim refreshGate = new(1, 1);
    private readonly string cachePath;
    private string? etag;
    private string? cachedSourceUrl;
    private volatile bool disposed;

    public EventDataService(IPluginLog log, string cachePath)
    {
        this.log = log;
        this.cachePath = cachePath;
    }

    public EventsDocument? Cached { get; private set; }
    public DateTimeOffset? LastAttemptAt { get; private set; }
    public DateTimeOffset? LastSuccessAt { get; private set; }
    public DateTimeOffset? LastFailureAt { get; private set; }
    public DateTimeOffset? LastCacheWriteAt { get; private set; }
    public string? LastError { get; private set; }
    public string? LastFailureMessage { get; private set; }
    public bool CacheLoadedFromDisk { get; private set; }

    public void LoadCache(string expectedSourceUrl)
    {
        try
        {
            if (!File.Exists(cachePath)) return;
            var json = File.ReadAllText(cachePath);
            using var root = JsonDocument.Parse(json);
            if (root.RootElement.TryGetProperty("document", out _))
            {
                var envelope = JsonSerializer.Deserialize<CacheEnvelope>(json, JsonOptions)
                    ?? throw new InvalidDataException("本地活动缓存为空");
                if (envelope.Document == null) throw new InvalidDataException("本地活动缓存缺少活动数据");
                Validate(envelope.Document);
                if (!TryNormalizeSourceUrl(expectedSourceUrl, out var expectedUrl) ||
                    !string.Equals(envelope.SourceUrl, expectedUrl, StringComparison.Ordinal))
                {
                    LastError = "本地活动缓存来自其他数据源，已忽略。";
                    return;
                }

                Cached = envelope.Document;
                cachedSourceUrl = envelope.SourceUrl;
                etag = envelope.ETag;
                CacheLoadedFromDisk = true;
                LastCacheWriteAt = File.GetLastWriteTimeUtc(cachePath);
                return;
            }

            // Version 1 stored only the document, so its source cannot be proven.
            // Validate it for a useful diagnostic, but do not display it as same-source data.
            _ = DeserializeAndValidate(json);
            LastError = "旧版活动缓存没有数据源信息，已忽略；成功刷新后会自动升级缓存格式。";
        }
        catch (Exception ex)
        {
            LastError = $"本地活动缓存无效：{ex.Message}";
            LastFailureMessage = LastError;
            LastFailureAt = DateTimeOffset.UtcNow;
            log.Error(ex, "Failed to load seasonal event cache");
        }
    }

    public async Task<bool> RefreshAsync(string url, CancellationToken cancellationToken)
    {
        LastAttemptAt = DateTimeOffset.UtcNow;
        LastError = null;
        try
        {
            if (!TryNormalizeSourceUrl(url, out var sourceUrl))
                throw new InvalidDataException("活动 JSON 地址必须是有效的 HTTPS 地址");

            await refreshGate.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (!string.Equals(cachedSourceUrl, sourceUrl, StringComparison.Ordinal))
                {
                    Cached = null;
                    cachedSourceUrl = null;
                    etag = null;
                    CacheLoadedFromDisk = false;
                    LastCacheWriteAt = null;
                }

                using var request = new HttpRequestMessage(HttpMethod.Get, sourceUrl);
                if (Cached != null &&
                    !string.IsNullOrWhiteSpace(etag) &&
                    System.Net.Http.Headers.EntityTagHeaderValue.TryParse(etag, out var entityTag))
                    request.Headers.IfNoneMatch.Add(entityTag);
                using var response = await client.SendAsync(request, cancellationToken).ConfigureAwait(false);
                if (response.StatusCode == HttpStatusCode.NotModified)
                {
                    if (Cached == null) throw new InvalidDataException("数据源返回 304，但本地缓存不存在");
                    LastSuccessAt = DateTimeOffset.UtcNow;
                    return true;
                }
                response.EnsureSuccessStatusCode();

                var json = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
                var document = DeserializeAndValidate(json);
                var responseEtag = response.Headers.ETag?.ToString();
                var cacheJson = JsonSerializer.Serialize(new CacheEnvelope
                {
                    SourceUrl = sourceUrl,
                    ETag = responseEtag,
                    Document = document,
                }, JsonOptions);
                var cacheDirectory = Path.GetDirectoryName(cachePath)!;
                Directory.CreateDirectory(cacheDirectory);
                var temporaryPath = Path.Combine(
                    cacheDirectory,
                    $"{Path.GetFileName(cachePath)}.{Guid.NewGuid():N}.tmp");
                try
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    File.WriteAllText(temporaryPath, cacheJson);
                    cancellationToken.ThrowIfCancellationRequested();
                    File.Move(temporaryPath, cachePath, true);
                }
                finally
                {
                    if (File.Exists(temporaryPath)) File.Delete(temporaryPath);
                }

                cancellationToken.ThrowIfCancellationRequested();
                Cached = document;
                cachedSourceUrl = sourceUrl;
                etag = responseEtag;
                CacheLoadedFromDisk = false;
                LastCacheWriteAt = DateTimeOffset.UtcNow;
                LastSuccessAt = DateTimeOffset.UtcNow;
                return true;
            }
            finally
            {
                refreshGate.Release();
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception) when (disposed || cancellationToken.IsCancellationRequested)
        {
            throw new OperationCanceledException(cancellationToken);
        }
        catch (Exception ex)
        {
            LastError = $"活动数据暂不可用：{ex.Message}";
            LastFailureMessage = LastError;
            LastFailureAt = DateTimeOffset.UtcNow;
            log.Error(ex, "Failed to refresh seasonal event data");
            return false;
        }
    }

    private static EventsDocument DeserializeAndValidate(string json)
    {
        var document = JsonSerializer.Deserialize<EventsDocument>(json, JsonOptions)
            ?? throw new InvalidDataException("活动数据为空");
        Validate(document);
        return document;
    }

    private static void Validate(EventsDocument document)
    {
        if (document.SchemaVersion != 1) throw new InvalidDataException("不支持的活动数据版本");
        if (document.DataVersion < 1) throw new InvalidDataException("活动数据版本无效");
        if (document.PublishedAt == default) throw new InvalidDataException("活动数据发布时间无效");
        if (document.Events == null) throw new InvalidDataException("活动列表缺失");
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in document.Events)
        {
            if (item == null) throw new InvalidDataException("活动列表包含空项目");
            if (!IsValidEventId(item.Id) || !ids.Add(item.Id))
                throw new InvalidDataException("活动 ID 缺失或重复");
            if (string.IsNullOrWhiteSpace(item.Title) ||
                string.IsNullOrWhiteSpace(item.QuestName) ||
                string.IsNullOrWhiteSpace(item.QuestNpc))
                throw new InvalidDataException($"活动文本缺失：{item.Id}");
            if (item.StartAt == default || item.EndAt == default || item.EndAt <= item.StartAt)
                throw new InvalidDataException($"活动时间无效：{item.Id}");
            if (item.QuestLevel is <= 0) throw new InvalidDataException($"活动等级无效：{item.Id}");
            if (item.QuestId is 0) throw new InvalidDataException($"任务映射无效：{item.Id}");
            if (item.AchievementId is 0) throw new InvalidDataException($"成就映射无效：{item.Id}");
            if (item.Location == null)
                throw new InvalidDataException($"活动地点缺失：{item.Id}");
            if (item.Location.TerritoryId == 0 || item.Location.MapId == 0)
                throw new InvalidDataException($"活动地点无效：{item.Id}");
            if (!float.IsFinite(item.Location.X) ||
                !float.IsFinite(item.Location.Y) ||
                !float.IsFinite(item.Location.Z) ||
                Math.Abs(item.Location.X) > 100000 ||
                Math.Abs(item.Location.Y) > 100000 ||
                Math.Abs(item.Location.Z) > 100000)
                throw new InvalidDataException($"活动坐标无效：{item.Id}");
            if ((item.Location.DisplayX.HasValue && !float.IsFinite(item.Location.DisplayX.Value)) ||
                (item.Location.DisplayY.HasValue && !float.IsFinite(item.Location.DisplayY.Value)))
                throw new InvalidDataException($"活动显示坐标无效：{item.Id}");
            if (item.Teleport is { AetheryteId: 0 })
                throw new InvalidDataException($"传送目标无效：{item.Id}");
            if (!TryNormalizeSourceUrl(item.SourceUrl, out _) ||
                !item.LastVerifiedAt.HasValue ||
                item.LastVerifiedAt.Value == default)
                throw new InvalidDataException($"活动来源无效：{item.Id}");
            if (item.Rewards == null || item.Rewards.Count == 0 || item.Rewards.Any(reward =>
                    reward == null ||
                    string.IsNullOrWhiteSpace(reward.Name) ||
                    reward.Category == null ||
                    reward.Description == null ||
                    reward.Flags == null ||
                    reward.Flags.Any(flag => flag == null)))
                throw new InvalidDataException($"活动奖励无效：{item.Id}");
        }
    }

    public static bool TryNormalizeSourceUrl(string value, out string normalized)
    {
        normalized = string.Empty;
        if (!Uri.TryCreate(value.Trim(), UriKind.Absolute, out var uri) ||
            uri.Scheme != Uri.UriSchemeHttps ||
            string.IsNullOrWhiteSpace(uri.Host))
            return false;
        normalized = uri.AbsoluteUri;
        return true;
    }

    private static JsonSerializerOptions CreateJsonOptions()
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        options.Converters.Add(new RequiredOffsetDateTimeOffsetConverter());
        return options;
    }

    private static bool IsValidEventId(string value)
    {
        if (string.IsNullOrEmpty(value) || value.Length is < 3 or > 64 || !char.IsAsciiLetterOrDigit(value[0]))
            return false;
        return value.All(character =>
            character is >= 'a' and <= 'z' or >= '0' and <= '9' or '-');
    }

    private sealed class RequiredOffsetDateTimeOffsetConverter : JsonConverter<DateTimeOffset>
    {
        public override DateTimeOffset Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        {
            var value = reader.GetString();
            if (string.IsNullOrWhiteSpace(value) || !HasExplicitOffset(value) ||
                !reader.TryGetDateTimeOffset(out var result))
                throw new JsonException("时间必须是带时区的 ISO 8601 格式");
            return result;
        }

        public override void Write(Utf8JsonWriter writer, DateTimeOffset value, JsonSerializerOptions options) =>
            writer.WriteStringValue(value.ToString("O", CultureInfo.InvariantCulture));

        private static bool HasExplicitOffset(string value)
        {
            if (value.EndsWith('Z')) return true;
            var timeSeparator = value.IndexOf('T');
            var offsetIndex = Math.Max(value.LastIndexOf('+'), value.LastIndexOf('-'));
            return timeSeparator >= 0 &&
                   offsetIndex > timeSeparator &&
                   value.Length - offsetIndex == 6 &&
                   value[offsetIndex + 3] == ':' &&
                   char.IsAsciiDigit(value[offsetIndex + 1]) &&
                   char.IsAsciiDigit(value[offsetIndex + 2]) &&
                   char.IsAsciiDigit(value[offsetIndex + 4]) &&
                   char.IsAsciiDigit(value[offsetIndex + 5]);
        }
    }

    private sealed class CacheEnvelope
    {
        public string SourceUrl { get; set; } = string.Empty;
        public string? ETag { get; set; }
        public EventsDocument Document { get; set; } = new();
    }

    public void Dispose()
    {
        disposed = true;
        client.Dispose();
    }
}

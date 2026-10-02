using System.Net;
using System.Text.Json;
using Dalamud.Plugin.Services;

namespace SeasonalEvent;

public sealed class EventDataService : IDisposable
{
    private static readonly JsonSerializerOptions JsonOptions = EventDataValidation.CreateJsonOptions();
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
                EventDataValidation.Validate(envelope.Document);
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
            _ = EventDataValidation.DeserializeAndValidate(json);
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
                var document = EventDataValidation.DeserializeAndValidate(json);
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

    public static bool TryNormalizeSourceUrl(string? value, out string normalized) =>
        EventDataValidation.TryNormalizeSourceUrl(value, out normalized);

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

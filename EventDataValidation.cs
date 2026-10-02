using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace SeasonalEvent;

public static class EventDataValidation
{
    public static EventsDocument DeserializeAndValidate(string json)
    {
        var document = JsonSerializer.Deserialize<EventsDocument>(json, CreateJsonOptions())
            ?? throw new InvalidDataException("活动数据为空");
        Validate(document);
        return document;
    }

    public static void Validate(EventsDocument document)
    {
        if (document.SchemaVersion is not (1 or 2)) throw new InvalidDataException("不支持的活动数据版本");
        if (document.DataVersion < 1) throw new InvalidDataException("活动数据版本无效");
        if (document.PublishedAt == default) throw new InvalidDataException("活动数据发布时间无效");
        if (document.Events == null) throw new InvalidDataException("活动列表缺失");
        if (document.CollectionStatus is { } collectionStatus &&
            (collectionStatus.Status is not ("ok" or "alert") ||
             string.IsNullOrWhiteSpace(collectionStatus.Code) ||
             collectionStatus.UnavailableSources == null ||
             collectionStatus.UnavailableSources.Any(url => !TryNormalizeSourceUrl(url, out _))))
            throw new InvalidDataException("活动采集状态无效");

        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in document.Events)
        {
            if (item == null) throw new InvalidDataException("活动列表包含空项目");
            if (!IsValidEventId(item.Id) || !ids.Add(item.Id))
                throw new InvalidDataException("活动 ID 缺失或重复");
            if (string.IsNullOrWhiteSpace(item.Title) ||
                (document.SchemaVersion == 1 &&
                 (string.IsNullOrWhiteSpace(item.QuestName) || string.IsNullOrWhiteSpace(item.QuestNpc))) ||
                (item.QuestName != null && string.IsNullOrWhiteSpace(item.QuestName)) ||
                (item.QuestNpc != null && string.IsNullOrWhiteSpace(item.QuestNpc)))
                throw new InvalidDataException($"活动文本缺失或无效：{item.Id}");
            if (item.StartAt == default || item.EndAt == default || item.EndAt <= item.StartAt)
                throw new InvalidDataException($"活动时间无效：{item.Id}");
            if (item.QuestLevel is <= 0) throw new InvalidDataException($"活动等级无效：{item.Id}");
            if (item.QuestId is 0) throw new InvalidDataException($"任务映射无效：{item.Id}");
            if (item.AchievementId is 0) throw new InvalidDataException($"成就映射无效：{item.Id}");
            if (item.Location == null && document.SchemaVersion == 1)
                throw new InvalidDataException($"活动地点缺失：{item.Id}");
            if (item.Location is { } location)
            {
                if (location.TerritoryId == 0 || location.MapId == 0)
                    throw new InvalidDataException($"活动地点无效：{item.Id}");
                if (!float.IsFinite(location.X) || !float.IsFinite(location.Y) || !float.IsFinite(location.Z) ||
                    Math.Abs(location.X) > 100000 || Math.Abs(location.Y) > 100000 || Math.Abs(location.Z) > 100000)
                    throw new InvalidDataException($"活动坐标无效：{item.Id}");
                if ((location.DisplayX.HasValue && !float.IsFinite(location.DisplayX.Value)) ||
                    (location.DisplayY.HasValue && !float.IsFinite(location.DisplayY.Value)))
                    throw new InvalidDataException($"活动显示坐标无效：{item.Id}");
            }
            if (item.Teleport is { AetheryteId: 0 })
                throw new InvalidDataException($"传送目标无效：{item.Id}");
            if (!TryNormalizeSourceUrl(item.SourceUrl, out _) ||
                (item.AnnouncementUrl != null && !TryNormalizeSourceUrl(item.AnnouncementUrl, out _)) ||
                !item.LastVerifiedAt.HasValue || item.LastVerifiedAt.Value == default)
                throw new InvalidDataException($"活动来源无效：{item.Id}");
            if (item.Rewards == null || (document.SchemaVersion == 1 && item.Rewards.Count == 0) ||
                item.Rewards.Any(reward => reward == null || string.IsNullOrWhiteSpace(reward.Name) ||
                    reward.Category == null || reward.Description == null || reward.Flags == null ||
                    reward.Flags.Any(flag => flag == null)))
                throw new InvalidDataException($"活动奖励无效：{item.Id}");
        }
    }

    public static bool TryNormalizeSourceUrl(string? value, out string normalized)
    {
        normalized = string.Empty;
        if (string.IsNullOrWhiteSpace(value) || !Uri.TryCreate(value.Trim(), UriKind.Absolute, out var uri) ||
            uri.Scheme != Uri.UriSchemeHttps || string.IsNullOrWhiteSpace(uri.Host))
            return false;
        normalized = uri.AbsoluteUri;
        return true;
    }

    internal static JsonSerializerOptions CreateJsonOptions()
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        options.Converters.Add(new RequiredOffsetDateTimeOffsetConverter());
        return options;
    }

    private static bool IsValidEventId(string value)
    {
        if (string.IsNullOrEmpty(value) || value.Length is < 3 or > 64 || !char.IsAsciiLetterOrDigit(value[0]))
            return false;
        return value.All(character => character is >= 'a' and <= 'z' or >= '0' and <= '9' or '-');
    }

    private sealed class RequiredOffsetDateTimeOffsetConverter : JsonConverter<DateTimeOffset>
    {
        public override DateTimeOffset Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        {
            var value = reader.GetString();
            if (string.IsNullOrWhiteSpace(value) || !HasExplicitOffset(value) || !reader.TryGetDateTimeOffset(out var result))
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
            return timeSeparator >= 0 && offsetIndex > timeSeparator && value.Length - offsetIndex == 6 &&
                   value[offsetIndex + 3] == ':' && char.IsAsciiDigit(value[offsetIndex + 1]) &&
                   char.IsAsciiDigit(value[offsetIndex + 2]) && char.IsAsciiDigit(value[offsetIndex + 4]) &&
                   char.IsAsciiDigit(value[offsetIndex + 5]);
        }
    }
}

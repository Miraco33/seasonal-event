using System.Text.Json.Serialization;

namespace SeasonalEvent;

public sealed class EventsDocument
{
    [JsonPropertyName("schemaVersion")]
    public int SchemaVersion { get; set; }

    [JsonPropertyName("dataVersion")]
    public int DataVersion { get; set; }

    [JsonPropertyName("publishedAt")]
    public DateTimeOffset PublishedAt { get; set; }

    [JsonPropertyName("events")]
    public List<SeasonalEventData> Events { get; set; } = new();
}

public sealed class SeasonalEventData
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("title")]
    public string Title { get; set; } = string.Empty;

    [JsonPropertyName("startAt")]
    public DateTimeOffset StartAt { get; set; }

    [JsonPropertyName("endAt")]
    public DateTimeOffset EndAt { get; set; }

    [JsonPropertyName("questName")]
    public string QuestName { get; set; } = string.Empty;

    [JsonPropertyName("questLevel")]
    public int? QuestLevel { get; set; }

    [JsonPropertyName("questNpc")]
    public string QuestNpc { get; set; } = string.Empty;

    [JsonPropertyName("questId")]
    public uint? QuestId { get; set; }

    [JsonPropertyName("location")]
    public EventLocation Location { get; set; } = new();

    [JsonPropertyName("achievementId")]
    public uint? AchievementId { get; set; }

    [JsonPropertyName("teleport")]
    public TeleportTarget? Teleport { get; set; }

    [JsonPropertyName("rewards")]
    public List<EventReward> Rewards { get; set; } = new();

    [JsonPropertyName("sourceUrl")]
    public string SourceUrl { get; set; } = string.Empty;

    [JsonPropertyName("lastVerifiedAt")]
    public DateTimeOffset? LastVerifiedAt { get; set; }
}

public sealed class TeleportTarget
{
    [JsonPropertyName("aetheryteId")]
    public uint AetheryteId { get; set; }

    [JsonPropertyName("subIndex")]
    public byte SubIndex { get; set; }
}

public sealed class EventLocation
{
    [JsonPropertyName("territoryId")]
    public uint TerritoryId { get; set; }

    [JsonPropertyName("mapId")]
    public uint MapId { get; set; }

    // Coordinates are world coordinates used by IGameGui.OpenMapWithMapLink.
    [JsonPropertyName("x")]
    public float X { get; set; }

    [JsonPropertyName("y")]
    public float Y { get; set; }

    [JsonPropertyName("z")]
    public float Z { get; set; }

    [JsonPropertyName("displayX")]
    public float? DisplayX { get; set; }

    [JsonPropertyName("displayY")]
    public float? DisplayY { get; set; }
}

public sealed class EventReward
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    [JsonPropertyName("category")]
    public string Category { get; set; } = string.Empty;

    [JsonPropertyName("description")]
    public string Description { get; set; } = string.Empty;

    [JsonPropertyName("flags")]
    public List<string> Flags { get; set; } = new();
}

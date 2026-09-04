using Dalamud.Configuration;
using Dalamud.Plugin;

namespace SeasonalEvent;

public sealed class PluginConfiguration : IPluginConfiguration
{
    private const string LegacyPlaceholderEventsUrl = "https://example.invalid/seasonal-event/events.json";
    private const string LegacyRawEventsUrl = "https://raw.githubusercontent.com/Miraco33/seasonal-event/main/data/seasonal-event/events.json";
    public const string DefaultEventsUrl = "https://miraco33.github.io/seasonal-event/events.json";

    public int Version { get; set; } = 1;
    public string EventsUrl { get; set; } = DefaultEventsUrl;
    public Dictionary<string, CharacterState> Characters { get; set; } = new(StringComparer.Ordinal);

    [NonSerialized]
    private IDalamudPluginInterface? pluginInterface;

    public void Initialize(IDalamudPluginInterface value)
    {
        pluginInterface = value;
        if (string.IsNullOrWhiteSpace(EventsUrl) ||
            string.Equals(EventsUrl, LegacyPlaceholderEventsUrl, StringComparison.OrdinalIgnoreCase) ||
            string.Equals(EventsUrl, LegacyRawEventsUrl, StringComparison.OrdinalIgnoreCase))
            EventsUrl = DefaultEventsUrl;
        Characters ??= new Dictionary<string, CharacterState>(StringComparer.Ordinal);
    }

    public void Save() => pluginInterface?.SavePluginConfig(this);

    public CharacterState ForCharacter(string characterId)
    {
        Characters ??= new Dictionary<string, CharacterState>(StringComparer.Ordinal);
        if (!Characters.TryGetValue(characterId, out var state) || state == null)
        {
            state = new CharacterState();
            Characters[characterId] = state;
        }

        state.Events ??= new Dictionary<string, EventState>(StringComparer.Ordinal);

        return state;
    }
}

public sealed class CharacterState
{
    public Dictionary<string, EventState> Events { get; set; } = new(StringComparer.Ordinal);
}

public sealed class EventState
{
    public bool Ignored { get; set; }
    public string? LastNotifiedDate { get; set; }
}

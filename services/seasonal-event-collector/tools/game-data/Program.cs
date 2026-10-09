using System.Text;
using System.Text.Json;
using Lumina;
using Lumina.Data;
using Lumina.Excel;
using Lumina.Excel.Sheets;
using GameMap = Lumina.Excel.Sheets.Map;

Console.OutputEncoding = new UTF8Encoding(false);
try
{
    string? gamePath = null;
    string? exportIndexPath = null;
    var questNames = new List<string>();
    var achievementWords = new List<string>();
    var itemNames = new List<string>();
    for (var index = 0; index < args.Length; index++)
    {
        var argument = args[index];
        if (argument is not ("--game-path" or "--quest-name" or "--achievement-keyword" or "--item-name" or "--export-index") || index + 1 >= args.Length)
            throw new ArgumentException("Usage: --game-path <sqpack> (--export-index <output.json> | --quest-name <exact name> [--quest-name ...] [--achievement-keyword <text>] [--item-name <exact name>])");
        var value = args[++index];
        if (argument == "--game-path") gamePath = value;
        else if (argument == "--export-index") exportIndexPath = value;
        else if (argument == "--quest-name") questNames.Add(value);
        else if (argument == "--item-name") itemNames.Add(value);
        else achievementWords.Add(value);
    }
    if (string.IsNullOrWhiteSpace(gamePath) || (exportIndexPath is null && questNames.Count == 0))
        throw new ArgumentException("--game-path and either --export-index or at least one --quest-name are required.");
    if (exportIndexPath is not null && (string.IsNullOrWhiteSpace(exportIndexPath) || questNames.Count != 0 || achievementWords.Count != 0 || itemNames.Count != 0))
        throw new ArgumentException("--export-index is a separate mode and cannot be combined with verification filters.");
    var path = Path.GetFullPath(gamePath);
    if (!Directory.Exists(path) || !Directory.EnumerateFiles(path, "*.index", SearchOption.AllDirectories).Any())
        throw new ArgumentException("The game path must be an existing sqpack directory containing index files.");

    using var data = new GameData(path, new LuminaOptions
    {
        DefaultExcelLanguage = Language.ChineseSimplified,
        CacheFileResources = false,
        LoadMultithreaded = false,
        PanicOnSheetChecksumMismatch = true,
    });
    if (exportIndexPath is not null)
    {
        var exported = GameQuestIndex.Export(data, path, exportIndexPath);
        Console.WriteLine(JsonSerializer.Serialize(exported));
        return 0;
    }
    var quests = data.Excel.GetSheet<Quest>();
    var npcs = data.Excel.GetSheet<ENpcResident>();
    var levels = data.Excel.GetSheet<Level>();
    var maps = data.Excel.GetSheet<GameMap>();
    var territories = data.Excel.GetSheet<TerritoryType>();
    var achievements = data.Excel.GetSheet<Achievement>();
    var namedQuests = quests.Where(quest => !string.IsNullOrWhiteSpace(quest.Name.ExtractText())).ToArray();
    var children = new Dictionary<uint, List<Quest>>();
    foreach (var quest in namedQuests)
    foreach (var previousId in quest.PreviousQuest.Select(previous => previous.RowId).Where(id => id != 0).Distinct())
    {
        if (!children.TryGetValue(previousId, out var list)) children[previousId] = list = [];
        list.Add(quest);
    }

    object DescribeQuest(Quest quest)
    {
        var npc = npcs.GetRowOrDefault(quest.IssuerStart.RowId);
        var level = quest.IssuerLocation.RowId == 0 ? null : levels.GetRowOrDefault(quest.IssuerLocation.RowId);
        object? location = null;
        if (level is { } issuerLevel)
        {
            var map = maps.GetRowOrDefault(issuerLevel.Map.RowId);
            var territory = territories.GetRowOrDefault(issuerLevel.Territory.RowId);
            if (map is { } issuerMap && issuerMap.SizeFactor != 0)
            {
                var displayX = WorldToDisplay(issuerLevel.X, issuerMap.OffsetX, issuerMap.SizeFactor);
                var displayY = WorldToDisplay(issuerLevel.Z, issuerMap.OffsetY, issuerMap.SizeFactor);
                var restoredX = DisplayToWorld(displayX, issuerMap.OffsetX, issuerMap.SizeFactor);
                var restoredZ = DisplayToWorld(displayY, issuerMap.OffsetY, issuerMap.SizeFactor);
                var expected = quest.Name.ExtractText() switch
                {
                    "黑衣青年" => (X: 8.5, Y: 9.7),
                    "抓紧胜利的王冠" or "抓紧胜利的王冠！" => (X: 4.8, Y: 6.1),
                    _ => ((double X, double Y)?)null,
                };
                location = new
                {
                    levelId = issuerLevel.RowId,
                    objectId = issuerLevel.Object.RowId,
                    eventId = issuerLevel.EventId.RowId,
                    territoryId = issuerLevel.Territory.RowId,
                    territoryName = territory?.PlaceName.ValueNullable?.Name.ExtractText(),
                    territoryInternalName = territory?.Name.ExtractText(),
                    mapId = issuerLevel.Map.RowId,
                    mapInternalName = issuerMap.Id.ExtractText(),
                    mapName = issuerMap.PlaceName.ValueNullable?.Name.ExtractText(),
                    sizeFactor = issuerMap.SizeFactor,
                    offsetX = issuerMap.OffsetX,
                    offsetY = issuerMap.OffsetY,
                    world = new { x = issuerLevel.X, y = issuerLevel.Y, z = issuerLevel.Z },
                    display = new { x = displayX, y = displayY, floorX = Math.Floor(displayX * 10) / 10, floorY = Math.Floor(displayY * 10) / 10 },
                    roundtrip = new { x = restoredX, z = restoredZ, maxWorldError = Math.Max(Math.Abs(restoredX - issuerLevel.X), Math.Abs(restoredZ - issuerLevel.Z)) },
                    officialDisplayComparison = expected is { } coordinates ? new
                    {
                        x = coordinates.X, y = coordinates.Y,
                        maxDisplayDifference = Math.Max(Math.Abs(displayX - coordinates.X), Math.Abs(displayY - coordinates.Y)),
                        withinOneDisplayedDecimal = Math.Abs(displayX - coordinates.X) < 0.1 && Math.Abs(displayY - coordinates.Y) < 0.1,
                    } : null,
                };
            }
        }
        return new
        {
            rowId = quest.RowId,
            name = quest.Name.ExtractText(),
            internalId = quest.Id.ExtractText(),
            previousQuestJoin = quest.PreviousQuestJoin,
            previousQuests = quest.PreviousQuest.Where(previous => previous.RowId != 0).Select(previous => new { rowId = previous.RowId, name = quests.GetRowOrDefault(previous.RowId)?.Name.ExtractText() }).ToArray(),
            issuerId = quest.IssuerStart.RowId,
            issuerRowType = quest.IssuerStart.RowType?.Name,
            issuerNpc = npc?.Singular.ExtractText(),
            issuerLocation = location,
            targetEndId = quest.TargetEnd.RowId,
            classJobLevels = quest.ClassJobLevel.Where(value => value != 0).ToArray(),
            isRepeatable = quest.IsRepeatable,
            festivalId = quest.Festival.RowId,
            journalGenreId = quest.JournalGenre.RowId,
            journalGenre = quest.JournalGenre.ValueNullable?.Name.ExtractText(),
            scriptParameters = quest.QuestParams.Where(parameter => !string.IsNullOrWhiteSpace(parameter.ScriptInstruction.ExtractText())).Select(parameter => new { instruction = parameter.ScriptInstruction.ExtractText(), argument = parameter.ScriptArg }).ToArray(),
        };
    }

    var groups = new List<object>();
    var involvedIds = new HashSet<uint>();
    foreach (var requestedName in questNames.Distinct())
    {
        var roots = namedQuests.Where(quest => string.Equals(quest.Name.ExtractText(), requestedName, StringComparison.Ordinal)).ToArray();
        var chain = new Dictionary<uint, Quest>();
        var pending = new Queue<Quest>(roots);
        while (pending.TryDequeue(out var quest))
        {
            if (chain.ContainsKey(quest.RowId)) continue;
            if (chain.Count >= 64) throw new InvalidDataException($"Descendant chain for {requestedName} exceeds the 64-row verification bound.");
            chain.Add(quest.RowId, quest);
            involvedIds.Add(quest.RowId);
            if (children.TryGetValue(quest.RowId, out var next)) foreach (var child in next) pending.Enqueue(child);
        }
        groups.Add(new
        {
            requestedName,
            exactMatchCount = roots.Length,
            rootQuestIds = roots.Select(quest => quest.RowId).ToArray(),
            quests = chain.Values.Select(DescribeQuest).ToArray(),
            terminalQuestCandidates = chain.Values.Where(quest => !children.TryGetValue(quest.RowId, out var next) || !next.Any(child => chain.ContainsKey(child.RowId)))
                .Select(quest => new { rowId = quest.RowId, name = quest.Name.ExtractText() }).ToArray(),
        });
    }
    var matchingAchievements = achievements.Where(achievement =>
    {
        var text = achievement.Name.ExtractText() + " " + achievement.Description.ExtractText();
        return achievementWords.Any(word => text.Contains(word, StringComparison.OrdinalIgnoreCase)) ||
            achievement.Data.Any(reference => reference.Is<Quest>() && involvedIds.Contains(reference.RowId)) ||
            (achievement.Key.Is<Quest>() && involvedIds.Contains(achievement.Key.RowId));
    }).Select(achievement => new
    {
        rowId = achievement.RowId,
        name = achievement.Name.ExtractText(),
        description = achievement.Description.ExtractText(),
        type = achievement.Type,
        key = new { rowId = achievement.Key.RowId, rowType = achievement.Key.RowType?.Name },
        data = achievement.Data.Select(reference => new { rowId = reference.RowId, rowType = reference.RowType?.Name }).ToArray(),
        itemId = achievement.Item.RowId,
    }).ToArray();
    var itemGroups = new List<object>();
    if (itemNames.Count > 0)
    {
        var items = data.Excel.GetSheet<Item>();
        var requestedItems = itemNames.ToHashSet(StringComparer.Ordinal);
        var foundItems = items.Where(item => requestedItems.Contains(item.Name.ExtractText())).ToArray();
        foreach (var requestedName in itemNames.Distinct())
        {
            var matches = foundItems.Where(item => item.Name.ExtractText() == requestedName).ToArray();
            itemGroups.Add(new
            {
                requestedName,
                exactMatchCount = matches.Length,
                items = matches.Select(item => new
                {
                    rowId = item.RowId,
                    name = item.Name.ExtractText(),
                    description = item.Description.ExtractText(),
                    categoryId = item.ItemUICategory.RowId,
                    category = item.ItemUICategory.ValueNullable?.Name.ExtractText(),
                    itemActionId = item.ItemAction.RowId,
                    additionalData = new { rowId = item.AdditionalData.RowId, rowType = item.AdditionalData.RowType?.Name },
                    isUnique = item.IsUnique,
                    isUntradable = item.IsUntradable,
                    isIndisposable = item.IsIndisposable,
                    sellPrice = item.PriceLow,
                    rarity = item.Rarity,
                }).ToArray(),
            });
        }
    }
    var versionPath = Path.Combine(Directory.GetParent(path)?.FullName ?? path, "ffxivgame.ver");
    var report = new
    {
        schemaVersion = 1,
        verifiedAt = DateTimeOffset.UtcNow,
        gameVersion = File.Exists(versionPath) ? File.ReadAllText(versionPath).Trim() : null,
        language = data.Options.DefaultExcelLanguage.ToString(),
        luminaVersion = typeof(GameData).Assembly.GetName().Version?.ToString(),
        excelVersion = typeof(Quest).Assembly.GetName().Version?.ToString(),
        checksumMismatchPolicy = "fail",
        coordinateFormula = "display = (41 / (SizeFactor / 100)) * (((world + offset) * (SizeFactor / 100) + 1024) / 2048) + 1",
        questGroups = groups,
        matchingAchievements,
        itemGroups,
    };
    Console.WriteLine(JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping }));
}
catch (Exception exception)
{
    Console.Error.WriteLine($"Offline verification failed: {exception}");
    return 1;
}
return 0;

static double WorldToDisplay(double world, int offset, ushort sizeFactor)
{
    var scale = sizeFactor / 100d;
    return 41d / scale * ((world + offset) * scale + 1024d) / 2048d + 1d;
}

static double DisplayToWorld(double display, int offset, ushort sizeFactor) => (display - 1d) * 2048d / 41d - 1024d / (sizeFactor / 100d) - offset;

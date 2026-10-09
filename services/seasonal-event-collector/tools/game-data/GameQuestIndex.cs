using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using Lumina;
using Lumina.Excel.Sheets;
using GameMap = Lumina.Excel.Sheets.Map;

internal static class GameQuestIndex
{
    // Keep every named quest. Festival and JournalGenre are facts, not an event classifier.
    public static object Export(GameData data, string gamePath, string outputPath)
    {
        var output = Path.GetFullPath(outputPath);
        var gameRoot = Directory.GetParent(Path.TrimEndingDirectorySeparator(gamePath))?.FullName ?? gamePath;
        var relativeOutput = Path.GetRelativePath(gameRoot, output);
        if (!Path.IsPathRooted(relativeOutput) && relativeOutput != ".." && !relativeOutput.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            throw new ArgumentException("The export destination must be outside the read-only game directory.");
        var quests = data.Excel.GetSheet<Quest>();
        var namedQuests = quests.Where(quest => !string.IsNullOrWhiteSpace(quest.Name.ExtractText()))
            .OrderBy(quest => quest.RowId).ToArray();
        var namedIds = namedQuests.Select(quest => quest.RowId).ToHashSet();
        var npcs = data.Excel.GetSheet<ENpcResident>();
        var levels = data.Excel.GetSheet<Level>();
        var maps = data.Excel.GetSheet<GameMap>();
        var territories = data.Excel.GetSheet<TerritoryType>();
        var achievements = data.Excel.GetSheet<Achievement>();
        var nextIds = new Dictionary<uint, List<uint>>();
        foreach (var quest in quests)
        foreach (var previousId in quest.PreviousQuest.Select(previous => previous.RowId).Where(id => id != 0).Distinct())
        {
            if (!nextIds.TryGetValue(previousId, out var next)) nextIds[previousId] = next = [];
            next.Add(quest.RowId);
        }

        var achievementRows = achievements.Select(achievement => new
        {
            id = achievement.RowId,
            name = achievement.Name.ExtractText(),
            description = achievement.Description.ExtractText(),
            type = achievement.Type,
            keyQuestId = achievement.Key.Is<Quest>() && namedIds.Contains(achievement.Key.RowId) ? (uint?)achievement.Key.RowId : null,
            questIds = achievement.Data.Append(achievement.Key)
                .Where(reference => reference.Is<Quest>() && namedIds.Contains(reference.RowId))
                .Select(reference => reference.RowId).Distinct().Order().ToArray(),
        }).Where(achievement => achievement.questIds.Length > 0).OrderBy(achievement => achievement.id).ToArray();
        var achievementIds = new Dictionary<uint, List<uint>>();
        foreach (var achievement in achievementRows)
        if (achievement.keyQuestId is { } questId)
        {
            if (!achievementIds.TryGetValue(questId, out var ids)) achievementIds[questId] = ids = [];
            ids.Add(achievement.id);
        }

        var maximumRoundtripError = 0d;
        object? DescribeLocation(Quest quest)
        {
            if (quest.IssuerLocation.RowId == 0) return null;
            var level = levels.GetRowOrDefault(quest.IssuerLocation.RowId);
            if (level is not { } issuerLevel || issuerLevel.Map.RowId == 0 || issuerLevel.Territory.RowId == 0) return null;
            var map = maps.GetRowOrDefault(issuerLevel.Map.RowId);
            if (map is not { } issuerMap || issuerMap.SizeFactor == 0) return null;
            if (!float.IsFinite(issuerLevel.X) || !float.IsFinite(issuerLevel.Y) || !float.IsFinite(issuerLevel.Z))
                throw new InvalidDataException($"Quest {quest.RowId} has non-finite issuer coordinates.");
            var displayX = WorldToDisplay(issuerLevel.X, issuerMap.OffsetX, issuerMap.SizeFactor);
            var displayY = WorldToDisplay(issuerLevel.Z, issuerMap.OffsetY, issuerMap.SizeFactor);
            var error = Math.Max(Math.Abs(DisplayToWorld(displayX, issuerMap.OffsetX, issuerMap.SizeFactor) - issuerLevel.X),
                Math.Abs(DisplayToWorld(displayY, issuerMap.OffsetY, issuerMap.SizeFactor) - issuerLevel.Z));
            if (!double.IsFinite(error) || error > 0.000001d)
                throw new InvalidDataException($"Quest {quest.RowId} fails map coordinate roundtrip verification.");
            maximumRoundtripError = Math.Max(maximumRoundtripError, error);
            var territory = territories.GetRowOrDefault(issuerLevel.Territory.RowId);
            return new
            {
                levelId = issuerLevel.RowId,
                mapId = issuerLevel.Map.RowId,
                territoryId = issuerLevel.Territory.RowId,
                x = (double)issuerLevel.X, y = (double)issuerLevel.Y, z = (double)issuerLevel.Z,
                displayX, displayY,
                mapX = Math.Floor(displayX * 10d) / 10d,
                mapY = Math.Floor(displayY * 10d) / 10d,
                mapTransform = new { sizeFactor = issuerMap.SizeFactor, offsetX = issuerMap.OffsetX, offsetY = issuerMap.OffsetY },
                mapNames = new { map = issuerMap.PlaceName.ValueNullable?.Name.ExtractText(), territory = territory?.PlaceName.ValueNullable?.Name.ExtractText() },
            };
        }

        object[] DescribeRewardItems(Quest quest)
        {
            var result = new List<object>();
            object DescribeItem(Item item, int? count, bool optional) => new
            {
                id = item.RowId, name = item.Name.ExtractText(), count, optional,
                category = item.ItemUICategory.ValueNullable?.Name.ExtractText(),
                description = item.Description.ExtractText(),
                flags = new[]
                {
                    item.IsUnique ? "isUnique" : null,
                    item.IsUntradable ? "isUntradable" : null,
                    item.IsIndisposable ? "isIndisposable" : null,
                }.Where(flag => flag is not null).ToArray(),
            };
            var fixedCounts = quest.ItemCountReward.ToArray();
            var optionalCounts = quest.OptionalItemCountReward.ToArray();
            var index = 0;
            foreach (var reference in quest.Reward)
            {
                if (reference.RowId != 0 && reference.Is<Item>())
                {
                    var item = reference.GetValueOrDefault<Item>();
                    if (item is { } rewardItem && !string.IsNullOrWhiteSpace(rewardItem.Name.ExtractText()))
                        result.Add(DescribeItem(rewardItem, index < fixedCounts.Length ? fixedCounts[index] : null, false));
                }
                index++;
            }
            index = 0;
            foreach (var reference in quest.OptionalItemReward)
            {
                var item = reference.RowId == 0 ? null : reference.ValueNullable;
                if (item is { } rewardItem && !string.IsNullOrWhiteSpace(rewardItem.Name.ExtractText()))
                    result.Add(DescribeItem(rewardItem, index < optionalCounts.Length ? optionalCounts[index] : null, true));
                index++;
            }
            return result.ToArray();
        }

        var rows = namedQuests.Select(quest =>
        {
            var npc = quest.IssuerStart.RowId != 0 && quest.IssuerStart.Is<ENpcResident>() ? npcs.GetRowOrDefault(quest.IssuerStart.RowId) : null;
            var classLevels = quest.ClassJobLevel.Where(level => level != 0).ToArray();
            var name = quest.Name.ExtractText();
            return new
            {
                id = quest.RowId, name, normalizedName = NormalizeName(name),
                npc = npc is { } issuer && !string.IsNullOrWhiteSpace(issuer.Singular.ExtractText()) ? new { id = issuer.RowId, name = issuer.Singular.ExtractText() } : null,
                minLevel = classLevels.Length > 0 ? (int?)classLevels.Min() : null,
                location = DescribeLocation(quest),
                previousQuestIds = quest.PreviousQuest.Select(previous => previous.RowId).Where(id => id != 0).Distinct().ToArray(),
                previousQuestJoin = quest.PreviousQuestJoin,
                nextQuestIds = nextIds.TryGetValue(quest.RowId, out var next) ? next.Order().ToArray() : [],
                festivalId = quest.Festival.RowId,
                festivalName = quest.Festival.RowId != 0 ? quest.Festival.ValueNullable?.Name.ExtractText() : null,
                journalGenreId = quest.JournalGenre.RowId,
                journalGenreName = quest.JournalGenre.RowId != 0 ? quest.JournalGenre.ValueNullable?.Name.ExtractText() : null,
                isRepeatable = quest.IsRepeatable,
                achievementIds = achievementIds.TryGetValue(quest.RowId, out var ids) ? ids.ToArray() : [],
                rewardItems = DescribeRewardItems(quest),
            };
        }).ToArray();
        var versionPath = Path.Combine(Directory.GetParent(gamePath)?.FullName ?? gamePath, "ffxivgame.ver");
        var indexDocument = new
        {
            schemaVersion = 1,
            verifiedAt = DateTimeOffset.UtcNow,
            gameVersion = File.Exists(versionPath) ? File.ReadAllText(versionPath).Trim() : null,
            language = data.Options.DefaultExcelLanguage.ToString(),
            luminaVersion = typeof(GameData).Assembly.GetName().Version?.ToString(),
            excelVersion = typeof(Quest).Assembly.GetName().Version?.ToString(),
            checksumMismatchPolicy = "fail",
            normalization = "NFKC/remove-whitespace/lowercase",
            coordinateFormula = "display = (41 / (SizeFactor / 100)) * (((world + offset) * (SizeFactor / 100) + 1024) / 2048) + 1",
            quests = rows,
            achievements = achievementRows,
        };
        var parent = Path.GetDirectoryName(output);
        if (parent is not null) Directory.CreateDirectory(parent);
        var json = JsonSerializer.Serialize(indexDocument, new JsonSerializerOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
        var temporary = output + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            File.WriteAllText(temporary, json + "\n", new UTF8Encoding(false));
            File.Move(temporary, output, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
        return new
        {
            questCount = rows.Length,
            uniqueNormalizedNameCount = rows.Select(row => row.normalizedName).Distinct(StringComparer.Ordinal).Count(),
            ambiguousNormalizedNameCount = rows.GroupBy(row => row.normalizedName, StringComparer.Ordinal).Count(group => group.Count() > 1),
            questWithFestivalCount = rows.Count(row => row.festivalId != 0),
            questWithoutFestivalCount = rows.Count(row => row.festivalId == 0),
            locationCount = rows.Count(row => row.location is not null),
            achievementCount = achievementRows.Length,
            maximumRoundtripError,
            bytes = new FileInfo(output).Length,
        };
    }

    private static string NormalizeName(string name) => string.Concat(name.Normalize(NormalizationForm.FormKC).Where(character => !char.IsWhiteSpace(character))).ToLowerInvariant();

    private static double WorldToDisplay(double world, int offset, ushort sizeFactor)
    {
        var scale = sizeFactor / 100d;
        return 41d / scale * ((world + offset) * scale + 1024d) / 2048d + 1d;
    }

    private static double DisplayToWorld(double display, int offset, ushort sizeFactor) => (display - 1d) * 2048d / 41d - 1024d / (sizeFactor / 100d) - offset;
}

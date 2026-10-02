using System.Text.Json.Nodes;
using SeasonalEvent;

var root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
var v1Path = Path.Combine(root, "data/seasonal-event/events.json");
var v2Path = Path.Combine(root, "data/seasonal-event/events-v2.json");
var checks = 0;
void Accept(string json) { EventDataValidation.DeserializeAndValidate(json); checks++; }
void Reject(JsonObject value)
{
    try { EventDataValidation.DeserializeAndValidate(value.ToJsonString()); }
    catch (Exception ex) when (ex is System.Text.Json.JsonException or InvalidDataException) { checks++; return; }
    throw new Exception("Invalid data was accepted: " + value.ToJsonString());
}
var original = JsonNode.Parse(File.ReadAllText(v1Path))!.AsObject();
Accept(original.ToJsonString());
Accept(File.ReadAllText(v2Path));
JsonObject Partial()
{
    var value = (JsonObject)original.DeepClone();
    value["schemaVersion"] = 2;
    var item = value["events"]![0]!.AsObject();
    item["questName"] = null; item["questNpc"] = null; item["location"] = null; item["rewards"] = new JsonArray();
    return value;
}
Accept(Partial().ToJsonString());
foreach (var field in new[] { "questName", "questNpc", "location" })
{
    var missing = Partial(); missing["events"]![0]!.AsObject().Remove(field); Accept(missing.ToJsonString());
}
var strictPartial = Partial(); strictPartial["schemaVersion"] = 1; Reject(strictPartial);
foreach (var field in new[] { "title", "questName", "questNpc" })
{
    var bad = Partial(); bad["events"]![0]![field] = " "; Reject(bad);
}
foreach (var field in new[] { "startAt", "endAt", "lastVerifiedAt" })
{
    foreach (var invalid in new[] { "2026-09-30T12:00:00", "not-a-date" })
    { var bad = Partial(); bad["events"]![0]![field] = invalid; Reject(bad); }
}
var backwards = Partial(); backwards["events"]![0]!["endAt"] = "2020-01-01T00:00:00Z"; Reject(backwards);
foreach (var field in new[] { "questId", "achievementId", "questLevel" })
{ var bad = Partial(); bad["events"]![0]![field] = 0; Reject(bad); }
foreach (var field in new[] { "x", "y", "z" })
{
    var bad = (JsonObject)original.DeepClone(); bad["events"]![0]!["location"]!.AsObject().Remove(field); Reject(bad);
    var range = (JsonObject)original.DeepClone(); range["events"]![0]!["location"]![field] = 100001; Reject(range);
}
var badLocation = Partial(); badLocation["events"]![0]!["location"] = new JsonObject { ["territoryId"] = 0, ["mapId"] = 1, ["x"] = 0, ["y"] = 0, ["z"] = 0 }; Reject(badLocation);
var badReward = Partial(); badReward["events"]![0]!["rewards"] = new JsonArray(new JsonObject { ["name"] = "", ["category"] = "", ["description"] = "", ["flags"] = new JsonArray() }); Reject(badReward);
var badUrl = Partial(); badUrl["events"]![0]!["sourceUrl"] = "javascript:alert(1)"; Reject(badUrl);
var duplicate = Partial(); duplicate["events"]!.AsArray().Add(duplicate["events"]![0]!.DeepClone()); Reject(duplicate);
var unsupported = Partial(); unsupported["schemaVersion"] = 99; Reject(unsupported);
var alert = Partial(); alert["collectionStatus"] = new JsonObject { ["status"] = "alert", ["code"] = "candidate_collection_failed", ["unavailableSources"] = new JsonArray("https://actff1.web.sdo.com/project/unavailable/") }; Accept(alert.ToJsonString());
var badStatus = (JsonObject)alert.DeepClone(); badStatus["collectionStatus"]!["status"] = "success"; Reject(badStatus);
foreach (var field in new[] { "questId", "achievementId" })
{
    var valid = Partial(); valid["events"]![0]![field] = 4294967295L; Accept(valid.ToJsonString());
    var invalid = Partial(); invalid["events"]![0]![field] = 4294967296L; Reject(invalid);
}
var levelOverflow = Partial(); levelOverflow["events"]![0]!["questLevel"] = 2147483648L; Reject(levelOverflow);
var versionOverflow = Partial(); versionOverflow["dataVersion"] = 2147483648L; Reject(versionOverflow);
Console.WriteLine($"Client data validation: {checks} checks passed without Dalamud or a running game.");

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
JsonObject WithPending()
{
    var value = Partial();
    var pending = (JsonObject)value["events"]![0]!.DeepClone();
    pending["id"] = "pending-open-ended";
    pending.Remove("endAt");
    pending["endCondition"] = "8.0版本维护前，具体结束日期尚未公布";
    value["pendingEvents"] = new JsonArray(pending);
    value["collectionStatus"] = new JsonObject { ["status"] = "alert", ["code"] = "candidate_review_required" };
    return value;
}
Accept(WithPending().ToJsonString());
var silentPending = WithPending(); silentPending.Remove("collectionStatus"); Reject(silentPending);
var healthyPending = WithPending(); healthyPending["collectionStatus"] = new JsonObject { ["status"] = "ok", ["code"] = "healthy" }; Reject(healthyPending);
var pendingOnly = WithPending(); pendingOnly["events"] = new JsonArray(); Accept(pendingOnly.ToJsonString());
var emptyPending = Partial(); emptyPending["pendingEvents"] = new JsonArray(); Accept(emptyPending.ToJsonString());
foreach (var content in new JsonNode?[] { new JsonArray(), null })
{
    var legacyPending = (JsonObject)original.DeepClone(); legacyPending["pendingEvents"] = content; Reject(legacyPending);
}
var nullPending = Partial(); nullPending["pendingEvents"] = null; Reject(nullPending);
var nonArrayPending = Partial(); nonArrayPending["pendingEvents"] = "invalid"; Reject(nonArrayPending);
var nullPendingItem = Partial(); nullPendingItem["pendingEvents"] = new JsonArray((JsonNode?)null); Reject(nullPendingItem);
foreach (var condition in new string?[] { null, "", "  ", new string('长', 121) })
{
    var bad = WithPending(); bad["pendingEvents"]![0]!["endCondition"] = condition; Reject(bad);
}
var missingCondition = WithPending(); missingCondition["pendingEvents"]![0]!.AsObject().Remove("endCondition"); Reject(missingCondition);
var longestCondition = WithPending(); longestCondition["pendingEvents"]![0]!["endCondition"] = new string('长', 120); Accept(longestCondition.ToJsonString());
foreach (var end in new JsonNode?[] { JsonValue.Create("2026-12-31T23:00:00+08:00"), null })
{
    var bad = WithPending(); bad["pendingEvents"]![0]!["endAt"] = end; Reject(bad);
}
foreach (var field in new[] { "title", "startAt", "sourceUrl", "lastVerifiedAt", "rewards" })
{
    var bad = WithPending(); bad["pendingEvents"]![0]!.AsObject().Remove(field); Reject(bad);
}
var pendingTimeWithoutOffset = WithPending(); pendingTimeWithoutOffset["pendingEvents"]![0]!["startAt"] = "2026-10-25T15:00:00"; Reject(pendingTimeWithoutOffset);
var badPendingMap = WithPending(); badPendingMap["pendingEvents"]![0]!["location"] = new JsonObject { ["territoryId"] = 144, ["mapId"] = 0, ["x"] = 0, ["y"] = 0, ["z"] = 0 }; Reject(badPendingMap);
var crossListDuplicate = WithPending(); crossListDuplicate["pendingEvents"]![0]!["id"] = crossListDuplicate["events"]![0]!["id"]!.DeepClone(); Reject(crossListDuplicate);
var pendingDuplicate = WithPending(); pendingDuplicate["pendingEvents"]!.AsArray().Add(pendingDuplicate["pendingEvents"]![0]!.DeepClone()); Reject(pendingDuplicate);
var regularMissingEnd = WithPending(); regularMissingEnd["events"]![0]!.AsObject().Remove("endAt"); Reject(regularMissingEnd);

void Check(bool result, string message)
{
    if (!result) throw new Exception(message);
    checks++;
}
var parsedPending = EventDataValidation.DeserializeAndValidate(WithPending().ToJsonString());
var cachedJson = System.Text.Json.JsonSerializer.Serialize(parsedPending, EventDataValidation.CreateJsonOptions());
var restored = EventDataValidation.DeserializeAndValidate(cachedJson);
Check(restored.PendingEvents is { Count: 1 } && restored.PendingEvents[0].EndCondition == parsedPending.PendingEvents![0].EndCondition,
    "Cache roundtrip must preserve unknown deadline text.");
Check(!JsonNode.Parse(cachedJson)!["pendingEvents"]![0]!.AsObject().ContainsKey("endAt"), "Cache must not invent a pending endAt.");
var legacyJson = System.Text.Json.JsonSerializer.Serialize(EventDataValidation.DeserializeAndValidate(original.ToJsonString()), EventDataValidation.CreateJsonOptions());
Check(!JsonNode.Parse(legacyJson)!.AsObject().ContainsKey("pendingEvents"), "Old schema cache must omit absent pendingEvents.");
Accept(legacyJson);
var now = new DateTimeOffset(2026, 10, 25, 0, 0, 0, TimeSpan.Zero);
var policyItem = restored.PendingEvents![0];
policyItem.StartAt = now.AddDays(-1);
policyItem.LastVerifiedAt = now.AddHours(-1);
Check(PendingEventPolicy.CanAutoRemind(policyItem, now), "A started, recently verified pending item can remind.");
policyItem.LastVerifiedAt = now.AddHours(-24);
Check(PendingEventPolicy.CanAutoRemind(policyItem, now), "Exactly 24 hours is still within the verification window.");
policyItem.LastVerifiedAt = now.AddHours(-24).AddTicks(-1);
Check(!PendingEventPolicy.CanAutoRemind(policyItem, now), "Old cache must stop automatic pending reminders.");
policyItem.LastVerifiedAt = now.AddTicks(1);
Check(!PendingEventPolicy.CanAutoRemind(policyItem, now), "A future verification timestamp cannot prove freshness.");
policyItem.LastVerifiedAt = null;
Check(!PendingEventPolicy.CanAutoRemind(policyItem, now), "Missing verification cannot allow a reminder.");
policyItem.LastVerifiedAt = now;
policyItem.StartAt = now.AddTicks(1);
Check(PendingEventPolicy.IsFresh(policyItem, now) && !PendingEventPolicy.CanAutoRemind(policyItem, now),
    "A future start remains manually viewable but cannot remind early.");
policyItem.StartAt = now;
Check(PendingEventPolicy.CanAutoRemind(policyItem, now), "The verified start boundary allows a reminder.");
policyItem.LastVerifiedAt = now.AddDays(-10);
var staleCache = EventDataValidation.DeserializeAndValidate(System.Text.Json.JsonSerializer.Serialize(restored, EventDataValidation.CreateJsonOptions()));
Check(!PendingEventPolicy.CanAutoRemind(staleCache.PendingEvents![0], now), "Reading cached data must not refresh its verification time.");
Console.WriteLine($"Client data validation: {checks} checks passed without Dalamud or a running game.");

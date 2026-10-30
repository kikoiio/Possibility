local directory = debug.getinfo(1, "S").source:match("^@(.*/)") or "./"
local memory = dofile(directory .. "long_term_memory.lua")
local runtime = dofile(directory .. "reflection_runtime.lua")

local function equal(a, b)
  if type(a) ~= type(b) then return false end
  if type(a) ~= "table" then return a == b end
  for key, value in pairs(a) do if not equal(value, b[key]) then return false end end
  for key in pairs(b) do if a[key] == nil then return false end end
  return true
end

local function rejected(store, fn)
  local before = store:export()
  assert(not pcall(fn), "expected rejection")
  assert(equal(before, store:export()), "rejection mutated durable memory")
end

local function append(store, id, owner, classification, content)
  return store:append({layer="L1", id=id, owner=owner, time=3,
    text=content or "I remember the well", classification=classification or "experience",
    source={kind="observation", id="world-observation:" .. id, revision=2}})
end

local owner, other = "0", "1"
local store = memory.new()
assert(runtime.request(store, owner, "world-1", "alice", "the well") == nil)
assert(#runtime.beliefs(store, owner) == 0)
append(store, "genesis-seed", owner, "unknown")
append(store, "fact", owner, "fact")
append(store, "prior-belief", owner, "belief")
append(store, "bob-private", other)
assert(runtime.request(store, owner, "world-1", "alice", "the well") == nil)
store:record_outcome(owner, "inspect", true, "observed", 4, nil, nil, "the well", "world-event:7")
append(store, "heard-rumor", owner, "rumor")
local original = store:export()
local request = runtime.request(store, owner, "world-1", "alice", "the well")
assert(equal(original, store:export()), "request wrote to store")
assert(request.schema == "wispiva.reflection-input" and request.version == 1)
assert(equal(request.request, {world_id="world-1", actor_id="alice", topic="the well"}))
assert(#request.experiences == 2)
local rumor, experience = request.experiences[1], request.experiences[2]
assert(rumor.id == "heard-rumor" and rumor.captured_at == 3 and rumor.source.revision == 2)
assert(experience.id == "world-event:7:actor" and experience.source.id == "world-event:7")
assert(experience.source.kind == "event" and experience.captured_at == 4)
assert(equal(rumor.audience, {"alice"}) and equal(experience.audience, {"alice"}))
rumor.source.id, rumor.audience[1], rumor.text = "tampered", "bob", "tampered"
assert(equal(original, store:export()), "request was not detached")
request = runtime.request(store, owner, "world-1", "alice", "the well")

local function proposal(ids, topic)
  return {topic=topic or "the well", text="I should revisit the well", source_ids=ids}
end
for _, value in ipairs({proposal({}), proposal({""}), proposal({"heard-rumor", "heard-rumor"}),
    proposal({"bob-private"}), proposal({"missing"}), proposal({"heard-rumor"}, "other"),
    {topic="the well", text="", source_ids={"heard-rumor"}},
    {topic="the well", text="x", source_ids={"heard-rumor"}, extra=true},
    proposal({[2]="heard-rumor"}), proposal({"heard-rumor", false}),
    proposal({"heard-rumor", "missing"})}) do
  rejected(store, function() runtime.apply(store, owner, request, value, 5, "provider") end)
end
-- A real durable L1 appended after selection is still not an authorized citation.
append(store, "valid-but-not-selected", owner)
rejected(store, function()
  runtime.apply(store, owner, request, proposal({"valid-but-not-selected"}), 5, "provider")
end)
-- Even a forged selected list cannot override store:reflect's owner check.
local forged = runtime.request(store, other, "world-1", "bob", "the well")
rejected(store, function() runtime.apply(store, owner, forged, proposal({"bob-private"}), 5) end)
rejected(store, function() runtime.apply(store, other, request, proposal({"heard-rumor"}), 5) end)
for _, time in ipairs({0/0, math.huge, -math.huge, "5"}) do
  rejected(store, function() runtime.apply(store, owner, request, proposal({"heard-rumor"}), time) end)
end
rejected(store, function() runtime.apply(store, owner, request, proposal({"heard-rumor"}), 5, "") end)

local accepted = proposal({"heard-rumor", "world-event:7:actor"})
local saved = runtime.apply(store, owner, request, accepted, 5, "provider-1")
assert(saved.layer == "L2" and saved.owner == owner and saved.version == 1)
assert(saved.source.kind == "reflection" and saved.source.id == "provider-1")
assert(equal(saved.experiences, {"heard-rumor", "world-event:7:actor"}))
accepted.source_ids[1], accepted.text, accepted.topic = "missing", "tampered", "tampered"
saved.experiences[1], saved.source.id = "missing", "tampered"
local restored = memory.load(store:export())
local first = runtime.beliefs(restored, owner)[1]
assert(first.version == 1 and first.experiences[1] == "heard-rumor" and first.source.id == "provider-1")
assert(first.text == "I should revisit the well" and first.topic == "the well")
local second = runtime.apply(restored, owner, request, proposal({"heard-rumor"}), 6, "provider-2")
assert(second.version == 2 and second.id == "reflection:0:the well:2")
local latest = runtime.beliefs(restored, owner)
assert(#latest == 1 and latest[1].version == 2 and latest[1].id == second.id)
latest[1].experiences[1], latest[1].audience[1], latest[1].source.id = "bad", other, "bad"
assert(runtime.beliefs(restored, owner)[1].experiences[1] == "heard-rumor")
assert(runtime.beliefs(restored, owner)[1].audience[1] == owner)
assert(runtime.beliefs(restored, owner)[1].source.id == "provider-2")
assert(#runtime.beliefs(restored, other) == 0)
restored:reflect(other, "the well", {"bob-private"}, "Bob's private interpretation", 7, "provider")
assert(#runtime.beliefs(restored, owner) == 1)
assert(runtime.beliefs(restored, other)[1].owner == other)

-- Recent FIFO L1 entries must not consume the separate L2 context selection.
for i = 1, 12 do append(restored, "recent-" .. i, owner) end
assert(#runtime.request(restored, owner, "world-1", "alice", "the well").experiences == 8)
assert(runtime.beliefs(restored, owner)[1].version == 2)
for i = 1, 5 do restored:reflect(owner, "topic-" .. i, {"heard-rumor"}, "belief " .. i, 8+i) end
latest = runtime.beliefs(restored, owner)
assert(#latest == 4 and latest[1].topic == "topic-5" and latest[4].topic == "topic-2")

-- Budget and scan bounds are supplied to the actual store, not a FIFO helper.
local calls = {}
local instrumented = {retrieve=function(_, id, options)
  calls[#calls + 1] = {owner=id, options=options}
  return restored:retrieve(id, options)
end}
runtime.request(instrumented, owner, "world-1", "alice", "the well")
runtime.beliefs(instrumented, owner)
assert(calls[1].owner == owner and calls[1].options.max_scan == 128)
assert(calls[1].options.max_entries == 128 and calls[1].options.max_bytes == 10000)
assert(calls[2].owner == owner and calls[2].options.max_scan == 128)
assert(calls[2].options.max_entries == 128 and calls[2].options.max_bytes == 32768)

local budget = memory.new()
append(budget, "l1", owner)
budget:reflect(owner, "small", {"l1"}, string.rep("s", 100), 1)
budget:reflect(owner, "large", {"l1"}, "old version", 2)
budget:reflect(owner, "large", {"l1"}, string.rep("x", 3500), 3)
budget:reflect(owner, "newest", {"l1"}, string.rep("n", 1000), 4)
latest = runtime.beliefs(budget, owner)
assert(#latest == 2 and latest[1].topic == "newest" and latest[2].topic == "small")
local total = 0
for _, row in ipairs(latest) do total = total + #row.text end
assert(total <= 4096)

local scanned = memory.new()
append(scanned, "too-old", owner)
for i = 1, 128 do append(scanned, "unknown-" .. i, owner, "unknown") end
assert(runtime.request(scanned, owner, "world-1", "alice", "the well") == nil)
local oversized = memory.new()
append(oversized, "small", owner)
append(oversized, "too-big", owner, "experience", string.rep("x", 12000))
local bounded = runtime.request(oversized, owner, "world-1", "alice", "the well")
assert(#bounded.experiences == 1 and bounded.experiences[1].id == "small")

-- Defend privacy even if a retrieval adapter returns rows for the wrong owner
-- or omits the authenticated owner from an otherwise eligible audience.
local raw = store:export().records
local leaked = append(memory.new(), "leaked", other)
local hidden = append(memory.new(), "hidden", owner)
hidden.audience = {other}
local adversarial = {retrieve=function() return {leaked, hidden, raw[#raw]} end}
assert(runtime.request(adversarial, owner, "world-1", "alice", "the well") == nil)
local bad_belief = runtime.beliefs(restored, other)[1]
local hidden_belief = runtime.beliefs(restored, owner)[1]
hidden_belief.audience = {other}
assert(#runtime.beliefs({retrieve=function() return {bad_belief, hidden_belief} end}, owner) == 0)

print("reflection runtime tests passed")

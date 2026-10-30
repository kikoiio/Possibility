local directory = (... and (...):match("(.*/)")) or "./"
local memory = dofile(directory .. "long_term_memory.lua")
local apply = dofile(directory .. "reflection_apply.lua")

local store = memory.new()
store:append({layer="L0", id="event-1", owner="world", time=1, text="well event",
  source={kind="action", id="alice"}})
store:append({layer="L1", id="alice-1", owner="alice", time=1, text="I saw the well",
  classification="experience", source={kind="event", id="event-1"}})

local record = apply.apply(store, "alice", {topic="the well", text="I should revisit it",
  source_ids={"alice-1"}}, 2, "provider-1")
assert(record.layer == "L2" and record.owner == "alice" and record.version == 1)
assert(record.experiences[1] == "alice-1")

local function rejected(fn)
  local ok = pcall(fn)
  assert(not ok)
end

rejected(function() apply.apply(store, "alice", {topic="x", text="x", source_ids={}}, 3) end)
rejected(function() apply.apply(store, "alice", {topic="x", text="x", source_ids={"alice-1", "alice-1"}}, 3) end)
rejected(function() apply.apply(store, "alice", {topic="x", text="x", source_ids={"missing"}}, 3) end)
rejected(function() apply.apply(store, "alice", {topic="x", text="x", source_ids={"alice-1"}, extra=true}, 3) end)

print("reflection apply tests passed")

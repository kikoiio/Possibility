local directory = arg[1] or "."
local product_state = dofile(directory .. "/product_state.lua")
local function fails(fn, text)
  local ok, err = pcall(fn)
  assert(not ok and tostring(err):find(text, 1, true), tostring(err))
end
local target = {map=1, actors=1, inventory=1, events=2, memory=2, environment=1}
local state = product_state.new("11111111-1111-1111-1111-111111111111", "genesis:created")
state:prepare("checkpoint:1", target)
fails(function() state:assert_ready() end, "not ready")
fails(function() state:commit("wrong", target) end, "pending")
state:commit("checkpoint:1", target)
assert(state:phase() == "READY" and state:version() == 1)
assert(state:commit("checkpoint:1", target).commit_version == 1)
assert(state:prepare("checkpoint:1", target).commit_version == 1)
fails(function() state:commit("checkpoint:1", {map=2, actors=1, inventory=1, events=2, memory=2, environment=1}) end, "conflict")
fails(function() state:prepare("checkpoint:regress", {map=0, actors=1, inventory=1, events=2, memory=2, environment=1}) end, "regress")
local recovered = product_state.load(state:export())
assert(recovered:components().events == 2)
recovered:set_clock({version=1, logical_time=7, engine_time=9, saved_wall_time=11})
assert(recovered:clock().logical_time == 7)
recovered:prepare("checkpoint:2", target)
local interrupted = product_state.load(recovered:export())
fails(function() interrupted:assert_ready() end, "not ready")
interrupted:freeze("recovery required")
fails(function() interrupted:assert_ready() end, "not ready")
assert(interrupted:pending().operation_id == "checkpoint:2")
assert(product_state.load(interrupted:export()):pending().operation_id == "checkpoint:2")
fails(function() interrupted:freeze("different reason") end, "reason mismatch")

local function equal(a, b)
  assert(type(a) == type(b), "type differs")
  if type(a) ~= "table" then assert(a == b, "value differs"); return end
  for key, value in pairs(a) do equal(value, b[key]) end
  for key in pairs(b) do assert(a[key] ~= nil, "extra field") end
end
local legacy = {version=1, logical_time=7, engine_time=9, saved_wall_time=11}
local clocks = product_state.new("clock-world", "clock-origin")
clocks:set_clock(legacy)
equal(clocks:clock(), legacy)
equal(product_state.load(clocks:export()):clock(), legacy)
-- Every extension is independently optional, including false and zero values.
for _, extra in ipairs({{fraction=0}, {fraction=0.75}, {rate=0}, {rate=1000},
    {rate=0.5}, {paused=false}, {paused=true}, {fraction=0.25, rate=24, paused=true}}) do
  local next_clock = {}
  for key, value in pairs(legacy) do next_clock[key] = value end
  for key, value in pairs(extra) do next_clock[key] = value end
  clocks:set_clock(next_clock)
  equal(clocks:clock(), next_clock)
  equal(product_state.load(clocks:export()):clock(), next_clock)
  local exported = clocks:clock()
  exported.fraction, exported.rate, exported.paused = 0.9, 999, false
  equal(clocks:clock(), next_clock)
  local restored = product_state.load(clocks:export())
  next_clock.logical_time = 99
  assert(restored:clock().logical_time == 7)
end
local valid = clocks:export()
local invalid = {
  fraction={-1, 1, 0/0, math.huge, -math.huge, false, "0.5", {}},
  rate={-1, 1000.01, 0/0, math.huge, -math.huge, false, "24", {}},
  paused={0, 1, "false", {}},
}
for field, values in pairs(invalid) do
  for _, value in ipairs(values) do
    local bad = {}
    for key, item in pairs(legacy) do bad[key] = item end
    bad[field] = value
    fails(function() clocks:set_clock(bad) end, "invalid clock " .. field)
    equal(clocks:export(), valid)
    local snapshot = clocks:export()
    snapshot.clock = bad
    fails(function() product_state.load(snapshot) end, "invalid clock " .. field)
    assert(snapshot.clock[field] == value or value ~= value)
  end
end
-- Replacing an extended clock with a legacy clock removes the optional fields.
clocks:set_clock(legacy)
equal(clocks:clock(), legacy)
clocks:set_clock(nil)
assert(clocks:clock() == nil and product_state.load(clocks:export()):clock() == nil)
fails(function() interrupted:set_clock(legacy) end, "frozen")
print("product state tests passed")

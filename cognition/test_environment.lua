local directory = (arg[0] or ""):match("^(.*[/\\])") or ""
local environment = dofile(directory .. "environment.lua")

local function new(rate, amount)
  return environment.new({id = "grove", resource = "wood", capacity = 10,
    amount = amount or 2, rate = rate or 2, time = 0})
end

local function equal(a, b)
  for key, value in pairs(a) do assert(b[key] == value, key .. " differs") end
  for key, value in pairs(b) do assert(a[key] == value, key .. " differs") end
end

local p = new()
assert(#p:advance(0) == 0)
local events = p:advance(2)
assert(#events == 1)
local e = events[1]
assert(e.kind == "resource_regenerated" and e.resource == "wood")
assert(e.before == 2 and e.after == 6 and e.delta == 4 and e.rate == 2)
assert(e.from_time == 0 and e.time == 2 and e.ok and e.reason == "logical_time")
assert(e.actor == "environment:grove" and e.operation_id == "environment:grove:1")
local saved = p:export()
assert(#p:advance(2) == 0)
equal(saved, p:export())
e.after = 99
assert(p:export().amount == 6) -- Returned events cannot mutate the process.

-- A condition boundary settles elapsed time with the old rate.
e = p:set_conditions(3, {rate = -3})[1]
assert(e.before == 6 and e.after == 8 and e.rate == 2)
local boundary = p:export()
assert(#p:set_conditions(3, {rate = -3}) == 0)
equal(boundary, p:export())
e = p:advance(5)[1]
assert(e.kind == "resource_depleted" and e.before == 8 and e.after == 2)
assert(e.delta == -6 and e.rate == -3 and e.from_time == 3)
assert(p:advance(100)[1].after == 0)
assert(#p:advance(101) == 0)
assert(p:export().time == 101)
p:set_conditions(101, {rate = 0})
assert(#p:advance(200) == 0 and p:export().amount == 0)
p:set_conditions(200, {rate = 4})
assert(p:advance(203)[1].after == 10)
assert(#p:advance(204) == 0) -- No accumulated surplus at capacity.
p:set_conditions(204, {rate = -1})
assert(p:advance(205)[1].after == 9)

-- Restoring persists the cursor, conditions and operation sequence.
saved = p:export()
for key, value in pairs(saved) do
  assert(type(key) == "string")
  assert(type(value) == "string" or (type(value) == "number"
    and value == value and math.abs(value) < math.huge))
end
local restored = environment.load(saved)
equal(saved, restored:export())
saved.amount, saved.rate, saved.time = 0, 0, 0
assert(restored:export().amount == 9 and restored:export().time == 205)
assert(#restored:advance(205) == 0)
local original_event, restored_event = p:advance(206)[1], restored:advance(206)[1]
equal(original_event, restored_event)
assert(restored_event.after == 8)
assert(#environment.load(restored:export()):advance(206) == 0)

-- Invalid changes and time reversal must not partially advance state.
local before = restored:export()
for _, time in ipairs({205, -1, 1.5, math.huge, 0/0, 2147483648}) do
  assert(not pcall(function() restored:advance(time) end))
  equal(before, restored:export())
end
for _, conditions in ipairs({{rate = 0/0}, {rate = math.huge}, {rate = 1.5},
    {rate = 1, extra = true}, {}, false}) do
  assert(not pcall(function() restored:set_conditions(207, conditions) end))
  equal(before, restored:export())
end
assert(not pcall(function() restored:set_conditions(205, {rate = 2}) end))
equal(before, restored:export())

-- Invalid snapshots fail closed, without modifying the source snapshot.
for _, field in ipairs({"version", "id", "resource", "capacity", "amount",
    "rate", "time", "sequence"}) do
  local bad = restored:export()
  bad[field] = false
  assert(not pcall(environment.load, bad), field)
end
local bad = restored:export()
bad.amount = bad.capacity + 1
assert(not pcall(environment.load, bad))
bad = restored:export(); bad.sequence = 2147483647
local exhausted = environment.load(bad)
assert(not pcall(function() exhausted:advance(207) end))
equal(bad, exhausted:export())

-- Segmented advancement yields the same amount as a single time jump.
local one, many = new(3), new(3)
one:advance(9)
for time = 1, 9 do many:advance(time) end
assert(one:export().amount == many:export().amount)
local large = new(2147483647, 0)
assert(large:advance(2147483647)[1].after == 10)
local empty = environment.new({id = "empty", resource = "wood", capacity = 0,
  amount = 0, rate = 1, time = 0})
assert(#empty:advance(10) == 0)

print("environment tests passed")

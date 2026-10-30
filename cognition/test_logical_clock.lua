local directory = (arg[0] or ""):match("^(.*[/\\])") or ""
local logical_clock = dofile(directory .. "logical_clock.lua")

local function equal(left, right)
  for key, value in pairs(left) do assert(right[key] == value, key .. " differs") end
  for key, value in pairs(right) do assert(left[key] == value, key .. " differs") end
end

local function rejects_without_change(clock, fn)
  local before = clock:export()
  assert(not pcall(fn), "invalid call accepted")
  equal(before, clock:export())
end

local clock = logical_clock.new()
equal(clock:export(), {version=1, logical_time=0, fraction=0, rate=24, paused=false})
assert(clock:advance(1) == 24)
clock:set_rate(0.5)
local time, fraction = clock:advance(0.5, false)
assert(time == 24 and fraction == 0.25)
time, fraction = clock:advance(1.5)
assert(time == 25 and fraction == 0)
clock:advance(0.5)

-- Waiting and pausing discard elapsed intervals, preserving existing sub-ticks.
local waiting = clock:export()
for _ = 1, 3 do clock:advance(60, true) end
equal(waiting, clock:export())
clock:pause()
clock:pause() -- Idempotent controls do not accrue time.
local paused = clock:export()
clock:advance(60)
equal(paused, clock:export())
local restored = logical_clock.load(paused)
equal(paused, restored:export())
restored:advance(60, false)
equal(paused, restored:export())
restored:resume()
restored:resume()
time, fraction = restored:advance(0.5)
assert(time == 25 and fraction == 0.5) -- No paused or blocked backlog.

-- Zero rate is a valid stop and does not accumulate deferred time.
restored:set_rate(0)
local stopped = restored:export()
restored:advance(60)
equal(stopped, restored:export())
restored:set_rate(1000)
assert(restored:advance(60) == 60025)
assert(restored:export().fraction == 0.5)
equal(restored:export(), logical_clock.load(restored:export()):export())

-- Load/export never alias caller state; loading does not consult wall time.
local saved = restored:export()
local copy = logical_clock.load(saved)
saved.logical_time, saved.fraction, saved.rate, saved.paused = 0, 0, 0, true
assert(copy:export().logical_time == 60025 and copy:export().fraction == 0.5)
assert(copy:export().rate == 1000 and not copy:export().paused)
equal(copy:export(), restored:export())
copy:advance(0)
equal(copy:export(), restored:export())

local invalid_numbers = {-1, 0/0, math.huge, -math.huge, "1", false, {}}
for _, value in ipairs(invalid_numbers) do
  rejects_without_change(copy, function() copy:advance(value) end)
  rejects_without_change(copy, function() copy:set_rate(value) end)
end
rejects_without_change(copy, function() copy:advance(nil) end)
rejects_without_change(copy, function() copy:set_rate(nil) end)
rejects_without_change(copy, function() copy:advance(60.001) end)
rejects_without_change(copy, function() copy:set_rate(1000.001) end)
for _, value in ipairs({0, 1, "false", {}}) do
  rejects_without_change(copy, function() copy:advance(1, value) end)
end
copy:pause()
rejects_without_change(copy, function() copy:advance(61, true) end)

-- Missing, extra, malformed and unknown-version snapshots are rejected.
for _, field in ipairs({"version", "logical_time", "fraction", "rate", "paused"}) do
  local bad = copy:export()
  bad[field] = nil
  assert(not pcall(logical_clock.load, bad), field)
end
for _, fields in ipairs({{version=2}, {logical_time=0.5}, {logical_time=-1},
    {logical_time=2147483648}, {fraction=1}, {fraction=-0.1}, {fraction=0/0},
    {rate=math.huge}, {rate=1001}, {paused=0}, {extra=true}}) do
  local bad = copy:export()
  for key, value in pairs(fields) do bad[key] = value end
  assert(not pcall(logical_clock.load, bad))
end
assert(not pcall(logical_clock.load, nil))
assert(not pcall(logical_clock.new, false))
for _, options in ipairs({{rate=false}, {rate=1001}, {paused=0},
    {fraction=1}, {logical_time=-1}, {version=1}}) do
  assert(not pcall(logical_clock.new, options))
end

-- Overflow rejects the entire update, including its fractional component.
local end_clock = logical_clock.new({logical_time=2147483647, fraction=0.5, rate=1})
rejects_without_change(end_clock, function() end_clock:advance(1) end)
assert(end_clock:advance(1, true) == 2147483647)

-- Binary-exact substeps and one interval yield the same state.
local one, many = logical_clock.new({rate=1.5}), logical_clock.new({rate=1.5})
one:advance(2)
for _ = 1, 8 do many:advance(0.25) end
equal(one:export(), many:export())

print("logical clock tests passed")

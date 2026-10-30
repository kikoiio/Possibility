-- Run from this directory with lua5.1 test_spatial.lua.
local spatial = dofile("spatial.lua")

local function pos(x, y, z) return {x = x, y = y or 0, z = z or 0} end
local function equal(actual, expected)
  assert(#actual == #expected, "object count differs: " .. #actual .. " ~= " .. #expected)
  for i, object in ipairs(expected) do assert(actual[i] == object, "object/order differs at " .. i) end
end
local function rejects(fn, ...) assert(not pcall(fn, ...), "invalid input accepted") end

local index = spatial.new(4)
equal(index:query(pos(0), 0), {})
local self_object, near, boundary, corner, below = {}, {}, {}, {}, {}
index:upsert(10, boundary, pos(3, 4))
index:upsert(2, near, pos(-4))
index:upsert(20, corner, pos(4, 4, 4))
index:upsert(1, self_object, pos(0))
index:upsert(-2, below, pos(0, -5))
equal(index:query(pos(0), 5), {below, self_object, near, boundary})
equal(index:query(pos(0), 0), {self_object}) -- The observer owns self filtering.
equal(index:query(pos(0), 4.999), {self_object, near})
equal(index:query(pos(-4), 0), {near})
equal(index:query(pos(4, 4, 4), 0), {corner})
local detached = index:query(pos(0), 5)
detached[1] = nil
equal(index:query(pos(0), 5), {below, self_object, near, boundary})

-- Positions are snapshots; objects are the exact original references, never projections.
local current = pos(-0.1, -4, -8)
local entity = {_id = 900, _memory = {secret = "private"}}
local object = {
  get_pos = function() return current end,
  get_luaentity = function() return entity end,
}
index:upsert(3, object, current)
local found = index:query(current, 0)
equal(found, {object})
assert(found[1]:get_luaentity() == entity and found[1]:get_pos() == current)
current.x = -0.2
equal(index:query(pos(-0.1, -4, -8), 0), {object})
index:upsert(3, object, current) -- Same cell, fresh coordinates.
equal(index:query(pos(-0.1, -4, -8), 0), {})
equal(index:query(current, 0), {object})
current = pos(40, 12, -16)
index:upsert(3, object, current) -- Cross several cells on all three axes.
equal(index:query(pos(-0.2, -4, -8), 0), {})
equal(index:query(current, 0), {object})
local replacement = {}
index:upsert(3, replacement, current)
equal(index:query(current, 0), {replacement})
assert(index:remove(3) and not index:remove(3) and not index:remove(999))
equal(index:query(current, 0), {})
index:upsert(3, object, pos(-4, -4, -4))
equal(index:query(pos(-4, -4, -4), 0), {object})
assert(#spatial.new(4):query(pos(0), 100) == 0)

-- Every numeric ID sorts numerically, including zero, negatives, and fractions.
local numeric = spatial.new(1)
local numeric_objects = {{}, {}, {}, {}, {}}
for i, id in ipairs({10, 2, 0, -4, 1.5}) do numeric:upsert(id, numeric_objects[i], pos(0)) end
equal(numeric:query(pos(0), 0), {
  numeric_objects[4], numeric_objects[3], numeric_objects[5], numeric_objects[2], numeric_objects[1],
})

-- The normal observer consumes ObjectRefs and owns both self filtering and projection.
local observation = dofile("observation.lua")
local observed_index = spatial.new(4)
local observer = {get_pos = function() return pos(0) end,
  get_luaentity = function() error("self must be filtered before reading its entity") end}
local peer_pos = pos(1)
local peer_entity = {name = "society:agent", _id = 2, _persona = "Visible Neighbor",
  _memory = {secret = "private"}, _goal = "private goal", _genesis = {memory_seeds = {"private seed"}}}
local peer = {get_pos = function() return peer_pos end,
  get_luaentity = function() return peer_entity end}
observed_index:upsert(1, observer, observer:get_pos())
observed_index:upsert(2, peer, peer:get_pos())
local engine = {get_objects_inside_radius = function(center, radius)
  return observed_index:query(center, radius)
end}
equal(engine.get_objects_inside_radius(pos(0), 2), {observer, peer})
local sensed = observation.observe(engine, observer, {radius = 2, node_names = {}})
assert(#sensed.agents == 1 and sensed.agents[1].id == 2 and sensed.agents[1].distance == 1)
assert(sensed.agents[1].name == "Visible Neighbor" and sensed.agents[1].pos.x == 1)
assert(sensed.agents[1]._memory == nil and sensed.agents[1]._goal == nil
  and sensed.agents[1]._genesis == nil and sensed.agents[1].secret == nil)
local farther_entity = {name = "society:agent", _id = 3, _persona = "Farther Neighbor"}
local farther_pos = pos(2)
local farther = {get_pos = function() return farther_pos end,
  get_luaentity = function() return farther_entity end}
observed_index:upsert(3, farther, farther_pos)
local bounded = observation.observe(engine, observer, {radius = 3, node_names = {}, max_agents = 1})
assert(#bounded.agents == 1 and bounded.agents[1].id == 2,
  "visible agents are bounded and nearest first")
peer_pos = pos(20)
observed_index:upsert(2, peer, peer:get_pos())
farther_pos = pos(30)
observed_index:upsert(3, farther, farther:get_pos())
assert(#observation.observe(engine, observer, {radius = 2, node_names = {}}).agents == 0)

-- Invalid updates must leave the previous mapping intact.
for _, value in ipairs({"1", false, {}, 0/0, math.huge, -math.huge}) do
  rejects(index.upsert, index, value, {}, pos(0))
  rejects(index.remove, index, value)
end
rejects(index.upsert, index, nil, {}, pos(0))
rejects(index.remove, index, nil)
rejects(index.upsert, index, 3, nil, pos(0))
for _, value in ipairs({0, -1, "4", false, 0/0, math.huge, -math.huge}) do
  rejects(spatial.new, value)
end
rejects(spatial.new, nil)
for _, value in ipairs({-1, "5", false, 0/0, math.huge, -math.huge}) do
  rejects(index.query, index, pos(0), value)
end
rejects(index.query, index, pos(0), nil)
for _, invalid in ipairs({false, "position", {}, {x = 0, y = 0}}) do
  rejects(index.upsert, index, 3, {}, invalid)
  rejects(index.query, index, invalid, 1)
end
for _, axis in ipairs({"x", "y", "z"}) do
  for _, value in ipairs({"0", false, 0/0, math.huge, -math.huge}) do
    local invalid = pos(0)
    invalid[axis] = value
    rejects(index.upsert, index, 3, {}, invalid)
    rejects(index.query, index, invalid, 1)
  end
end
rejects(index.upsert, index, 3, {}, nil)
rejects(index.query, index, nil, 1)
equal(index:query(pos(-4, -4, -4), 0), {object})

-- Finite extremes must neither overflow distance tests nor enumerate empty space forever.
local huge = spatial.new(1)
local axis_object, diagonal_object = {}, {}
huge:upsert(1, axis_object, pos(1e200))
huge:upsert(2, diagonal_object, pos(1e200, 1e200))
equal(huge:query(pos(0), 1e200), {axis_object})
equal(huge:query(pos(0), 1e300), {axis_object, diagonal_object})
equal(huge:query(pos(1e200), 0), {axis_object})
local tiny = spatial.new(1e-200)
tiny:upsert(1, axis_object, pos(1e-200))
tiny:upsert(2, diagonal_object, pos(1e-200, 1e-200))
equal(tiny:query(pos(0), 1e-200), {axis_object})
local overflow_cells = spatial.new(1e-200)
overflow_cells:upsert(1, axis_object, pos(1e200))
equal(overflow_cells:query(pos(1e200), 0), {axis_object})

-- A private PRNG makes this repeatable across Lua versions without changing math.random.
local seed = 1729
local function random(n)
  seed = (seed * 16807) % 2147483647
  return seed % n
end
local function random_pos()
  return pos((random(801) - 400) / 4, (random(801) - 400) / 4, (random(801) - 400) / 4)
end
local function brute_force(records, center, radius)
  local ids, objects = {}, {}
  for id, record in pairs(records) do
    local dx, dy, dz = record.pos.x - center.x, record.pos.y - center.y, record.pos.z - center.z
    if dx * dx + dy * dy + dz * dz <= radius * radius then ids[#ids + 1] = id end
  end
  table.sort(ids)
  for i, id in ipairs(ids) do objects[i] = records[id].object end
  return objects
end
local comparisons = 0
for _, cell_size in ipairs({0.5, 4, 13}) do
  local grid, records = spatial.new(cell_size), {}
  for step = 1, 300 do
    local id = random(81) - 40
    if random(5) == 0 then
      assert(grid:remove(id) == (records[id] ~= nil))
      records[id] = nil
    else
      local record = {object = {}, pos = random_pos()}
      grid:upsert(id, record.object, record.pos)
      records[id] = record
    end
    local center, radius = random_pos(), random(161) / 2
    equal(grid:query(center, radius), brute_force(records, center, radius))
    comparisons = comparisons + 1
    if records[id] then
      center = records[id].pos
      equal(grid:query(center, 0), brute_force(records, center, 0))
      comparisons = comparisons + 1
    end
  end
  for id in pairs(records) do assert(grid:remove(id)) end
  equal(grid:query(pos(0), 1000), {})
end

-- Structural regression guard: distant population must not add a linear query scan.
-- VM instruction counts avoid relying on wall-clock timing or engine benchmarks.
local function query_instructions(grid)
  local instructions = 0
  local old_hook, old_mask, old_count = debug.gethook()
  debug.sethook(function() instructions = instructions + 100 end, "", 100)
  local ok, result = pcall(grid.query, grid, pos(0), 1)
  debug.sethook(old_hook, old_mask, old_count)
  assert(ok, result)
  equal(result, {self_object})
  return instructions
end
local local_grid = spatial.new(4)
local_grid:upsert(1, self_object, pos(0))
local baseline = query_instructions(local_grid)
for id = 2, 513 do local_grid:upsert(id, {}, pos(id * 8, id * 8, id * 8)) end
assert(query_instructions(local_grid) <= baseline + 500, "query scans distant objects")

print("spatial tests passed (" .. comparisons .. " deterministic brute-force comparisons)")

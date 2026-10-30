local directory = debug.getinfo(1, "S").source:match("^@(.*/)") or "./"
local navigation = dofile(directory .. "navigation.lua")

local function point(x, z, y) return {x=x, y=y or 1, z=z} end
local function key(p) return p.x .. "," .. p.y .. "," .. p.z end
local function equal(a, b)
  if type(a) ~= type(b) then return false end
  if type(a) ~= "table" then return a == b end
  for k, value in pairs(a) do if not equal(value, b[k]) then return false end end
  for k in pairs(b) do if a[k] == nil then return false end end
  return true
end

local function fixture()
  local world, reads, writes = {}, 0, 0
  local definitions = {
    ["default:stone"]={walkable=true}, ["society:resource"]={walkable=true},
    ["test:plant"]={walkable=false}, ["test:unknown"]={},
  }
  local engine = {registered_nodes=definitions}
  engine.get_node_or_nil = function(p)
    reads = reads + 1
    local name = world[key(p)]
    if name == false then return nil end
    return {name=name or (p.y == 0 and "default:stone" or "air")}
  end
  engine.set_node = function() writes = writes + 1; error("navigation must never write") end
  return engine, world, function() return reads, writes end
end

local function failure(engine, pos, target, options, expected)
  local nextpoint, reason = navigation.step(engine, pos, target, options)
  assert(nextpoint == nil and reason == expected, tostring(reason) .. " ~= " .. expected)
end

local function checked_move(engine, from, target, options)
  local nextpoint, reason = navigation.step(engine, from, target, options)
  assert(nextpoint and reason == "ok", tostring(reason))
  local dx, dz = nextpoint.x - from.x, nextpoint.z - from.z
  assert(nextpoint.y == 1 and (dx == 0) ~= (dz == 0), "must follow a straight segment")
  local distance = math.abs(dx) + math.abs(dz)
  assert(distance >= 1 and distance <= (options and options.step or 2))
  local sx = dx == 0 and 0 or (dx > 0 and 1 or -1)
  local sz = dz == 0 and 0 or (dz > 0 and 1 or -1)
  for i = 1, distance do
    local p = point(from.x + sx*i, from.z + sz*i)
    local feet = engine.get_node_or_nil(p)
    local head = engine.get_node_or_nil(point(p.x, p.z, 2))
    local floor = engine.get_node_or_nil(point(p.x, p.z, 0))
    assert(feet and (feet.name == "air" or engine.registered_nodes[feet.name].walkable == false))
    assert(head and (head.name == "air" or engine.registered_nodes[head.name].walkable == false))
    assert(floor and engine.registered_nodes[floor.name].walkable == true)
  end
  return nextpoint
end

-- Bounded straight movement and exact arrival; air needs no registry entry.
local engine, world, counts = fixture()
local start, target = point(0, 0), point(5, 0)
local nextpoint = checked_move(engine, start, target)
assert(equal(nextpoint, point(2, 0)))
nextpoint = checked_move(engine, nextpoint, target)
assert(equal(nextpoint, point(4, 0)))
nextpoint = checked_move(engine, nextpoint, target)
assert(equal(nextpoint, target))
failure(engine, nextpoint, target, nil, "arrived")
assert(equal(checked_move(engine, point(0, 0), point(0, -3), {step=1}), point(0, -1)))
assert(equal(checked_move(engine, point(0, 0), point(-3, 0), {step=64}), point(-3, 0)))
world[key(point(1, 0))] = "test:plant"
assert(equal(checked_move(engine, start, point(2, 0)), point(2, 0)))

-- A wall requires a shortest four-neighbor detour. Never jump the corner.
engine, world, counts = fixture()
world[key(point(1, 0))] = "default:stone"
local pos, walked = point(0, 0), 0
local options = {bound=4, max_scan=128, step=2}
target = point(2, 0)
for _ = 1, 8 do
  local moved = checked_move(engine, pos, target, options)
  walked = walked + math.abs(moved.x - pos.x) + math.abs(moved.z - pos.z)
  pos = moved
  if equal(pos, target) then break end
end
assert(equal(pos, target) and walked == 4, "detour must use a shortest path")
assert(world[key(point(1, 0))] == "default:stone")
local _, writes = counts()
assert(writes == 0, "immutable wall was changed")

-- A closed enclosure cannot be crossed, even when step is larger than it.
engine, world = fixture()
for _, p in ipairs({point(1, 0), point(-1, 0), point(0, 1), point(0, -1)}) do
  world[key(p)] = "default:stone"
end
failure(engine, point(0, 0), point(3, 0), {bound=4, step=64}, "stuck")
engine, world = fixture()
for x = -1, 1 do
  for z = -1, 1 do
    if x ~= 0 or z ~= 0 then world[key(point(x, z))] = "default:stone" end
  end
end
failure(engine, point(3, 0), point(0, 0), {bound=4}, "stuck")

-- Feet, head and floor must all be loaded and have known walkability.
for _, blocked in ipairs({false, "ignore", "default:stone", "test:unknown", "unregistered:node"}) do
  for _, y in ipairs({1, 2}) do
    engine, world = fixture()
    world[key(point(1, 0, y))] = blocked
    local moved = checked_move(engine, point(0, 0), point(2, 0), {bound=3})
    assert(moved.x == 0 and moved.z ~= 0, "blocked body cell was traversed")
  end
end
for _, floor in ipairs({false, "ignore", "air", "test:plant", "test:unknown"}) do
  engine, world = fixture()
  world[key(point(1, 0, 0))] = floor
  local moved = checked_move(engine, point(0, 0), point(2, 0), {bound=3})
  assert(moved.x == 0 and moved.z ~= 0, "missing solid floor was traversed")
end
engine, world = fixture()
world[key(point(0, 0))] = false
failure(engine, point(0, 0), point(2, 0), nil, "invalid_start")
engine, world = fixture()
world[key(point(2, 0))] = false
failure(engine, point(0, 0), point(2, 0), nil, "target_blocked")

-- Resource blocks can be approached but are never returned as destinations.
engine, world = fixture()
world[key(point(3, 0))] = "society:resource"
assert(equal(checked_move(engine, point(0, 0), point(3, 0)), point(2, 0)))
failure(engine, point(2, 0), point(3, 0), nil, "target_adjacent")
world[key(point(3, 0))] = "default:stone"
failure(engine, point(2, 0), point(3, 0), nil, "target_blocked")
world[key(point(3, 0))] = "air"
assert(equal(checked_move(engine, point(2, 0), point(3, 0)), point(3, 0)))

-- No cached path crosses an obstacle added or removed between calls.
engine, world = fixture()
assert(equal(checked_move(engine, point(0, 0), point(4, 0)), point(2, 0)))
world[key(point(3, 0))] = "default:stone"
local moved = checked_move(engine, point(2, 0), point(4, 0), {bound=5})
assert(moved.x == 2 and moved.z ~= 0)
world[key(point(3, 0))] = "air"
assert(equal(checked_move(engine, point(2, 0), point(4, 0)), point(4, 0)))

-- Revalidate every intermediate cell, not just the final returned point.
for _, y in ipairs({0, 1, 2}) do
  engine, world = fixture()
  local original, visits = engine.get_node_or_nil, 0
  engine.get_node_or_nil = function(p)
    if p.x == 1 and p.z == 0 and p.y == 1 then
      visits = visits + 1
      if visits == 2 then
        world[key(point(1, 0, y))] = y == 0 and "air" or "default:stone"
      end
    end
    return original(p)
  end
  failure(engine, point(0, 0), point(2, 0), {step=2}, "path_blocked")
end

-- Scan, coordinate and distance limits are strict and checked before reads.
engine, world, counts = fixture()
failure(engine, point(0, 0), point(3, 0), {max_scan=1}, "scan_limit")
local reads = counts()
assert(reads <= 3, "max_scan did not bound queried grid cells")
engine, world, counts = fixture()
failure(engine, point(0, 0), point(8, 8), {max_scan=16}, "scan_limit")
reads = counts()
assert(reads <= 3 * 16, "scan budget was exceeded")
engine, world, counts = fixture()
failure(engine, point(0, 0), point(33, 0), nil, "target_out_of_bounds")
failure(engine, point(33, 0), point(0, 0), nil, "out_of_bounds")
failure(engine, point(-33, 0), point(33, 0), {bound=64}, "target_too_far")
failure(engine, point(0, 0), point(0, 0, 2), nil, "different_level")
failure(engine, point(0, 0, 2), point(1, 0, 2), nil, "unsupported_level")
assert(counts() == 0, "out-of-range request queried the engine")
-- A narrow 64-cell corridor exercises the inclusive maximum distance.
engine, world = fixture()
for x = -32, 32 do
  world[key(point(x, -1))], world[key(point(x, 1))] = "default:stone", "default:stone"
end
assert(equal(checked_move(engine, point(-32, 0), point(32, 0), {max_scan=4096, step=64}), point(32, 0)))

-- Invalid inputs and engine failures are safe; inputs and registry are read-only.
engine, world, counts = fixture()
for _, options_bad in ipairs({false, 2, {bound=0}, {bound=65}, {bound=0/0},
    {max_scan=0}, {max_scan=4097}, {max_scan=1.5}, {step=0}, {step=65},
    {step=math.huge}, {step=false}, {unknown=true}, setmetatable({}, {})}) do
  failure(engine, point(0, 0), point(2, 0), options_bad, "invalid_options")
end
for _, bad in ipairs({false, {}, {x=0, y=1}, point(.5, 0), point(0/0, 0),
    point(math.huge, 0), point(65, 0), {x=0, y=1, z=0, extra=true}, setmetatable(point(0, 0), {})}) do
  failure(engine, bad, point(2, 0), nil, "invalid_position")
  failure(engine, point(0, 0), bad, nil, "invalid_target")
end
failure({}, point(0, 0), point(2, 0), nil, "invalid_engine")
assert(counts() == 0, "invalid input queried the engine")
local pos_input, target_input, options_input = point(0, 0), point(2, 0), {bound=4, max_scan=64, step=2}
local registry = engine.registered_nodes
local result = checked_move(engine, pos_input, target_input, options_input)
result.x = 999
assert(equal(pos_input, point(0, 0)) and equal(target_input, point(2, 0)))
assert(equal(options_input, {bound=4, max_scan=64, step=2}))
assert(engine.registered_nodes == registry and next(world) == nil)
local _, write_count = counts()
assert(write_count == 0)
engine.get_node_or_nil = function() error("engine details must not escape") end
failure(engine, pos_input, target_input, options_input, "engine_error")

print("navigation tests passed")

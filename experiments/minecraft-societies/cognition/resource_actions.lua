-- Lua 5.1, engine-independent resource actions.
-- API: new(engine, object, initial_inventory) -> character-local actions.
-- engine.get_node_or_nil(pos) and engine.set_node(pos, {name = name}) use
-- Luanti's function calling convention. object:get_pos() returns the actor's
-- current position. Create a separate instance for each character.
-- actions:gather(pos, node_name) removes exactly that node and credits one;
-- actions:build(pos, node_name) places it and spends one. Targets must be
-- integer node coordinates within Euclidean distance 1.5 of the actor.
-- Both return true on verified success, otherwise false, reason. count(name)
-- and inventory() provide read-only access (inventory returns a copy).
-- This is not a protection, line-of-sight, or engine callback adapter; the
-- integrator must enforce those policies in the injected engine. The engine
-- must synchronously apply writes and give truthful readbacks. Failed writes
-- can still change the world; a failed readback is never treated as success.
local M = {}
local MAX_COUNT = 2147483647
local MAX_COORD = 31000

local function finite(n)
  return type(n) == "number" and n == n and n ~= math.huge and n ~= -math.huge
end

local function valid_name(name)
  return type(name) == "string" and #name <= 128
    and name:match("^[a-z0-9_]+:[a-z0-9_]+$") ~= nil
    and name ~= "air" and name ~= "ignore" and name:sub(1, 6) ~= "group:"
end

local function valid_pos(p, integer)
  if type(p) ~= "table" then return false end
  for _, key in ipairs({"x", "y", "z"}) do
    local n = p[key]
    if not finite(n) or math.abs(n) > MAX_COORD or (integer and n ~= math.floor(n)) then
      return false
    end
  end
  return true
end

local function copy_pos(p) return {x = p.x, y = p.y, z = p.z} end

function M.new(engine, object, initial_inventory)
  assert(type(engine) == "table" and type(engine.get_node_or_nil) == "function"
    and type(engine.set_node) == "function", "engine read and write functions required")
  assert((type(object) == "table" or type(object) == "userdata")
    and type(object.get_pos) == "function", "actor object required")
  assert(initial_inventory == nil or type(initial_inventory) == "table", "invalid inventory")
  local stock = {}
  for name, count in pairs(initial_inventory or {}) do
    assert(valid_name(name) and finite(count) and count >= 0 and count <= MAX_COUNT
      and count == math.floor(count), "invalid inventory entry")
    if count > 0 then stock[name] = count end
  end
  local actions, busy = {}, false

  function actions:count(name)
    assert(valid_name(name), "invalid node name")
    return stock[name] or 0
  end

  function actions:inventory()
    local result = {}
    for name, count in pairs(stock) do result[name] = count end
    return result
  end

  local function perform(kind, pos, name)
    if not valid_name(name) then return false, "invalid node name" end
    if not valid_pos(pos, true) then return false, "invalid target position" end
    local target = copy_pos(pos)
    local actor = object:get_pos()
    if not valid_pos(actor, false) then return false, "invalid actor position" end
    local dx, dy, dz = target.x - actor.x, target.y - actor.y, target.z - actor.z
    if dx * dx + dy * dy + dz * dz > 2.25 then return false, "target out of reach" end
    local before = engine.get_node_or_nil(copy_pos(target))
    if type(before) ~= "table" or type(before.name) ~= "string" or before.name == "ignore" then
      return false, "target not loaded"
    end
    local count = stock[name] or 0
    local expected
    if kind == "gather" then
      if before.name ~= name then return false, "resource mismatch" end
      if count >= MAX_COUNT then return false, "inventory full" end
      expected = "air"
    else
      if before.name ~= "air" then return false, "target not empty" end
      if count == 0 then return false, "insufficient inventory" end
      expected = name
    end
    local result = engine.set_node(copy_pos(target), {name = expected})
    if result == false then return false, "world write rejected" end
    local after = engine.get_node_or_nil(copy_pos(target))
    if type(after) ~= "table" or after.name ~= expected then return false, "world change not verified" end
    if kind == "gather" then stock[name] = count + 1
    elseif count == 1 then stock[name] = nil
    else stock[name] = count - 1 end
    return true
  end

  local function run(kind, pos, name)
    if busy then return false, "action already in progress" end
    busy = true
    local ok, result, reason = pcall(perform, kind, pos, name)
    busy = false
    if not ok then return false, "engine or input error" end
    return result, reason
  end
  function actions:gather(pos, name) return run("gather", pos, name) end
  function actions:build(pos, name) return run("build", pos, name) end
  return actions
end

return M

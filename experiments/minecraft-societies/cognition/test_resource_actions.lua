-- Run from this directory with lua5.1 test_resource_actions.lua.
local resource = dofile("resource_actions.lua")
local function key(p) return p.x .. "," .. p.y .. "," .. p.z end
local p = {x = 1, y = 0, z = 0}
local world = {[key(p)] = "default:stone"}
local writes, mode = 0, nil
local engine = {
  get_node_or_nil = function(pos)
    if mode == "read_error" then error("read failed") end
    local name = world[key(pos)]
    if name then return {name = name} end
  end,
  set_node = function(pos, node)
    writes = writes + 1
    if mode == "reject" then return false end
    if mode == "write_error" then error("write failed") end
    if mode ~= "no_change" then world[key(pos)] = node.name end
    if mode == "unload_after" then world[key(pos)] = nil end
  end,
}
local actor_pos = {x = 0, y = 0, z = 0}
local actor = {get_pos = function() return actor_pos end}
local initial = {["default:wood"] = 2}
local a = resource.new(engine, actor, initial)
local b = resource.new(engine, actor)
initial["default:wood"] = 100
assert(a:count("default:wood") == 2 and b:count("default:wood") == 0)
local snapshot = a:inventory(); snapshot["default:wood"] = 99
assert(a:count("default:wood") == 2)
assert(not a:gather(p, "default:wood") and writes == 0)
assert(a:gather(p, "default:stone") and world[key(p)] == "air")
assert(a:count("default:stone") == 1 and b:count("default:stone") == 0)
assert(not a:gather(p, "default:stone"))
assert(a:build(p, "default:stone") and world[key(p)] == "default:stone")
assert(a:count("default:stone") == 0)
assert(not a:build(p, "default:wood") and a:count("default:wood") == 2)
world[key(p)] = "air"
assert(not b:build(p, "default:wood") and world[key(p)] == "air")
for _, failure in ipairs({"reject", "no_change", "write_error", "unload_after"}) do
  mode = failure; world[key(p)] = "air"
  assert(not a:build(p, "default:wood") and a:count("default:wood") == 2, failure)
  world[key(p)] = "default:stone"
  assert(not a:gather(p, "default:stone") and a:count("default:stone") == 0, failure)
end
mode = "read_error"
assert(not a:build(p, "default:wood") and a:count("default:wood") == 2)
mode = nil
world[key(p)] = nil
assert(not a:build(p, "default:wood") and not a:gather(p, "default:stone"))
world[key(p)] = "ignore"
assert(not a:build(p, "default:wood") and not a:gather(p, "default:stone"))
world[key(p)] = "air"
local previous_writes = writes
for _, name in ipairs({"", "air", "ignore", "group:stone", "default:*", "default:stone extra", "DEFAULT:stone"}) do
  assert(not a:build(p, name) and not a:gather(p, name))
end
for _, pos in ipairs({{x = 2, y = 0, z = 0}, {x = 1.1, y = 0, z = 0},
  {x = 0/0, y = 0, z = 0}, {x = math.huge, y = 0, z = 0}, {x = 31001, y = 0, z = 0}, {x = 0}}) do
  assert(not a:build(pos, "default:wood") and not a:gather(pos, "default:stone"))
end
assert(writes == previous_writes and a:count("default:wood") == 2)
actor_pos = nil
assert(not a:build(p, "default:wood"))
actor_pos = {x = 0, y = 0, z = 0}
world[key(p)] = "air"
assert(a:build(p, "default:wood") and a:count("default:wood") == 1)
local full = resource.new(engine, actor, {["default:wood"] = 2147483647})
assert(not full:gather(p, "default:wood") and full:count("default:wood") == 2147483647)
assert(not pcall(resource.new, engine, actor, {["group:stone"] = 1}))
assert(not pcall(resource.new, engine, actor, {["default:wood"] = -1}))
assert(not pcall(resource.new, engine, actor, {["default:wood"] = 0/0}))
-- A nested action during a write must not spend the same stock twice.
world[key(p)] = "air"
local original_write = engine.set_node
engine.set_node = function(pos, node)
  assert(not a:build(pos, "default:wood"))
  return original_write(pos, node)
end
assert(a:build(p, "default:wood") and a:count("default:wood") == 0)
engine.set_node = original_write
-- Diagonally adjacent nodes are within the fixed reach; a three-axis diagonal is not.
local diagonal = {x = 1, y = 1, z = 0}
world[key(diagonal)] = "default:stone"
assert(a:gather(diagonal, "default:stone"))
assert(not a:gather({x = 1, y = 1, z = 1}, "default:stone"))
print("resource action tests passed")

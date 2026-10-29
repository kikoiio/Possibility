local observation = dofile("observation.lua")
local memory = dofile("memory.lua")

local function object(id, x, secret, name)
  local entity = {name = name or "society:agent", _id = id, _memory = {secret = secret}}
  return {get_pos = function() return {x = x, y = 0, z = 0} end,
    get_luaentity = function() return entity end}
end
local me = object(1, 0, "mine")
local near = object(2, 2, "private")
local far = object(3, 5, "far")
local calls = 0
local engine = {
  get_objects_inside_radius = function(pos, radius)
    assert(pos.x == 0 and radius == 3)
    return {far, near, me, object(4, 1, "other", "other:entity")}
  end,
  find_nodes_in_area = function(lo, hi, names)
    calls = calls + 1
    assert(lo.x == -3 and hi.x == 3 and names[1] == "society:mark")
    return {{x = 2, y = 0, z = 0}, {x = 3, y = 3, z = 0}, {x = -1, y = 0, z = 0}}
  end,
  get_node_or_nil = function(p) if p.x == -1 then return nil end return {name = "society:mark"} end,
}
local obs = observation.observe(engine, me, {radius = 3, node_names = {"society:mark"}})
assert(#obs.agents == 1 and obs.agents[1].id == 2 and obs.agents[1].distance == 2)
assert(obs.agents[1]._memory == nil and obs.agents[1].secret == nil)
assert(#obs.nodes == 1 and obs.nodes[1].pos.x == 2 and calls == 1)
assert(not pcall(observation.observe, engine, me, {radius = -1, node_names = {}}))
assert(not pcall(observation.observe, engine, me, {radius = 3, node_names = {"group:all"}}))
local gone, reason = observation.observe(engine, {get_pos = function() return nil end}, {radius = 3, node_names = {}})
assert(gone == nil and reason == "observer has no position")

local a, b = memory.new(2), memory.new(2)
local entry = {time = 1, text = "saw 2", source = {kind = "observation", id = 1}}
assert(a:add(entry)); entry.source.id = 99; entry.text = "changed"
assert(a:list()[1].source.id == 1 and a:list()[1].text == "saw 2")
a:add({time = 2, text = "told", source = {kind = "agent", id = 2}})
a:add({time = 3, text = "acted", source = {kind = "action", id = 1}})
local list = a:list()
assert(a:size() == 2 and list[1].text == "told" and list[1].source.id == 2 and list[2].time == 3)
assert(b:size() == 0)
list[1].source.id = 99
assert(a:list()[1].source.id == 2)
assert(not pcall(a.add, a, {time = 4, text = "missing source"}))
assert(a:size() == 2)
a:clear(); assert(a:size() == 0 and #a:list() == 0)
a:add({time = 5, text = "new", source = {kind = "observation", id = 1}})
assert(a:list()[1].time == 5)
local zero = memory.new(0)
assert(zero:add({time = 1, text = "no", source = {kind = "observation", id = 1}}) == false and zero:size() == 0)
assert(not pcall(memory.new, -1) and not pcall(memory.new, 1.5))
print("cognition tests passed")

local persistence = dofile("persistence.lua")
local memory = dofile("memory.lua")

local function agent(capacity)
  local pos = {x = 1, y = 2, z = 3}
  return {
    object = {get_pos = function() return pos end,
      set_pos = function(_, p) pos = p end},
    _id = 0, _persona = "atlas", _home = {x = 4, y = 5, z = 6},
    _facing = {x = 1, z = 0}, _target = {x = 7, y = 8, z = 9},
    _rng = 123, _decisions = 2, _marks_placed = 3,
    _memory = {met = {[0] = true, [17] = true, ["17"] = true}, idle_streak = 4},
    _episodic = memory.new(capacity or 3),
  }
end

local a = agent()
a._episodic:add({time = 1, text = "one", source = {kind = "agent", id = 0}})
a._episodic:add({time = 2, text = "two", source = {kind = "observation", id = "x"}})
local s = assert(persistence.snapshot(a))
assert(s.version == 1 and s.id == 0 and s.pos.y == 2 and s.rng == 123)
assert(#s.memory.met == 3 and s.memory.met[1] == 0 and s.memory.met[2] == 17 and s.memory.met[3] == "17")
-- Every table is either a dense array or an object with string keys; all values
-- are JSON-safe and there are no cycles or aliases to the original entity.
local function json_safe(value, stack)
  local kind = type(value)
  if kind == "string" or kind == "boolean" then return end
  if kind == "number" then assert(value == value and value ~= math.huge and value ~= -math.huge); return end
  assert(kind == "table" and not stack[value]); stack[value] = true
  local numeric, strings, count, max = false, false, 0, 0
  for k, v in pairs(value) do
    if type(k) == "number" then
      numeric = true; assert(k >= 1 and k == math.floor(k)); count = count + 1; max = math.max(max, k)
    else assert(type(k) == "string"); strings = true end
    json_safe(v, stack)
  end
  assert(not (numeric and strings) and count == max); stack[value] = nil
end
json_safe(s, {})
s.pos.x = 11; s.home.x = 12; s.episodic[1].source.id = 8
assert(a.object:get_pos().x == 1 and a._home.x == 4 and a._episodic:list()[1].source.id == 0)
s = persistence.snapshot(a)
local b = agent()
b._episodic:add({time = 9, text = "old", source = {kind = "agent", id = 9}})
assert(persistence.restore(b, s))
assert(b.object:get_pos().x == 1 and b._id == 0 and b._home.x == 4 and b._facing.x == 1)
assert(b._persona == "atlas" and b._target.z == 9 and b._rng == 123)
assert(b._decisions == 2 and b._marks_placed == 3 and b._memory.idle_streak == 4)
assert(b._memory.met[0] and b._memory.met[17] and b._memory.met["17"])
assert(#b._episodic:list() == 2 and b._episodic:list()[1].text == "one")
s.home.x = 99; s.episodic[1].text = "changed"; s.pos.x = 99
assert(b._home.x == 4 and b._episodic:list()[1].text == "one" and b.object:get_pos().x == 1)

s = persistence.snapshot(a)
assert(persistence.restore(b, s, {reset_minds = true}))
assert(b._id == 0 and b.object:get_pos().x == 1 and b._rng == 123 and b._home.x == 4)
assert(b._persona == nil and b._target == nil and b._memory.idle_streak == 0
  and next(b._memory.met) == nil and b._episodic:size() == 0)
local cleared = persistence.snapshot(b)
assert(cleared.persona == nil and cleared.target == nil and #cleared.memory.met == 0)
-- The destination memory's own FIFO capacity governs retained episodes.
local small = agent(1)
persistence.restore(small, s)
assert(small._episodic:size() == 1 and small._episodic:list()[1].text == "two")
local bad = persistence.snapshot(a)
bad.episodic[2].time = 0/0
local before = b.object:get_pos().x
assert(not pcall(persistence.restore, b, bad) and b.object:get_pos().x == before and b._episodic:size() == 0)
bad = persistence.snapshot(a); bad.memory.met = {[1] = 0, [3] = 1}
assert(not pcall(persistence.restore, b, bad))
bad = persistence.snapshot(a); bad.version = 99
assert(not pcall(persistence.restore, b, bad))
bad = persistence.snapshot(a); bad.memory.met = {17, 17}
assert(not pcall(persistence.restore, b, bad))
assert(not pcall(persistence.restore, b, s, {reset_minds = "false"}))
a.object.get_pos = function() return nil end
local missing, reason = persistence.snapshot(a)
assert(missing == nil and reason == "entity has no position")
print("persistence tests passed")

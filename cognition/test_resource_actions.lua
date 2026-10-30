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
-- Restore preflight uses exactly the constructor's name/count constraints.
assert(not pcall(resource.validate_inventory, {["society:resource"] = 2147483648}))
assert(not pcall(resource.validate_inventory, {["group:stone"] = 1}))
local validated_stock = resource.validate_inventory({["society:resource"] = 2})
validated_stock["society:resource"] = 9
assert(a:count("society:resource") == 0)
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
-- Physical handoffs operate only on constructor instances, never on the map.
local item, max = "society:resource", 2147483647
local sender_pos, recipient_pos = {x = 0, y = 0, z = 0}, {x = 1.5, y = 2, z = 0}
local sender_object = {get_pos = function() return sender_pos end}
local recipient_object = {get_pos = function() return recipient_pos end}
local sender = resource.new(engine, sender_object, {[item] = 5, ["default:wood"] = 3})
local recipient = resource.new(engine, recipient_object, {[item] = 2})
local function same_inventory(left, right)
  for name, count in pairs(left) do assert(right[name] == count) end
  for name, count in pairs(right) do assert(left[name] == count) end
end
local function rejected(from, to, name, amount, expected)
  local before_sender = from and type(from.inventory) == "function" and from:inventory()
  local before_recipient = to and type(to.inventory) == "function" and to:inventory()
  local ok, reason = resource.transfer(from, to, name, amount)
  assert(ok == false and type(reason) == "string",
    tostring(ok) .. ":" .. tostring(reason) .. ":" .. tostring(expected))
  if expected then assert(reason == expected, reason) end
  if from and from.inventory then same_inventory(before_sender, from:inventory()) end
  if to and to.inventory then same_inventory(before_recipient, to:inventory()) end
end
local transfer_writes = writes
assert(resource.transfer(sender, recipient, item, 3)) -- exactly 2.5 blocks
assert(sender:count(item) == 2 and recipient:count(item) == 5)
assert(sender:count("default:wood") == 3 and recipient:count("default:wood") == 0)
assert(resource.transfer(recipient, sender, item, 5))
assert(sender:count(item) == 7 and recipient:count(item) == 0)
assert(recipient:inventory()[item] == nil)
rejected(sender, sender, item, 1, "cannot transfer to self")
rejected(sender, {}, item, 1, "invalid action instance")
rejected(nil, recipient, item, 1, "invalid action instance")
-- Matching public methods, or adding fields to a genuine instance, grants no stock access.
local fake = {count = sender.count, inventory = sender.inventory,
  stock = {[item] = 100}, object = sender_object, busy = false}
rejected(fake, recipient, item, 1, "invalid action instance")
for _, amount in ipairs({0, -1, 0.5, max + 1, 0/0, math.huge, -math.huge, "1", true, {}}) do
  rejected(sender, recipient, item, amount, "invalid amount")
end
rejected(sender, recipient, item, nil, "invalid amount")
for _, name in ipairs({"", "air", "ignore", "group:stone", "invalid", true, {}}) do
  rejected(sender, recipient, name, 1, "invalid node name")
end
rejected(sender, recipient, item, 8, "insufficient inventory")
rejected(recipient, sender, "default:wood", 1, "insufficient inventory")
local full_recipient = resource.new(engine, recipient_object, {[item] = max})
rejected(sender, full_recipient, item, 1, "inventory full")
assert(full_recipient:count(item) == max)
local almost_full = resource.new(engine, recipient_object, {[item] = max - 1})
rejected(sender, almost_full, item, 2, "inventory full")
assert(almost_full:count(item) == max - 1)
assert(resource.transfer(sender, almost_full, item, 1))
assert(almost_full:count(item) == max and sender:count(item) == 6)
local max_sender = resource.new(engine, sender_object, {[item] = max})
local empty_recipient = resource.new(engine, recipient_object)
assert(resource.transfer(max_sender, empty_recipient, item, max))
assert(max_sender:count(item) == 0 and empty_recipient:count(item) == max)
-- Reach uses all three axes; adjacent coordinates alone cannot authorize giving.
recipient_pos = {x = 1.5, y = 2, z = 0.001}
rejected(sender, recipient, item, 1, "target out of reach")
recipient_pos = {x = 1.5, y = 1.5, z = 1.5}
rejected(sender, recipient, item, 1, "target out of reach")
recipient_pos = nil
rejected(sender, recipient, item, 1, "invalid actor position")
recipient_pos = {x = 0, y = math.huge, z = 0}
rejected(sender, recipient, item, 1, "invalid actor position")
recipient_pos = {x = 1, y = 0, z = 0}
sender_pos = nil
rejected(sender, recipient, item, 1, "invalid actor position")
sender_pos = {x = 0, y = 0, z = 0}
-- Engine exceptions release both private locks and cannot mutate either stock.
recipient_object.get_pos = function() error("unavailable actor") end
rejected(sender, recipient, item, 1, "engine or input error")
recipient_object.get_pos = function() return recipient_pos end
assert(resource.transfer(sender, recipient, item, 1))
assert(sender:count(item) == 5 and recipient:count(item) == 1)
-- A position callback cannot reenter transfers or gather/build on either side.
sender_object.get_pos = function()
  rejected(sender, recipient, item, 1, "action already in progress")
  rejected(recipient, sender, item, 1, "action already in progress")
  local ok, reason = sender:gather(p, item)
  assert(not ok and reason == "action already in progress")
  ok, reason = recipient:build(p, item)
  assert(not ok and reason == "action already in progress")
  return sender_pos
end
assert(resource.transfer(sender, recipient, item, 1))
assert(sender:count(item) == 4 and recipient:count(item) == 2)
sender_object.get_pos = function() return sender_pos end
assert(writes == transfer_writes)
-- A handoff must also respect a gather/build already holding either lock.
world[key(p)] = "air"
engine.set_node = function(pos, node)
  rejected(sender, recipient, item, 1, "action already in progress")
  rejected(recipient, sender, item, 1, "action already in progress")
  return original_write(pos, node)
end
assert(sender:build(p, item))
engine.set_node = original_write
assert(sender:count(item) == 3 and recipient:count(item) == 2)
assert(resource.transfer(sender, recipient, item, 2))
assert(sender:count(item) == 1 and recipient:count(item) == 4)
print("resource action tests passed")

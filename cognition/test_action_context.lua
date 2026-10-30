local context = dofile("action_context.lua")
local bounds = {min = {x = -2, y = 1, z = -2}, max = {x = 2, y = 1, z = 2}}
local nodes = {
  {name = "society:resource", pos = {x = 1, y = 1, z = 0}},
  {name = "society:resource", pos = {x = 2, y = 1, z = 0}},
  {name = "society:mark", pos = {x = 0, y = 1, z = 1}},
}
local reads = 0
local engine = {get_node_or_nil = function(p)
  reads = reads + 1
  return {name = p.x == 1 and "society:resource" or "air"}
end}
local pos = {x = 0, y = 1, z = 0}
local first = context.describe(engine, pos, nodes, {}, bounds)
assert(#first.gather_points == 1 and first.gather_points[1].x == 1)
assert(first.transfer.item == "society:resource" and first.transfer.max_distance == 2.5
  and first.transfer.target_source == "nearby_agents")
assert(#first.build_points == 0 and reads == 0)
local second = context.describe(engine, pos, nodes, {["society:resource"] = 1}, bounds)
assert(#second.build_points == 5 and reads == 8)
first.gather_points[1].x = 99
assert(nodes[1].pos.x == 1)
local edge = context.describe(engine, {x = 2, y = 1, z = 2}, nodes, {["society:resource"] = 1}, bounds)
for _, p in ipairs(edge.build_points) do assert(p.x <= 2 and p.z <= 2) end
print("action context tests passed")

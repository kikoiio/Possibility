-- Describe executable local choices without choosing a policy for the actor.
local M = {}

function M.describe(engine, pos, nodes, inventory, bounds)
  local gather, build = {}, {}
  local function inside(p)
    for _, axis in ipairs({"x", "y", "z"}) do
      if p[axis] < bounds.min[axis] or p[axis] > bounds.max[axis] then return false end
    end
    return true
  end
  for _, node in ipairs(nodes) do
    local p = node.pos
    local dx, dy, dz = p.x - pos.x, p.y - pos.y, p.z - pos.z
    if node.name == "society:resource" and inside(p) and dx * dx + dy * dy + dz * dz <= 2.25 then
      gather[#gather + 1] = {x = p.x, y = p.y, z = p.z}
    end
  end
  if (inventory["society:resource"] or 0) > 0 then
    for dx = -1, 1 do
      for dz = -1, 1 do
        local p = {x = pos.x + dx, y = pos.y, z = pos.z + dz}
        if (dx ~= 0 or dz ~= 0) and inside(p) then
          local node = engine.get_node_or_nil(p)
          if node and node.name == "air" then build[#build + 1] = p end
        end
      end
    end
  end
  return {gather_points = gather, build_points = build, reach = 1.5,
    transfer = {item = "society:resource", max_distance = 2.5,
      target_source = "nearby_agents"},
    movement = "wander or approach sets a destination; advance follows a walkable path toward it",
    sensing = "local radius, no line-of-sight occlusion; sampled state can change"}
end

return M

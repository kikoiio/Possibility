-- Lua 5.1; the engine API is injected so this module can also be tested offline.
local M = {}

local function finite(n)
  return type(n) == "number" and n == n and n ~= math.huge and n ~= -math.huge
end

local function position(p)
  assert(type(p) == "table" and finite(p.x) and finite(p.y) and finite(p.z), "invalid position")
  return {x = p.x, y = p.y, z = p.z}
end

local function id_valid(id)
  return (type(id) == "string" and id ~= "") or finite(id)
end

local function id_less(a, b)
  if type(a.id) ~= type(b.id) then return type(a.id) < type(b.id) end
  return a.id < b.id
end

-- Only public identity and position cross the boundary; Lua entity tables never do.
function M.observe(engine, self_object, options)
  assert(type(engine) == "table" and self_object, "engine and self object required")
  assert(type(options) == "table" and finite(options.radius) and options.radius >= 0, "invalid radius")
  assert(type(options.node_names) == "table", "node_names required")
  local pos = self_object:get_pos()
  if not pos then return nil, "observer has no position" end
  pos = position(pos)
  local radius = options.radius
  local allowed = {}
  for _, name in ipairs(options.node_names) do
    assert(type(name) == "string" and name ~= "" and not name:match("^group:"), "node_names must be explicit names")
    allowed[name] = true
  end
  local agents = {}
  for _, obj in ipairs(engine.get_objects_inside_radius(pos, radius)) do
    if obj ~= self_object then
      local entity = obj:get_luaentity()
      local other_pos = obj:get_pos()
      if entity and entity.name == (options.agent_name or "society:agent") and id_valid(entity._id) and other_pos then
        other_pos = position(other_pos)
        local dx, dy, dz = other_pos.x - pos.x, other_pos.y - pos.y, other_pos.z - pos.z
        local d2 = dx * dx + dy * dy + dz * dz
        if d2 <= radius * radius then
          agents[#agents + 1] = {id = entity._id, pos = other_pos, distance = math.sqrt(d2)}
        end
      end
    end
  end
  table.sort(agents, id_less)
  local nodes = {}
  if #options.node_names > 0 then
    local minp = {x = pos.x - radius, y = pos.y - radius, z = pos.z - radius}
    local maxp = {x = pos.x + radius, y = pos.y + radius, z = pos.z + radius}
    for _, p in ipairs(engine.find_nodes_in_area(minp, maxp, options.node_names)) do
      local np = position(p)
      local dx, dy, dz = np.x - pos.x, np.y - pos.y, np.z - pos.z
      if dx * dx + dy * dy + dz * dz <= radius * radius then
        local node = engine.get_node_or_nil(np)
        if node and allowed[node.name] then
          nodes[#nodes + 1] = {name = node.name, pos = np}
        end
      end
    end
  end
  table.sort(nodes, function(a, b)
    if a.pos.x ~= b.pos.x then return a.pos.x < b.pos.x end
    if a.pos.y ~= b.pos.y then return a.pos.y < b.pos.y end
    if a.pos.z ~= b.pos.z then return a.pos.z < b.pos.z end
    return a.name < b.name
  end)
  return {pos = pos, radius = radius, agents = agents, nodes = nodes}
end

return M

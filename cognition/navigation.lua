-- Pure Lua 5.1, read-only flat-world navigation.
-- step(engine, pos, target, {bound=32, max_scan=512, step=2}) -> point, "ok"
-- or nil, reason. All coordinates are integers; only y=1 is supported.
-- Bounds are inclusive +/-bound (1..64); max_scan is 1..4096 distinct grid
-- cells, path distance and step are capped at 64. Scan exhaustion fails closed.
-- BFS uses four neighbors and finds a shortest path within these limits.
-- Return at most step cells along its first STRAIGHT segment, stopping before
-- a turn. Every intermediate cell is rechecked immediately before returning.
-- A solid society:resource target is approached to a reachable adjacent cell;
-- once adjacent, return nil, "target_adjacent", never "arrived". Other solid
-- targets are rejected. Only exact input pos==target returns nil, "arrived".
-- No movement, world writes, cached paths, or references to input tables escape.
local M = {}
local MAX_DISTANCE, MAX_SCAN = 64, 4096
local DIRECTIONS = {{1, 0}, {0, 1}, {-1, 0}, {0, -1}}

local function integer(value, low, high)
  return type(value) == "number" and value == value and value >= low
    and value <= high and value == math.floor(value)
end

local function position(value)
  if type(value) ~= "table" or getmetatable(value) ~= nil then return false end
  for key in pairs(value) do
    if key ~= "x" and key ~= "y" and key ~= "z" then return false end
  end
  return integer(value.x, -MAX_DISTANCE, MAX_DISTANCE)
    and integer(value.y, -MAX_DISTANCE, MAX_DISTANCE)
    and integer(value.z, -MAX_DISTANCE, MAX_DISTANCE)
end

local function inside(x, z, bound)
  return math.abs(x) <= bound and math.abs(z) <= bound
end

local function node(engine, x, y, z)
  local value = engine.get_node_or_nil({x=x, y=y, z=z})
  if type(value) ~= "table" or type(value.name) ~= "string"
      or value.name == "ignore" then return nil end
  return value.name
end

local function walkable(engine, name)
  if not name then return nil end
  if name == "air" then return false end
  local definition = engine.registered_nodes[name]
  if type(definition) ~= "table" or type(definition.walkable) ~= "boolean" then return nil end
  return definition.walkable
end

local function clear(engine, x, z)
  local feet = node(engine, x, 1, z)
  if walkable(engine, feet) ~= false then return false, feet end
  local head = node(engine, x, 2, z)
  if walkable(engine, head) ~= false then return false, feet end
  return walkable(engine, node(engine, x, 0, z)) == true, feet
end

local function search(engine, start, target, bound, max_scan, step)
  local width = 2 * bound + 1
  local function key(x, z) return (x + bound) * width + z + bound + 1 end
  local scanned, cells = 0, {}
  local function inspect(x, z)
    local id = key(x, z)
    local cached = cells[id]
    if cached then return cached.clear, cached.name end
    if scanned == max_scan then return nil end
    scanned = scanned + 1
    local pass, name = clear(engine, x, z)
    cells[id] = {clear=pass, name=name}
    return pass, name
  end

  if not inspect(start.x, start.z) then return nil, "invalid_start" end
  if start.x == target.x and start.z == target.z then return nil, "arrived" end
  local target_clear, target_name = inspect(target.x, target.z)
  if target_clear == nil then return nil, "scan_limit" end
  local adjacent = not target_clear and target_name == "society:resource"
    and walkable(engine, target_name) == true
  if not target_clear and not adjacent then return nil, "target_blocked" end
  local function goal(x, z)
    local distance = math.abs(target.x - x) + math.abs(target.z - z)
    return distance == (adjacent and 1 or 0)
  end
  if goal(start.x, start.z) then return nil, "target_adjacent" end

  local queue = {{x=start.x, z=start.z, depth=0}}
  local visited = {[key(start.x, start.z)]=true}
  local head, found, exhausted, distance_limited = 1, nil, false, false
  while head <= #queue and not found do
    local current = queue[head]
    if current.depth < MAX_DISTANCE then
      for _, direction in ipairs(DIRECTIONS) do
        local x, z = current.x + direction[1], current.z + direction[2]
        local id = key(x, z)
        if inside(x, z, bound) and not visited[id] then
          local pass = inspect(x, z)
          if pass == nil then
            exhausted = true
          else
            visited[id] = true
            if pass then
              queue[#queue + 1] = {x=x, z=z, parent=head, depth=current.depth + 1}
              if goal(x, z) then found = #queue; break end
            end
          end
        end
      end
    else
      distance_limited = true
    end
    head = head + 1
  end
  if not found then
    if exhausted then return nil, "scan_limit" end
    if distance_limited then return nil, "distance_limit" end
    return nil, "stuck"
  end

  local reverse = {}
  while queue[found].parent do
    reverse[#reverse + 1] = queue[found]
    found = queue[found].parent
  end
  local first = reverse[#reverse]
  local dx, dz = first.x - start.x, first.z - start.z
  local previous = start
  local result
  if not clear(engine, start.x, start.z) then return nil, "path_blocked" end
  for offset = 1, math.min(step, #reverse) do
    local cell = reverse[#reverse - offset + 1]
    if cell.x - previous.x ~= dx or cell.z - previous.z ~= dz then break end
    if not clear(engine, cell.x, cell.z) then return nil, "path_blocked" end
    result = {x=cell.x, y=1, z=cell.z}
    previous = cell
  end
  return result, "ok"
end

function M.step(engine, pos, target, options)
  if type(engine) ~= "table" or type(engine.get_node_or_nil) ~= "function"
      or type(engine.registered_nodes) ~= "table" then return nil, "invalid_engine" end
  if not position(pos) then return nil, "invalid_position" end
  if not position(target) then return nil, "invalid_target" end
  if options == nil then options = {} end
  if type(options) ~= "table" or getmetatable(options) ~= nil then return nil, "invalid_options" end
  for option in pairs(options) do
    if option ~= "bound" and option ~= "max_scan" and option ~= "step" then
      return nil, "invalid_options"
    end
  end
  local bound = options.bound == nil and 32 or options.bound
  local max_scan = options.max_scan == nil and 512 or options.max_scan
  local step = options.step == nil and 2 or options.step
  if not integer(bound, 1, MAX_DISTANCE) or not integer(max_scan, 1, MAX_SCAN)
      or not integer(step, 1, MAX_DISTANCE) then return nil, "invalid_options" end
  if pos.y ~= target.y then return nil, "different_level" end
  if pos.y ~= 1 then return nil, "unsupported_level" end
  if not inside(pos.x, pos.z, bound) then return nil, "out_of_bounds" end
  if not inside(target.x, target.z, bound) then return nil, "target_out_of_bounds" end
  if math.abs(target.x - pos.x) + math.abs(target.z - pos.z) > MAX_DISTANCE then
    return nil, "target_too_far"
  end
  local ok, result, reason = pcall(search, engine,
    {x=pos.x, y=pos.y, z=pos.z}, {x=target.x, y=target.y, z=target.z}, bound, max_scan, step)
  if not ok then return nil, "engine_error" end
  return result, reason
end

return M

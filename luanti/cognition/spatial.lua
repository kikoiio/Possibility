-- Lua 5.1; callers upsert a fresh position immediately after every move.
local M = {}

local function finite(n)
  return type(n) == "number" and n == n and n ~= math.huge and n ~= -math.huge
end

local function position(pos)
  assert(type(pos) == "table" and finite(pos.x) and finite(pos.y) and finite(pos.z),
    "invalid position")
  return pos.x, pos.y, pos.z
end

-- Probe small ranges directly. For large/sparse ranges, visit occupied coordinates
-- instead of walking an unbounded volume of empty cells (or non-incrementable doubles).
local function in_range(cells, lo, hi, visit)
  if hi - lo <= 32 and lo > -2^53 and hi < 2^53 then
    for coordinate = lo, hi do
      local child = cells[coordinate]
      if child then visit(child) end
    end
  else
    for coordinate, child in pairs(cells) do
      if coordinate >= lo and coordinate <= hi then visit(child) end
    end
  end
end

local function inside(entry, x, y, z, radius)
  local dx, dy, dz = math.abs(entry.x - x), math.abs(entry.y - y), math.abs(entry.z - z)
  if dx > radius or dy > radius or dz > radius then return false end
  if radius == 0 then return true end
  local r2 = radius * radius
  if r2 >= 2.2250738585072014e-308 and r2 < math.huge then
    return dx * dx + dy * dy + dz * dz <= r2
  end
  -- Scaling avoids false matches from squared overflow or subnormal underflow.
  dx, dy, dz = dx / radius, dy / radius, dz / radius
  return dx * dx + dy * dy + dz * dz <= 1
end

function M.new(cell_size)
  assert(finite(cell_size) and cell_size > 0, "invalid cell size")
  local cells, entries = {}, {}
  local index = {}

  local function unlink(entry)
    local ys = cells[entry.cx]
    local zs = ys[entry.cy]
    local bucket = zs[entry.cz]
    bucket[entry.id] = nil
    if not next(bucket) then zs[entry.cz] = nil end
    if not next(zs) then ys[entry.cy] = nil end
    if not next(ys) then cells[entry.cx] = nil end
  end

  function index:upsert(id, object, pos)
    assert(finite(id), "invalid numeric ID")
    assert(object ~= nil, "object required")
    local x, y, z = position(pos)
    local cx, cy, cz = math.floor(x / cell_size), math.floor(y / cell_size), math.floor(z / cell_size)
    local entry = entries[id]
    if entry and (entry.cx ~= cx or entry.cy ~= cy or entry.cz ~= cz) then
      unlink(entry)
    end
    if not entry then
      entry = {id = id}
      entries[id] = entry
    end
    entry.object, entry.x, entry.y, entry.z = object, x, y, z
    entry.cx, entry.cy, entry.cz = cx, cy, cz
    local ys = cells[cx]
    if not ys then ys = {}; cells[cx] = ys end
    local zs = ys[cy]
    if not zs then zs = {}; ys[cy] = zs end
    local bucket = zs[cz]
    if not bucket then bucket = {}; zs[cz] = bucket end
    bucket[id] = entry
  end

  function index:remove(id)
    assert(finite(id), "invalid numeric ID")
    local entry = entries[id]
    if not entry then return false end
    unlink(entry)
    entries[id] = nil
    return true
  end

  function index:query(pos, radius)
    local x, y, z = position(pos)
    assert(finite(radius) and radius >= 0, "invalid radius")
    local matches = {}
    local xmin, xmax = math.floor((x - radius) / cell_size), math.floor((x + radius) / cell_size)
    local ymin, ymax = math.floor((y - radius) / cell_size), math.floor((y + radius) / cell_size)
    local zmin, zmax = math.floor((z - radius) / cell_size), math.floor((z + radius) / cell_size)
    in_range(cells, xmin, xmax, function(ys)
      in_range(ys, ymin, ymax, function(zs)
        in_range(zs, zmin, zmax, function(bucket)
          for _, entry in pairs(bucket) do
            if inside(entry, x, y, z, radius) then matches[#matches + 1] = entry end
          end
        end)
      end)
    end)
    table.sort(matches, function(a, b) return a.id < b.id end)
    local objects = {}
    for i, entry in ipairs(matches) do objects[i] = entry.object end
    return objects
  end

  return index
end

return M

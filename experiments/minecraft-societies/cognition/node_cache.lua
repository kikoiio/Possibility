-- Experimental world has no external writers. Every mod mutation invalidates a cell.
local M = {}
function M.new(engine, names, size, capacity)
  assert(size > 0 and size == math.floor(size) and capacity > 0)
  local cells, count, stamp, hits, misses = {}, 0, 0, 0, 0
  local function key(x, y, z) return x .. ':' .. y .. ':' .. z end
  local function cell(x, y, z)
    local k = key(x, y, z)
    stamp = stamp + 1
    if cells[k] then
      cells[k].stamp = stamp
      hits = hits + 1
      return cells[k].nodes
    end
    misses = misses + 1
    if count >= capacity then
      local oldest, age
      for id, value in pairs(cells) do
        if not age or value.stamp < age then oldest, age = id, value.stamp end
      end
      cells[oldest], count = nil, count - 1
    end
    local lo = {x=x*size,y=y*size,z=z*size}
    local loaded = engine.get_node_or_nil(lo)
    local complete = loaded and loaded.name ~= "ignore"
    local nodes = {}
    for _, p in ipairs(engine.find_nodes_in_area(
        lo, {x=(x+1)*size-1,y=(y+1)*size-1,z=(z+1)*size-1}, names)) do
      local n = engine.get_node_or_nil(p)
      if n and n.name ~= "ignore" then
        nodes[#nodes+1] = {pos={x=p.x,y=p.y,z=p.z}, name=n.name}
      else complete = false end
    end
    if complete then cells[k], count = {nodes=nodes,stamp=stamp}, count + 1 end
    return nodes
  end
  local cache = {}
  function cache:invalidate(p)
    local k = key(math.floor(p.x/size),math.floor(p.y/size),math.floor(p.z/size))
    if cells[k] then cells[k], count = nil, count - 1 end
  end
  function cache:find(lo, hi, wanted)
    local allowed, result = {}, {}
    for _, name in ipairs(wanted) do allowed[name] = true end
    for x=math.floor(lo.x/size),math.floor(hi.x/size) do
      for y=math.floor(lo.y/size),math.floor(hi.y/size) do
        for z=math.floor(lo.z/size),math.floor(hi.z/size) do
          for _, n in ipairs(cell(x,y,z)) do
            local p = n.pos
            if allowed[n.name] and p.x>=lo.x and p.x<=hi.x and p.y>=lo.y and p.y<=hi.y and p.z>=lo.z and p.z<=hi.z then
              result[#result+1] = {x=p.x,y=p.y,z=p.z}
            end
          end
        end
      end
    end
    return result
  end
  function cache:stats() return {hits=hits,misses=misses,cells=count} end
  return cache
end
return M

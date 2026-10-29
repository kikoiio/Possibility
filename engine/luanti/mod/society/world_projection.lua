-- Pure bounded spatial projection, not wired into init.lua or real Luanti.
-- Input is the caller-authenticated genesis.world_create persistent manifest:
-- {format='wispiva-world-manifest', version=1, world_id, origin_event_id,
-- public={places, semantic_connections, actors, objects?}}. Places/actors use genesis.compiler's
-- public fields (anchor, space; actor_id, ordinal, place_id, position). Objects
-- are {id, place_id, position, node}; supported interactive nodes are listed below.
-- Private goals/memories are never copied. The caller must verify this manifest
-- against the committed origin, authenticate/authorize it, and hold exclusive
-- world access with readers frozen throughout application and recovery.
--
-- Adapter contract (plain functions, no implicit self): binding() returns
-- {world_id, origin_event_id}; read(op) returns false for KNOWN empty, an exact
-- op.value for already projected, or nil for unknown/unloaded/uninspectable.
-- For node ops empty means air WITH no metadata/timer/inventory; ignore is unknown.
-- For actor ops inspect the durable actor_id registry, not just nearby entities;
-- absence is empty only when proven. write(op) places a node or durably upserts
-- an actor with its stable key. Reads must reflect actual state including any
-- metadata, timers, inventories or actor movement; never return a cached receipt.
-- An op with value=false only checks clearance and never writes/clears terrain.
-- This module does not register nodes/entities, emerge terrain or start Luanti.
-- There is no cross-store transaction: errors may leave a known partial prefix.
-- Retry the SAME origin while frozen; unknown or divergent state requires review.
local M = {}
local interactive = {['default:chest'] = true, ['default:furnace'] = true}

local function check(ok, message)
  assert(ok, 'world projection: ' .. message)
end
local function integer(v, low, high)
  return type(v) == 'number' and v == math.floor(v) and v >= low and v <= high
end
local function id(v)
  return type(v) == 'string' and #v <= 80 and v:match('^[%w_-]+$') ~= nil
end
local function uuid(v)
  return type(v) == 'string' and #v == 36
    and v:match('^%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$')
    and v == v:lower()
end
local function array(t, limit)
  check(type(t) == 'table', 'array required')
  local n = 0
  for k in pairs(t) do
    check(integer(k, 1, limit), 'invalid array index'); n = n + 1
  end
  for i = 1, n do check(t[i] ~= nil, 'sparse array') end
  return n
end
local function position(p)
  check(type(p) == 'table' and integer(p.x, -64, 64)
    and integer(p.z, -64, 64) and p.y == 1, 'invalid position')
  return {x=p.x, y=p.y, z=p.z}
end
local function point(x, y, z) return {x=x, y=y, z=z} end
local function key(p) return p.x .. ',' .. p.y .. ',' .. p.z end
local function equal(a, b)
  if type(a) ~= type(b) then return false end
  if type(a) ~= 'table' then return a == b end
  for k, v in pairs(a) do if not equal(v, b[k]) then return false end end
  for k in pairs(b) do if a[k] == nil then return false end end
  return true
end
local function copy(v)
  if type(v) ~= 'table' then return v end
  local out = {}; for k, item in pairs(v) do out[k] = copy(item) end
  return out
end

function M.plan(manifest)
  check(type(manifest) == 'table' and manifest.format == 'wispiva-world-manifest' and manifest.version == 1
    and uuid(manifest.world_id) and id(manifest.origin_event_id), 'invalid origin binding')
  local view = manifest.public
  check(type(view) == 'table', 'public spatial view required')
  local objects = view.objects
  if objects == nil then objects = {} end -- Current compiler has no objects yet.
  local places, ordered, nodes, actors, occupied = {}, {}, {}, {}, {}
  check(array(view.places, 16) > 0, 'no places')
  array(view.semantic_connections, 64); array(view.actors, 16); array(objects, 64)
  local function node(p, name)
    nodes[key(p)] = {kind='node', key='node:' .. key(p), position=p,
      value=name and {name=name, param2=0} or false}
  end
  for _, place in ipairs(view.places) do
    check(type(place) == 'table' and id(place.id) and not places[place.id], 'duplicate/invalid place')
    check(place.space == 'indoor' or place.space == 'outdoor', 'unsupported space')
    local p = position(place.anchor)
    local radius = place.space == 'indoor' and 3 or 2
    for _, other in ipairs(ordered) do
      check(math.abs(p.x-other.anchor.x) > radius+other.radius
        or math.abs(p.z-other.anchor.z) > radius+other.radius, 'overlapping places')
    end
    local item = {id=place.id, anchor=p, radius=radius, space=place.space}
    places[place.id] = item; ordered[#ordered+1] = item
  end
  table.sort(ordered, function(a,b) return a.id < b.id end)
  for _, place in ipairs(ordered) do
    local p, r = place.anchor, place.radius
    for x = p.x-r, p.x+r do
      for z = p.z-r, p.z+r do
        node(point(x,0,z), place.space == 'indoor' and 'default:wood' or 'default:dirt_with_grass')
        for y = 1, 3 do
          local wall = place.space == 'indoor' and (math.abs(x-p.x)==r or math.abs(z-p.z)==r)
          node(point(x,y,z), wall and 'default:wood' or nil)
        end
        if place.space == 'indoor' then node(point(x,4,z), 'default:wood') end
      end
    end
  end
  local connections, seen, path_cells = {}, {}, {}
  for _, c in ipairs(view.semantic_connections) do
    check(type(c) == 'table' and places[c.from] and places[c.to] and c.from ~= c.to,
      'invalid connection')
    local a, b = c.from, c.to
    if b < a then a,b = b,a end
    check(not seen[a .. ':' .. b], 'duplicate connection')
    seen[a .. ':' .. b] = true; connections[#connections+1] = {from=a, to=b}
  end
  table.sort(connections, function(a,b) return a.from .. ':' .. a.to < b.from .. ':' .. b.to end)
  for _, c in ipairs(connections) do
    local a,b = places[c.from].anchor, places[c.to].anchor
    local function path(x,z)
      for _, other in ipairs(ordered) do
        check(other.id == c.from or other.id == c.to
          or math.abs(x-other.anchor.x) > other.radius
          or math.abs(z-other.anchor.z) > other.radius, 'path crosses unrelated place')
      end
      node(point(x,0,z), 'default:stone')
      path_cells[key(point(x,1,z))] = true
      for y=1,3 do node(point(x,y,z), nil) end
    end
    local x,z = a.x,a.z
    path(x,z)
    while x ~= b.x do x=x+(x < b.x and 1 or -1); path(x,z) end
    while z ~= b.z do z=z+(z < b.z and 1 or -1); path(x,z) end
  end
  local function interior(place_id, p)
    local place = places[place_id]
    check(place and math.abs(p.x-place.anchor.x) <= 2
      and math.abs(p.z-place.anchor.z) <= 2, 'start/object outside place interior')
    check(not occupied[key(p)], 'start/object collision'); occupied[key(p)] = true
  end
  local actor_ids, ordinals = {}, {}
  for _, actor in ipairs(view.actors) do
    check(type(actor) == 'table' and id(actor.actor_id) and not actor_ids[actor.actor_id]
      and integer(actor.ordinal,0,#view.actors-1) and not ordinals[actor.ordinal], 'invalid actor identity')
    actor_ids[actor.actor_id], ordinals[actor.ordinal] = true,true
    local p = position(actor.position); interior(actor.place_id, p)
    actors[#actors+1] = {kind='actor', key='actor:' .. actor.actor_id,
      value={actor_id=actor.actor_id, ordinal=actor.ordinal, place_id=actor.place_id, position=p}}
  end
  local object_ids = {}
  for _, object in ipairs(objects) do
    check(type(object) == 'table' and id(object.id) and not object_ids[object.id]
      and interactive[object.node], 'invalid interactive object')
    object_ids[object.id] = true
    local p = position(object.position); interior(object.place_id, p)
    check(not path_cells[key(p)], 'object blocks connection')
    -- Object ids are retained in the operation for the adapter's interaction map.
    node(p, object.node)
    nodes[key(p)].object_id = object.id
    nodes[key(p)].place_id = object.place_id
    -- The adapter must verify the durable interaction binding as well as the
    -- node. Seeing a chest alone cannot prove this origin object was installed.
    nodes[key(p)].value.object_id = object.id
    nodes[key(p)].value.place_id = object.place_id
  end
  local operations = {}
  for _, op in pairs(nodes) do operations[#operations+1] = op end
  table.sort(operations, function(a,b) return a.key < b.key end)
  table.sort(actors, function(a,b) return a.key < b.key end)
  for _, op in ipairs(actors) do operations[#operations+1] = op end
  return {world_id=manifest.world_id, origin_event_id=manifest.origin_event_id,
    operations=operations}
end

function M.apply(manifest, adapter)
  local plan = M.plan(manifest) -- Recompile rather than trust a mutable caller plan.
  check(type(adapter) == 'table' and type(adapter.binding) == 'function'
    and type(adapter.read) == 'function' and type(adapter.write) == 'function', 'invalid adapter')
  local function bound()
    local binding = adapter.binding()
    check(type(binding) == 'table' and binding.world_id == plan.world_id
      and binding.origin_event_id == plan.origin_event_id, 'adapter binding mismatch')
  end
  local function read(op)
    local actual = adapter.read(copy(op))
    check(actual ~= nil, 'unknown state at ' .. op.key)
    check(actual == false or equal(actual, op.value), 'conflicting state at ' .. op.key)
    return actual
  end
  bound()
  -- Preflight the entire area (including air clearance) before the first write.
  for _, op in ipairs(plan.operations) do read(op) end
  local writes = 0
  for _, op in ipairs(plan.operations) do
    bound()
    if read(op) == false and op.value ~= false then
      adapter.write(copy(op))
      check(equal(adapter.read(copy(op)), op.value), 'write verification failed at ' .. op.key)
      writes = writes + 1
    end
  end
  bound()
  for _, op in ipairs(plan.operations) do
    check(equal(adapter.read(copy(op)), op.value), 'final verification failed at ' .. op.key)
  end
  return {writes=writes, world_id=plan.world_id, origin_event_id=plan.origin_event_id}
end

return M

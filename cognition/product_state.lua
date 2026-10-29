-- Lua 5.1 product-world commit marker.
-- Luanti's map database, mod storage and entity checkpoint are separate stores.
-- This records a durable prepare/commit boundary so an interrupted write is
-- detected on the next start and the world is frozen instead of guessed.
local M = {}
local COMPONENTS = {'map', 'actors', 'inventory', 'events', 'memory', 'environment'}
local PHASES = {READY = true, PREPARING = true, FROZEN = true}

local function copy(value)
  if type(value) ~= 'table' then return value end
  local result = {}
  for key, item in pairs(value) do result[key] = copy(item) end
  return result
end
local function text(value, name)
  assert(type(value) == 'string' and value ~= '' and #value <= 256, name .. ' must be text')
end
local function integer(value, name)
  assert(type(value) == 'number' and value == math.floor(value) and value >= 0,
    name .. ' must be a nonnegative integer')
end
local function components(value)
  assert(type(value) == 'table', 'components must be an object')
  local result = {}
  for _, name in ipairs(COMPONENTS) do integer(value[name], 'component ' .. name); result[name] = value[name] end
  for name in pairs(value) do
    local known = false
    for _, expected in ipairs(COMPONENTS) do if name == expected then known = true end end
    assert(known, 'unknown component ' .. tostring(name))
  end
  return result
end
local function same_components(a, b)
  for _, name in ipairs(COMPONENTS) do if a[name] ~= b[name] then return false end end
  return true
end
local function validate(value)
  assert(type(value) == 'table' and value.format == 'wispiva-product-state' and value.version == 1,
    'unsupported product state')
  text(value.world_id, 'world_id'); text(value.origin_event_id, 'origin_event_id')
  assert(PHASES[value.phase], 'invalid product state phase')
  integer(value.commit_version, 'commit_version')
  local result = {format=value.format, version=value.version, world_id=value.world_id,
    origin_event_id=value.origin_event_id, phase=value.phase, commit_version=value.commit_version,
    components=components(value.components)}
  if value.pending ~= nil then
    assert(type(value.pending) == 'table', 'invalid pending commit')
    text(value.pending.operation_id, 'pending operation_id')
    integer(value.pending.base_version, 'pending base_version')
    assert(value.pending.base_version == value.commit_version, 'pending base version mismatch')
    result.pending = {operation_id=value.pending.operation_id, base_version=value.pending.base_version,
      target=components(value.pending.target)}
  end
  if value.freeze_reason ~= nil then text(value.freeze_reason, 'freeze_reason'); result.freeze_reason=value.freeze_reason end
  assert(value.phase ~= 'PREPARING' or result.pending ~= nil, 'preparing state requires pending')
  assert(value.phase ~= 'READY' or result.pending == nil, 'ready state cannot have pending')
  return result
end
local function make(world_id, origin_event_id)
  text(world_id, 'world_id'); text(origin_event_id, 'origin_event_id')
  return validate({format='wispiva-product-state', version=1, world_id=world_id,
    origin_event_id=origin_event_id, phase='READY', commit_version=0,
    components={map=0, actors=0, inventory=0, events=0, memory=0, environment=0}})
end
local function methods(value)
  local state = {}
  function state:export() return copy(value) end
  function state:phase() return value.phase end
  function state:components() return copy(value.components) end
  function state:version() return value.commit_version end
  function state:pending() return copy(value.pending) end
  function state:freeze(reason)
    text(reason, 'freeze reason'); value.phase, value.freeze_reason, value.pending = 'FROZEN', reason, nil
    return self:export()
  end
  function state:assert_ready()
    assert(value.phase == 'READY' and value.pending == nil, 'product world is not ready')
    return true
  end
  function state:prepare(operation_id, target)
    text(operation_id, 'operation_id'); assert(value.phase == 'READY' and value.pending == nil, 'product state is not ready')
    value.phase, value.pending, value.freeze_reason = 'PREPARING',
      {operation_id=operation_id, base_version=value.commit_version, target=components(target)}, nil
    return self:export()
  end
  function state:commit(operation_id, target)
    text(operation_id, 'operation_id')
    assert(value.phase == 'PREPARING' and value.pending and value.pending.operation_id == operation_id,
      'pending product commit mismatch')
    local desired = components(target)
    assert(same_components(value.pending.target, desired), 'commit target differs from prepared target')
    value.components, value.commit_version = desired, value.commit_version + 1
    value.phase, value.pending = 'READY', nil
    return self:export()
  end
  return state
end
function M.new(world_id, origin_event_id) return methods(make(world_id, origin_event_id)) end
function M.load(snapshot) return methods(validate(snapshot)) end
return M

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
local function clock(value)
  if value == nil then return nil end
  assert(type(value) == 'table' and value.version == 1, 'invalid product clock')
  integer(value.logical_time, 'clock logical_time')
  integer(value.engine_time, 'clock engine_time')
  integer(value.saved_wall_time, 'clock saved_wall_time')
  local result = {version=1, logical_time=value.logical_time, engine_time=value.engine_time,
    saved_wall_time=value.saved_wall_time}
  -- Optional v1 extensions: do not fill defaults into legacy checkpoints.
  if value.fraction ~= nil then
    assert(type(value.fraction) == 'number' and value.fraction == value.fraction
      and value.fraction >= 0 and value.fraction < 1, 'invalid clock fraction')
    result.fraction = value.fraction
  end
  if value.rate ~= nil then
    assert(type(value.rate) == 'number' and value.rate == value.rate
      and value.rate >= 0 and value.rate <= 1000, 'invalid clock rate')
    result.rate = value.rate
  end
  if value.paused ~= nil then
    assert(type(value.paused) == 'boolean', 'invalid clock paused')
    result.paused = value.paused
  end
  return result
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
  if value.last_operation_id ~= nil then
    text(value.last_operation_id, 'last_operation_id')
    assert(value.last_target ~= nil, 'last operation target required')
    result.last_operation_id, result.last_target = value.last_operation_id, components(value.last_target)
  elseif value.last_target ~= nil then
    error('last operation target without operation id')
  end
  result.clock = clock(value.clock)
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
  function state:clock() return copy(value.clock) end
  function state:set_clock(next_clock)
    assert(value.phase ~= 'FROZEN', 'cannot update a frozen product state')
    value.clock = clock(next_clock)
    return self:export()
  end
  function state:freeze(reason)
    text(reason, 'freeze reason')
    if value.phase == 'FROZEN' then
      assert(value.freeze_reason == reason, 'frozen product state reason mismatch')
      return self:export()
    end
    value.phase, value.freeze_reason = 'FROZEN', reason
    -- Keep pending operation evidence. Recovery must inspect the exact
    -- operation and target; dropping it would make the boundary unauditable.
    return self:export()
  end
  function state:assert_ready()
    assert(value.phase == 'READY' and value.pending == nil, 'product world is not ready')
    return true
  end
  function state:prepare(operation_id, target)
    text(operation_id, 'operation_id')
    local desired = components(target)
    if value.phase == 'READY' and value.last_operation_id == operation_id then
      assert(same_components(value.last_target, desired), 'prepared operation target conflict')
      return self:export()
    end
    assert(value.phase == 'READY' and value.pending == nil, 'product state is not ready')
    for _, name in ipairs(COMPONENTS) do
      assert(desired[name] >= value.components[name], 'product component cannot regress: ' .. name)
    end
    value.phase, value.pending, value.freeze_reason = 'PREPARING',
      {operation_id=operation_id, base_version=value.commit_version, target=desired}, nil
    return self:export()
  end
  function state:commit(operation_id, target)
    text(operation_id, 'operation_id')
    local desired = components(target)
    if value.phase == 'READY' and value.last_operation_id == operation_id then
      assert(same_components(value.last_target, desired), 'committed operation target conflict')
      return self:export()
    end
    assert(value.phase == 'PREPARING' and value.pending and value.pending.operation_id == operation_id,
      'pending product commit mismatch')
    assert(same_components(value.pending.target, desired), 'commit target differs from prepared target')
    value.components, value.commit_version = desired, value.commit_version + 1
    value.phase, value.pending, value.last_operation_id, value.last_target = 'READY', nil, operation_id, desired
    return self:export()
  end
  return state
end
function M.new(world_id, origin_event_id) return methods(make(world_id, origin_event_id)) end
function M.load(snapshot) return methods(validate(snapshot)) end
return M

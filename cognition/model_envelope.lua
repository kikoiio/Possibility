-- Lua 5.1 model-input projection.  The executor still owns final action
-- validation; this module makes the model's knowledge boundary explicit.
local M = {}
local KINDS = {fact=true, experience=true, rumor=true, unknown=true}
local SCOPES = {public=true, private=true, direct=true, system=true}
local STATUSES = {succeeded=true, failed=true, rejected=true, stale=true, unknown=true}

local function copy(value)
  if type(value) ~= 'table' then return value end
  local result = {}; for key, item in pairs(value) do result[key] = copy(item) end; return result
end
local function text(value, name)
  assert(type(value) == 'string' and value ~= '' and #value <= 4096, name .. ' must be bounded text')
end
local function finite(value)
  return type(value) == 'number' and value == value and value ~= math.huge and value ~= -math.huge
end
local function integer(value, name)
  assert(finite(value) and value == math.floor(value) and value >= 0, 'invalid ' .. name)
  return value
end
local function array(value, name, max)
  assert(type(value) == 'table', name .. ' must be an array')
  local count, highest = 0, 0
  for key in pairs(value) do
    assert(type(key) == 'number' and key >= 1 and key == math.floor(key), name .. ' must be dense')
    count, highest = count + 1, math.max(highest, key)
  end
  assert(count == highest and count <= max, name .. ' exceeds budget')
  return count
end
local function unique_strings(value, name, required)
  array(value, name, 64)
  local seen = {}
  for _, item in ipairs(value) do
    text(item, name .. ' member')
    assert(not seen[item], name .. ' contains duplicate')
    seen[item] = true
  end
  if required then assert(seen[required], name .. ' does not include actor') end
  return copy(value)
end
local function audience(value, actor_id)
  value = value or {actor_id}
  assert(#value > 0, 'audience required')
  return unique_strings(value, 'audience', actor_id)
end
local function source(value)
  assert(type(value) == 'table', 'source required')
  text(value.kind, 'source kind'); text(value.id, 'source id')
  if value.revision ~= nil then integer(value.revision, 'source revision') end
  return {kind=value.kind, id=value.id, revision=value.revision}
end
local function item(value, actor_id, kind)
  assert(type(value) == 'table', 'knowledge item required')
  text(value.id, 'knowledge id'); text(value.text, 'knowledge text')
  assert(KINDS[kind], 'invalid knowledge kind')
  local access = value.access or {}
  local scope = access.scope or value.scope or 'private'
  local supplied_audience = access.audience or value.audience
  assert(SCOPES[scope], 'invalid knowledge scope')
  if value.captured_at ~= nil then assert(finite(value.captured_at), 'invalid captured_at') end
  return {id=value.id, text=value.text, source=source(value.source),
    access={scope=scope, audience=audience(supplied_audience, actor_id)},
    captured_at=value.captured_at, epistemic=kind}
end
local function add(list, values, actor_id, kind, max, seen)
  values = values or {}; assert(type(values) == 'table' and #values <= max, 'knowledge budget exceeded')
  array(values, kind .. ' records', max)
  for _, value in ipairs(values) do
    local record = item(value, actor_id, kind)
    assert(not seen[record.id], 'duplicate knowledge id')
    seen[record.id] = true
    list[#list + 1] = record
  end
end

local function permissions(value)
  assert(type(value) == 'table', 'permissions required')
  assert(type(value.read_scopes) == 'table' and type(value.allowed_actions) == 'table',
    'permissions must list scopes and actions')
  return {read_scopes=unique_strings(value.read_scopes, 'read_scopes'),
    allowed_actions=unique_strings(value.allowed_actions, 'allowed_actions')}
end

local function feedback(value)
  assert(type(value) == 'table' and type(value.available) == 'boolean', 'invalid feedback')
  if not value.available then return {available=false} end
  text(value.attempt_id, 'feedback attempt_id')
  assert(type(value.requested) == 'table', 'feedback requested action required')
  text(value.requested.kind, 'feedback action kind')
  assert(STATUSES[value.status], 'invalid feedback status')
  text(value.reason, 'feedback reason'); text(value.event_id, 'feedback event_id')
  assert(finite(value.observed_at), 'invalid feedback observed_at')
  integer(value.world_revision, 'feedback world revision')
  return copy(value)
end

function M.build(input)
  assert(type(input) == 'table', 'model input required')
  text(input.world_id, 'world_id'); text(input.actor_id, 'actor_id'); text(input.decision_id, 'decision_id')
  text(input.origin_event_id, 'origin_event_id'); integer(input.world_revision or 0, 'world revision')
  assert(finite(input.observed_at or 0), 'invalid observed_at')
  local actor = input.actor or {}
  text(actor.name, 'actor name'); text(actor.role, 'actor role'); text(actor.goal, 'actor goal')
  if input.runtime_id ~= nil then integer(input.runtime_id, 'runtime id') end
  local knowledge = {facts={}, experiences={}, rumors={}, unknowns={}}
  local seen = {}
  add(knowledge.facts, input.facts, input.actor_id, 'fact', 32, seen)
  add(knowledge.experiences, input.experiences, input.actor_id, 'experience', 32, seen)
  add(knowledge.rumors, input.rumors, input.actor_id, 'rumor', 32, seen)
  add(knowledge.unknowns, input.unknowns, input.actor_id, 'unknown', 32, seen)
  local envelope = {
    schema='wispiva.model-input', version=1,
    request={decision_id=input.decision_id, world_id=input.world_id, actor_id=input.actor_id,
      origin_event_id=input.origin_event_id, world_revision=input.world_revision or 0, observed_at=input.observed_at or 0},
    actor={id=input.actor_id, runtime_id=input.runtime_id, name=actor.name, role={text=actor.role, source=source(actor.role_source)},
      goal={text=actor.goal, source=source(actor.goal_source)}, permissions=permissions(input.permissions)},
    knowledge=knowledge,
    current={observation=copy(input.observation or {}), inventory=copy(input.inventory or {}), affordances=copy(input.affordances or {})},
    feedback=feedback(input.feedback or {available=false}),
  }
  M.validate(envelope)
  return envelope
end

function M.validate(value)
  assert(type(value) == 'table' and value.schema == 'wispiva.model-input' and value.version == 1, 'invalid model envelope')
  assert(type(value.request) == 'table' and type(value.actor) == 'table' and type(value.knowledge) == 'table'
    and type(value.current) == 'table', 'invalid model envelope sections')
  local request = value.request
  text(request.decision_id, 'decision_id'); text(request.world_id, 'world_id'); text(request.actor_id, 'actor_id')
  text(request.origin_event_id, 'origin_event_id'); integer(request.world_revision, 'world revision')
  assert(finite(request.observed_at), 'invalid observed_at')
  assert(value.actor.id == request.actor_id, 'actor binding mismatch')
  text(value.actor.id, 'actor id'); text(value.actor.name, 'actor name')
  assert(value.actor.runtime_id == nil or finite(value.actor.runtime_id), 'invalid runtime id')
  for _, field in ipairs({'role', 'goal'}) do
    assert(type(value.actor[field]) == 'table', 'actor ' .. field .. ' required')
    text(value.actor[field].text, 'actor ' .. field)
    source(value.actor[field].source)
  end
  permissions(value.actor.permissions)
  local epistemic = {facts='fact', experiences='experience', rumors='rumor', unknowns='unknown'}
  local seen = {}
  for _, kind in ipairs({'facts', 'experiences', 'rumors', 'unknowns'}) do
    assert(type(value.knowledge[kind]) == 'table', 'invalid knowledge section')
    array(value.knowledge[kind], kind .. ' records', 32)
    for _, record in ipairs(value.knowledge[kind]) do
      assert(record.epistemic == epistemic[kind], 'knowledge kind mismatch')
      local projected = item(record, request.actor_id, epistemic[kind])
      assert(not seen[projected.id], 'duplicate knowledge id')
      seen[projected.id] = true
    end
  end
  assert(type(value.current.observation) == 'table' and type(value.current.inventory) == 'table'
    and type(value.current.affordances) == 'table', 'invalid current state')
  feedback(value.feedback)
  return true
end

return M

-- Lua 5.1 model-input projection.  The executor still owns final action
-- validation; this module makes the model's knowledge boundary explicit.
local M = {}
local KINDS = {fact=true, experience=true, rumor=true, unknown=true}

local function copy(value)
  if type(value) ~= 'table' then return value end
  local result = {}; for key, item in pairs(value) do result[key] = copy(item) end; return result
end
local function text(value, name)
  assert(type(value) == 'string' and value ~= '', name .. ' must be nonempty text')
end
local function audience(value, actor_id)
  value = value or {actor_id}
  assert(type(value) == 'table' and #value > 0, 'audience required')
  local found = false
  for _, item in ipairs(value) do text(item, 'audience member'); if item == actor_id then found = true end end
  assert(found, 'knowledge is not addressed to actor')
  return copy(value)
end
local function source(value)
  assert(type(value) == 'table', 'source required'); text(value.kind, 'source kind'); text(value.id, 'source id')
  return {kind=value.kind, id=value.id, revision=value.revision}
end
local function item(value, actor_id, kind)
  assert(type(value) == 'table', 'knowledge item required'); text(value.id, 'knowledge id'); text(value.text, 'knowledge text')
  assert(KINDS[kind], 'invalid knowledge kind')
  return {id=value.id, text=value.text, source=source(value.source), access={scope=value.scope or 'private', audience=audience(value.audience, actor_id)},
    captured_at=value.captured_at, epistemic=kind}
end
local function add(list, values, actor_id, kind, max)
  values = values or {}; assert(type(values) == 'table' and #values <= max, 'knowledge budget exceeded')
  for _, value in ipairs(values) do list[#list + 1] = item(value, actor_id, kind) end
end

function M.build(input)
  assert(type(input) == 'table', 'model input required')
  text(input.world_id, 'world_id'); text(input.actor_id, 'actor_id'); text(input.decision_id, 'decision_id')
  text(input.origin_event_id, 'origin_event_id')
  local actor = input.actor or {}; text(actor.name, 'actor name'); text(actor.role, 'actor role'); text(actor.goal, 'actor goal')
  local knowledge = {facts={}, experiences={}, rumors={}, unknowns={}}
  add(knowledge.facts, input.facts, input.actor_id, 'fact', 32)
  add(knowledge.experiences, input.experiences, input.actor_id, 'experience', 32)
  add(knowledge.rumors, input.rumors, input.actor_id, 'rumor', 32)
  add(knowledge.unknowns, input.unknowns, input.actor_id, 'unknown', 32)
  local envelope = {
    schema='wispiva.model-input', version=1,
    request={decision_id=input.decision_id, world_id=input.world_id, actor_id=input.actor_id,
      origin_event_id=input.origin_event_id, world_revision=input.world_revision, observed_at=input.observed_at},
    actor={id=input.actor_id, runtime_id=input.runtime_id, name=actor.name, role={text=actor.role, source=source(actor.role_source)},
      goal={text=actor.goal, source=source(actor.goal_source)}, permissions=copy(input.permissions or {})},
    knowledge=knowledge,
    current={observation=copy(input.observation or {}), inventory=copy(input.inventory or {}), affordances=copy(input.affordances or {})},
    feedback=copy(input.feedback or {available=false}),
  }
  return envelope
end

function M.validate(value)
  assert(type(value) == 'table' and value.schema == 'wispiva.model-input' and value.version == 1, 'invalid model envelope')
  assert(type(value.request) == 'table' and type(value.actor) == 'table' and type(value.knowledge) == 'table'
    and type(value.current) == 'table', 'invalid model envelope sections')
  local epistemic = {facts='fact', experiences='experience', rumors='rumor', unknowns='unknown'}
  for _, kind in ipairs({'facts', 'experiences', 'rumors', 'unknowns'}) do
    assert(type(value.knowledge[kind]) == 'table', 'invalid knowledge section')
    for _, record in ipairs(value.knowledge[kind]) do assert(record.epistemic == epistemic[kind], 'knowledge kind mismatch') end
  end
  return true
end

return M

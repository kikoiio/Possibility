-- Lua 5.1 append-only world fact journal.
-- The host must authenticate the actor and provide the real execution result.
-- commit() is idempotent by operation_id so a retry cannot create a second
-- world fact for the same action attempt.
local M = {}

local MAX_EVENTS = 1000000

local function finite(n)
  return type(n) == "number" and n == n and n ~= math.huge and n ~= -math.huge
end

local function required(value, name)
  assert(type(value) == "string" and value ~= "", name .. " must be nonempty")
end

local function copy(value)
  if type(value) ~= "table" then return value end
  local result = {}
  for key, item in pairs(value) do result[key] = copy(item) end
  return result
end

local function equal(left, right)
  if type(left) ~= type(right) then return false end
  if type(left) ~= "table" then return left == right end
  for key, value in pairs(left) do
    if not equal(value, right[key]) then return false end
  end
  for key in pairs(right) do
    if left[key] == nil then return false end
  end
  return true
end

local function array(value)
  assert(type(value) == "table", "expected array")
  local count, max = 0, 0
  for key in pairs(value) do
    assert(type(key) == "number" and key >= 1 and key == math.floor(key), "invalid array key")
    count, max = count + 1, math.max(max, key)
  end
  assert(count == max, "sparse array")
  return count
end

local function point(value)
  if value == nil then return nil end
  assert(type(value) == "table" and finite(value.x) and finite(value.y) and finite(value.z),
    "invalid event point")
  return {x = value.x, y = value.y, z = value.z}
end

local function participants(value)
  value = value or {}
  local result = {}
  for i = 1, array(value) do required(value[i], "participant") ; result[i] = value[i] end
  return result
end

local function validate(event, expected_seq)
  assert(type(event) == "table", "invalid world event")
  assert(event.id == "world-event:" .. tostring(event.seq), "invalid event id")
  assert(event.operation_id and type(event.operation_id) == "string" and event.operation_id ~= "",
    "invalid operation id")
  assert(type(event.seq) == "number" and event.seq == expected_seq, "invalid event sequence")
  assert(finite(event.time), "invalid event time")
  required(event.kind, "event kind")
  required(event.actor, "event actor")
  assert(type(event.ok) == "boolean", "invalid event result")
  required(event.reason, "event reason")
  assert(event.detail == nil or type(event.detail) == "string", "invalid event detail")
  point(event.point)
  participants(event.participants)
end

local function build(initial)
  local events, by_operation = {}, {}
  if initial then
    for i = 1, array(initial) do
      local event = copy(initial[i])
      validate(event, i)
      assert(not by_operation[event.operation_id], "duplicate event operation")
      events[i], by_operation[event.operation_id] = event, event
    end
  end

  local store = {}
  function store:commit(operation_id, data)
    required(operation_id, "operation id")
    local prior = by_operation[operation_id]
    if prior then
      local candidate = copy(data)
      candidate.seq, candidate.id, candidate.operation_id = prior.seq, prior.id, operation_id
      validate(candidate, prior.seq)
      assert(equal(prior, candidate), "idempotent operation differs")
      return copy(prior)
    end
    assert(#events < MAX_EVENTS, "world event limit reached")
    assert(type(data) == "table", "event data required")
    local event = copy(data)
    event.seq = #events + 1
    event.id = "world-event:" .. tostring(event.seq)
    event.operation_id = operation_id
    validate(event, event.seq)
    events[#events + 1], by_operation[operation_id] = event, event
    return copy(event)
  end

  function store:get(id)
    required(id, "event id")
    local seq = tonumber(id:match("^world%-event:(%d+)$"))
    assert(seq and seq >= 1 and seq <= #events and seq == math.floor(seq), "unknown event id")
    return copy(events[seq])
  end

  function store:count() return #events end
  function store:export() return {version = 1, events = copy(events)} end
  return store
end

function M.new() return build() end

function M.load(snapshot)
  assert(type(snapshot) == "table" and snapshot.version == 1, "unsupported world event snapshot")
  assert(array(snapshot.events) >= 0, "invalid world event snapshot")
  return build(snapshot.events)
end

return M

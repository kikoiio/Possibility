-- Lua 5.1, engine-independent bounded resource process. No wall clock or I/O.
-- new{id, resource, capacity, amount, rate, time}: integer units per logical
-- tick; positive rate regenerates, negative rate depletes. Values and times
-- are bounded to 2147483647. advance(time) returns interval summaries, not
-- exact threshold-crossing times; unchanged amounts produce no event.
-- set_conditions(time, {rate = n}) settles the OLD rate through time before
-- installing the new one. Call at the actual change boundary, never backdate.
-- export()/load() copy JSON-safe snapshots including time and event sequence.
-- id must uniquely name this process within the host's event journal; retain
-- it across restores and use a new id for an independently created process.
-- The host must persist state and returned events together for crash-safe
-- delivery. This module neither commits events nor updates Luanti nodes.
local M = {}
local MAX = 2147483647

local function integer(value, low, high)
  assert(type(value) == "number" and value == value and value >= low
    and value <= high and value == math.floor(value), "invalid integer")
  return value
end

local function name(value)
  assert(type(value) == "string" and value ~= "", "nonempty name required")
  return value
end

local function normalise(s)
  assert(type(s) == "table" and s.version == 1, "unsupported environment snapshot")
  local capacity = integer(s.capacity, 0, MAX)
  return {version = 1, id = name(s.id), resource = name(s.resource),
    capacity = capacity, amount = integer(s.amount, 0, capacity),
    rate = integer(s.rate, -MAX, MAX), time = integer(s.time, 0, MAX),
    sequence = integer(s.sequence, 0, MAX)}
end

local function build(initial)
  local state = normalise(initial)
  local process = {}

  function process:export() return normalise(state) end

  function process:advance(time)
    integer(time, state.time, MAX)
    local before, after = state.amount, state.amount
    local elapsed = time - state.time
    if state.rate > 0 then
      -- Clip before multiplying: even very large time jumps stay exact.
      local room = state.capacity - before
      after = elapsed >= room / state.rate and state.capacity
        or before + elapsed * state.rate
    elseif state.rate < 0 then
      local loss = -state.rate
      after = elapsed >= before / loss and 0 or before - elapsed * loss
    end
    local results = {}
    if after ~= before then
      assert(state.sequence < MAX, "environment event sequence exhausted")
      local sequence = state.sequence + 1
      results[1] = {
        operation_id = "environment:" .. state.id .. ":" .. tostring(sequence),
        actor = "environment:" .. state.id, time = time, from_time = state.time,
        kind = after > before and "resource_regenerated" or "resource_depleted",
        ok = true, reason = "logical_time", resource = state.resource,
        before = before, after = after, delta = after - before, rate = state.rate,
      }
      state.sequence = sequence
    end
    state.amount, state.time = after, time
    return results
  end

  function process:set_conditions(time, conditions)
    assert(type(conditions) == "table", "conditions required")
    -- Reject malformed conditions before advance can mutate any state.
    local rate = integer(conditions.rate, -MAX, MAX)
    for key in pairs(conditions) do assert(key == "rate", "unknown condition") end
    local results = self:advance(time)
    state.rate = rate
    return results
  end

  return process
end

function M.new(options)
  assert(type(options) == "table", "environment options required")
  return build({version = 1, id = options.id, resource = options.resource,
    capacity = options.capacity, amount = options.amount, rate = options.rate,
    time = options.time, sequence = 0})
end

function M.load(snapshot) return build(snapshot) end

return M

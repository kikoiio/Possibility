-- Pure Lua 5.1 logical clock; no engine, wall clock, I/O or hidden backlog.
-- new({rate=24, paused=false, logical_time=0, fraction=0}); all options optional.
-- load/export use {version=1, logical_time, fraction, rate, paused} copies.
-- advance(dtime, blocked=false) returns logical_time, fraction. dtime must be
-- finite and in [0,60]; larger intervals are rejected, NOT capped or queued.
-- The host must discard wall-time gaps and must not retry blocked intervals
-- or replay rejected intervals as catch-up. Only an explicit unblocked call
-- advances time. Pause, block and rate=0 preserve the existing fraction.
-- Integer ticks are bounded to 2147483647, matching the environment process.
-- Invalid calls (including overflow) leave the clock unchanged.
local M = {}
local MAX_TIME = 2147483647

local function finite(value)
  return type(value) == "number" and value == value
    and value ~= math.huge and value ~= -math.huge
end

local function rate(value)
  assert(finite(value) and value >= 0 and value <= 1000, "invalid clock rate")
  return value
end

local function normalise(value)
  assert(type(value) == "table" and value.version == 1, "unsupported clock snapshot")
  for key in pairs(value) do
    assert(key == "version" or key == "logical_time" or key == "fraction"
      or key == "rate" or key == "paused", "unknown clock field")
  end
  assert(finite(value.logical_time) and value.logical_time >= 0
    and value.logical_time <= MAX_TIME and value.logical_time == math.floor(value.logical_time),
    "invalid logical time")
  assert(finite(value.fraction) and value.fraction >= 0 and value.fraction < 1,
    "invalid clock fraction")
  assert(type(value.paused) == "boolean", "invalid clock pause state")
  return {version=1, logical_time=value.logical_time, fraction=value.fraction,
    rate=rate(value.rate), paused=value.paused}
end

local function build(initial)
  local state = normalise(initial)
  local clock = {}

  function clock:export() return normalise(state) end

  function clock:advance(dtime, blocked)
    assert(finite(dtime) and dtime >= 0 and dtime <= 60, "invalid clock dtime")
    assert(blocked == nil or type(blocked) == "boolean", "invalid clock blocked state")
    if not state.paused and not blocked and state.rate > 0 then
      -- Keep sub-ticks separate from the integer cursor to retain precision.
      local elapsed = state.fraction + dtime * state.rate
      local ticks = math.floor(elapsed)
      assert(ticks <= MAX_TIME - state.logical_time, "logical clock exhausted")
      state.logical_time, state.fraction = state.logical_time + ticks, elapsed - ticks
    end
    return state.logical_time, state.fraction
  end

  function clock:pause() state.paused = true end
  function clock:resume() state.paused = false end
  function clock:set_rate(value) state.rate = rate(value) end

  return clock
end

function M.new(options)
  if options == nil then options = {} end
  assert(type(options) == "table", "clock options required")
  for key in pairs(options) do
    assert(key == "logical_time" or key == "fraction" or key == "rate"
      or key == "paused", "unknown clock option")
  end
  local function default(key, value)
    if options[key] ~= nil then return options[key] end
    return value
  end
  return build({version=1, logical_time=default("logical_time", 0),
    fraction=default("fraction", 0), rate=default("rate", 24),
    paused=default("paused", false)})
end

function M.load(snapshot) return build(snapshot) end

return M

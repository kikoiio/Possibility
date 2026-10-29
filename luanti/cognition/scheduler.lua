-- Stable round ordering, bounded work per callback, no catch-up loop.
local M = {}
function M.new(o)
  assert(o.count >= 1 and o.interval_us > 0 and o.budget_us > 0)
  local due, cursor, started, cpu, round = o.clock()+o.interval_us, nil, nil, 0, 0
  local s = {}
  function s:step()
    local frame = o.clock()
    if not cursor then
      if frame < due then return false end
      cursor, started, cpu = 0, frame, 0
    end
    repeat
      o.visit(cursor)
      cursor = cursor + 1
      if cursor == o.count then
        local now = o.clock()
        cpu = cpu + now - frame
        round = round + 1
        o.on_round(round, now-started, cpu)
        due, cursor = math.max(now, started+o.interval_us), nil
        return true
      end
    until o.clock()-frame >= o.budget_us
    cpu = cpu + o.clock()-frame
    return false
  end
  return s
end
return M

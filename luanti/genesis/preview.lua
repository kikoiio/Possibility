-- Disposable preview manifest validation and per-actor projection; no engine globals.
local M = {}
local function array(t)
  assert(type(t) == 'table', 'invalid array')
  local n, max = 0, 0
  for k in pairs(t) do
    assert(type(k) == 'number' and k >= 1 and k == math.floor(k), 'invalid array key')
    n = n + 1; max = math.max(max, k)
  end
  assert(n == max, 'sparse array'); return n
end
local function text(v)
  return type(v) == 'string' and #v > 0 and #v <= 2000 and not v:find('[%z\1-\31]')
end
function M.validate(doc, count)
  assert(type(doc) == 'table' and doc.format == 'genesis-disposable-preview' and doc.version == 1, 'invalid preview')
  assert(type(doc.draft_id) == 'string' and doc.draft_id:match('^[a-f0-9]+$') and #doc.draft_id == 32, 'invalid draft id')
  assert(type(doc.revision) == 'number' and doc.revision >= 1 and doc.revision == math.floor(doc.revision), 'invalid revision')
  assert(type(count) == 'number' and count >= 1 and count <= 5 and array(doc.actors) == count, 'invalid count')
  local ids, positions, result = {}, {}, {}
  for i = 1, count do
    local a = doc.actors[i]
    assert(type(a) == 'table' and type(a.id) == 'string' and #a.id <= 40 and a.id:match('^[a-z][a-z0-9_-]*$') and not ids[a.id], 'invalid actor id')
    ids[a.id] = true
    assert(a.ordinal == i - 1 and text(a.name) and text(a.role) and text(a.goal), 'invalid actor')
    local p = a.position
    assert(type(p) == 'table' and type(p.x) == 'number' and type(p.z) == 'number' and p.y == 1
      and p.x == math.floor(p.x) and p.z == math.floor(p.z) and math.abs(p.x) <= 32 and math.abs(p.z) <= 32, 'invalid position')
    local key = p.x .. ',' .. p.z
    assert(not positions[key], 'position collision'); positions[key] = true
    local memories = {}
    local n = array(a.memory_seeds)
    assert(n <= 8, 'too many seeds')
    for j = 1, n do assert(text(a.memory_seeds[j]), 'invalid seed'); memories[j] = a.memory_seeds[j] end
    result[i] = {id = a.id, ordinal = a.ordinal, name = a.name,
      position = {x = p.x, y = p.y, z = p.z}, role = a.role, goal = a.goal, memory_seeds = memories}
  end
  return result
end
function M.deliver(sender, recipient, message, now)
  if not recipient or not recipient.object or not recipient.object:get_pos() then
    return false, 'recipient-gone'
  end
  recipient._inbox[#recipient._inbox + 1] = {time = now, from = sender._id, text = message}
  if #recipient._inbox > 8 then table.remove(recipient._inbox, 1) end
  recipient._episodic:add({time = now, text = message, source = {kind = 'agent', id = sender._id}})
  sender._episodic:add({time = now, text = message, source = {kind = 'self', id = sender._id}})
  return true, 'delivered'
end
function M.attach_context(context, actor)
  -- A fresh object is built for the current actor only, never the whole roster.
  local memories = {}
  for i, value in ipairs(actor.memory_seeds) do memories[i] = value end
  context.goal = actor.goal
  context.genesis_profile = {role = actor.role, goal = actor.goal, memory_seeds = memories}
end
return M

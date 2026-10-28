-- Lua 5.1; no storage or engine globals. Snapshots contain only JSON values.
-- snapshot(entity) reads object:get_pos(), _id, _persona, _home, _facing,
-- _target, _rng, _decisions, _marks_placed, _memory and _episodic:list().
-- restore(entity, snapshot, {reset_minds = true}) restores the physical and
-- identity fields, RNG and counters, but clears persona, target and memories.
-- Otherwise it restores all fields. The caller creates the object and episodic
-- memory before restore; episodic capacity is controlled by that caller.
local M = {}

local function finite(n)
  return type(n) == "number" and n == n and n ~= math.huge and n ~= -math.huge
end

local function id_ok(id)
  return (type(id) == "string" and id ~= "") or finite(id)
end

local function point(p, facing)
  assert(type(p) == "table" and finite(p.x) and finite(p.z)
    and (facing or finite(p.y)), "invalid position or facing")
  if facing then return {x = p.x, z = p.z} end
  return {x = p.x, y = p.y, z = p.z}
end

local function counter(n)
  assert(finite(n) and n >= 0 and n == math.floor(n), "invalid counter")
  return n
end

local function array(t)
  assert(type(t) == "table", "expected array")
  local n, max = 0, 0
  for k in pairs(t) do
    assert(type(k) == "number" and k >= 1 and k == math.floor(k), "invalid array key")
    n = n + 1
    if k > max then max = k end
  end
  assert(n == max, "sparse array")
  return n
end

local function episodes(entries)
  entries = entries or {}
  local out = {}
  for i = 1, array(entries) do
    local e = entries[i]
    assert(type(e) == "table" and finite(e.time) and type(e.text) == "string"
      and type(e.source) == "table" and type(e.source.kind) == "string"
      and e.source.kind ~= "" and id_ok(e.source.id), "invalid episode")
    out[i] = {time = e.time, text = e.text,
      source = {kind = e.source.kind, id = e.source.id}}
  end
  return out
end

local function normalise(s)
  assert(type(s) == "table" and s.version == 1, "unsupported snapshot version")
  assert(id_ok(s.id), "invalid id")
  assert(s.persona == nil or type(s.persona) == "string", "invalid persona")
  assert(finite(s.rng) and s.rng >= 0 and s.rng < 2147483648
    and s.rng == math.floor(s.rng), "invalid RNG state")
  assert(type(s.memory) == "table", "invalid rule memory")
  local met, seen = {}, {}
  local stored_met = s.memory.met or {}
  for i = 1, array(stored_met) do
    local id = stored_met[i]
    assert(id_ok(id) and not seen[id], "invalid or duplicate met id")
    seen[id] = true
    met[i] = id
  end
  return {version = 1, id = s.id, pos = point(s.pos), persona = s.persona,
    home = point(s.home), facing = point(s.facing, true),
    target = s.target ~= nil and point(s.target) or nil, rng = s.rng,
    decisions = counter(s.decisions), marks_placed = counter(s.marks_placed),
    memory = {met = met, idle_streak = counter(s.memory.idle_streak)},
    episodic = episodes(s.episodic)}
end

function M.snapshot(entity)
  assert(type(entity) == "table" and entity.object and entity._episodic
    and type(entity._memory) == "table" and type(entity._memory.met) == "table",
    "entity with object and memories required")
  local pos = entity.object:get_pos()
  if not pos then return nil, "entity has no position" end
  local met = {}
  for id, value in pairs(entity._memory.met) do
    assert(id_ok(id) and value == true, "invalid met entry")
    met[#met + 1] = id
  end
  table.sort(met, function(a, b)
    if type(a) ~= type(b) then return type(a) < type(b) end
    return a < b
  end)
  return normalise({version = 1, id = entity._id, pos = pos,
    persona = entity._persona, home = entity._home, facing = entity._facing,
    target = entity._target, rng = entity._rng, decisions = entity._decisions,
    marks_placed = entity._marks_placed,
    memory = {met = met, idle_streak = entity._memory.idle_streak},
    episodic = entity._episodic:list()})
end

function M.restore(entity, snapshot, options)
  assert(type(entity) == "table" and entity.object and entity._episodic,
    "entity with object and episodic memory required")
  options = options or {}
  assert(type(options) == "table" and (options.reset_minds == nil
    or type(options.reset_minds) == "boolean"), "invalid options")
  -- Validate and copy everything before changing the entity.
  local s = normalise(snapshot)
  local met = {}
  if not options.reset_minds then
    for _, id in ipairs(s.memory.met) do met[id] = true end
  end
  entity.object:set_pos(s.pos)
  entity._id, entity._home, entity._facing = s.id, s.home, s.facing
  entity._rng, entity._decisions, entity._marks_placed = s.rng, s.decisions, s.marks_placed
  entity._persona = not options.reset_minds and s.persona or nil
  entity._target = not options.reset_minds and s.target or nil
  entity._memory = {met = met, idle_streak = options.reset_minds and 0 or s.memory.idle_streak}
  entity._episodic:clear()
  if not options.reset_minds then
    for _, entry in ipairs(s.episodic) do entity._episodic:add(entry) end
  end
  return true
end

return M

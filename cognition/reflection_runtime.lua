-- Standalone Lua 5.1 bridge. The host authenticates runtime owner strings;
-- stable actor IDs are used only in the detached provider-facing envelope.
local directory
if minetest and type(minetest.get_modpath) == "function" then
  directory = assert(minetest.get_modpath("society"), "society mod path unavailable") .. "/"
else
  directory = debug.getinfo(1, "S").source:match("^@(.*/)") or "./"
end
local reflection_apply = dofile(directory .. "reflection_apply.lua")
local M = {}

local function finite(value)
  return type(value) == "number" and value == value and value ~= math.huge and value ~= -math.huge
end

local function is_text(value, limit)
  return type(value) == "string" and value ~= "" and (not limit or #value <= limit)
end

local function text(value, name, limit)
  assert(is_text(value, limit), name .. " must be a nonempty string within budget")
end

local function plain(value)
  assert(type(value) == "table" and getmetatable(value) == nil, "expected plain table")
end

local function array(value, limit)
  plain(value)
  local count, max = 0, 0
  for key in pairs(value) do
    assert(type(key) == "number" and key >= 1 and key == math.floor(key), "invalid array key")
    count, max = count + 1, math.max(max, key)
  end
  assert(count == max and count > 0 and count <= limit, "invalid array size")
  return count
end

local function copy(value)
  if type(value) ~= "table" then return value end
  local result = {}
  for key, item in pairs(value) do result[key] = copy(item) end
  return result
end

-- Same conservative JSON accounting as the durable store, including escaping.
local function byte_bound(value)
  if type(value) == "string" then return 2 + 6 * #value end
  if type(value) == "number" then return 32 end
  local bytes = 2
  for key, item in pairs(value) do
    bytes = bytes + 1 + byte_bound(item)
    if type(key) == "string" then bytes = bytes + byte_bound(key) + 1 end
  end
  return bytes
end

local function private(row, owner)
  if row.owner ~= owner or type(row.audience) ~= "table" then return false end
  for _, recipient in ipairs(row.audience) do
    if recipient == owner then return true end
  end
  return false
end

local function source(value)
  if type(value) ~= "table" or not is_text(value.kind, 256) or not is_text(value.id, 256) then
    return nil
  end
  local revision = value.revision
  if revision ~= nil and (not finite(revision) or revision < 0 or
      revision > 9007199254740991 or revision ~= math.floor(revision)) then return nil end
  return {kind=value.kind, id=value.id, revision=revision}
end

function M.request(store, owner, world_id, actor_id, topic)
  assert(type(store) == "table" and type(store.retrieve) == "function", "invalid memory store")
  text(owner, "owner")
  text(world_id, "world_id", 256)
  text(actor_id, "actor_id", 256)
  text(topic, "topic", 256)
  local result = {schema="wispiva.reflection-input", version=1,
    request={world_id=world_id, actor_id=actor_id, topic=topic}, experiences={}}
  -- Retrieve enough candidates to filter out newer L2 and genesis/unknown rows.
  -- The topic is a reflection prompt, not a mandatory substring of an experience.
  local rows = store:retrieve(owner, {query="", max_scan=128, max_entries=128, max_bytes=10000})
  local bytes, seen = byte_bound(result), {}
  for _, row in ipairs(rows) do
    if row.layer == "L1" and private(row, owner) and
        (row.classification == "experience" or row.classification == "rumor") and
        is_text(row.id, 256) and is_text(row.text, 4096) and finite(row.time) and not seen[row.id] then
      local provenance = source(row.source)
      if provenance then
        local projected = {id=row.id, text=row.text, source=provenance,
          captured_at=row.time, audience={actor_id}}
        local cost = 1 + byte_bound(projected)
        if bytes + cost <= 10000 then
          result.experiences[#result.experiences + 1] = projected
          bytes, seen[row.id] = bytes + cost, true
          if #result.experiences == 8 then break end
        end
      end
    end
  end
  if #result.experiences == 0 then return nil end
  return result
end

-- The host retains the request it sent, rather than trusting a provider echo.
-- All proposal validation precedes the single store:reflect write.
function M.apply(store, owner, request, proposal, time, producer_id)
  text(owner, "owner")
  plain(request)
  assert(request.schema == "wispiva.reflection-input" and request.version == 1,
    "unsupported reflection request")
  plain(request.request)
  text(request.request.world_id, "world_id", 256)
  text(request.request.actor_id, "actor_id", 256)
  text(request.request.topic, "topic", 256)
  array(request.experiences, 8)
  local allowed = {}
  for _, row in ipairs(request.experiences) do
    plain(row)
    text(row.id, "experience id", 256)
    assert(not allowed[row.id], "duplicate request experience")
    allowed[row.id] = true
  end
  plain(proposal)
  for key in pairs(proposal) do
    assert(key == "topic" or key == "text" or key == "source_ids", "unknown proposal field")
  end
  text(proposal.topic, "topic", 256)
  assert(proposal.topic == request.request.topic, "reflection topic mismatch")
  text(proposal.text, "reflection text", 4096)
  array(proposal.source_ids, 8)
  local ids, seen = {}, {}
  for index, id in ipairs(proposal.source_ids) do
    text(id, "source id", 256)
    assert(not seen[id], "duplicate source id")
    assert(allowed[id], "source id was not selected")
    ids[index], seen[id] = id, true
  end
  -- Give the writer its own proposal so provider-owned tables cannot be retained.
  return reflection_apply.apply(store, owner,
    {topic=proposal.topic, text=proposal.text, source_ids=ids}, time, producer_id)
end

-- Separate from FIFO experience selection, so L2 has an independent context slot.
-- Rows remain durable records; the caller projects them into model beliefs.
function M.beliefs(store, owner)
  assert(type(store) == "table" and type(store.retrieve) == "function", "invalid memory store")
  text(owner, "owner")
  local rows = store:retrieve(owner, {query="", max_scan=128, max_entries=128, max_bytes=32768})
  local result, topics, bytes = {}, {}, 0
  for _, row in ipairs(rows) do
    if row.layer == "L2" and private(row, owner) and is_text(row.topic) and not topics[row.topic] then
      -- Never substitute an older version if the latest version exceeds budget.
      topics[row.topic] = true
      if is_text(row.text) and bytes + #row.text <= 4096 then
        result[#result + 1], bytes = copy(row), bytes + #row.text
        if #result == 4 then break end
      end
    end
  end
  return result
end

return M

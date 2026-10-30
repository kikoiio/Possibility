-- Apply a provider-validated L2 proposal to the authenticated memory store.
-- Provider transport and actor authentication stay outside this module.
local M = {}

local function required_string(value, name)
  assert(type(value) == "string" and value ~= "", name .. " must be a nonempty string")
end

local function plain(value)
  assert(type(value) == "table" and getmetatable(value) == nil, "expected plain table")
end

local function array(value)
  plain(value)
  local count, max = 0, 0
  for key in pairs(value) do
    assert(type(key) == "number" and key >= 1 and key == math.floor(key), "invalid array key")
    count = count + 1
    max = math.max(max, key)
  end
  assert(count == max and count > 0, "source_ids must be nonempty")
  return count
end

-- `proposal` is the detached result from model.reflection.validate_output.
-- The memory store remains the authority for source ownership and versioning.
function M.apply(store, actor, proposal, time, source_id)
  assert(type(store) == "table" and type(store.reflect) == "function", "invalid memory store")
  required_string(actor, "actor")
  plain(proposal)
  assert(proposal.topic ~= nil and proposal.text ~= nil and proposal.source_ids ~= nil,
    "incomplete reflection proposal")
  for key in pairs(proposal) do
    assert(key == "topic" or key == "text" or key == "source_ids", "unknown proposal field")
  end
  required_string(proposal.topic, "topic")
  required_string(proposal.text, "text")
  array(proposal.source_ids)
  required_string(source_id or "runtime", "source_id")
  local seen = {}
  for _, id in ipairs(proposal.source_ids) do
    required_string(id, "source id")
    assert(not seen[id], "duplicate source id")
    seen[id] = true
  end
  assert(type(time) == "number" and time == time and time ~= math.huge and time ~= -math.huge,
    "invalid reflection time")
  local record = store:reflect(actor, proposal.topic, proposal.source_ids, proposal.text,
    time, source_id or "runtime")
  plain(record)
  assert(record.layer == "L2" and record.owner == actor and record.topic == proposal.topic,
    "memory store returned mismatched reflection")
  assert(type(record.experiences) == "table" and #record.experiences == #proposal.source_ids,
    "memory store returned mismatched sources")
  for index, id in ipairs(proposal.source_ids) do
    assert(record.experiences[index] == id, "memory store reordered reflection sources")
  end
  return record
end

return M

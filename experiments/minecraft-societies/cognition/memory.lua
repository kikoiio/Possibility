-- Per-character, bounded FIFO memory. No engine state or global registry.
local M = {}

local function finite(n)
  return type(n) == "number" and n == n and n ~= math.huge and n ~= -math.huge
end

local function copy(entry)
  return {time = entry.time, text = entry.text,
    source = {kind = entry.source.kind, id = entry.source.id}}
end

function M.new(capacity)
  assert(finite(capacity) and capacity >= 0 and capacity == math.floor(capacity), "capacity must be a nonnegative integer")
  local entries, first, count = {}, 1, 0
  local memory = {}

  function memory:add(entry)
    assert(type(entry) == "table" and finite(entry.time), "memory time must be a finite number")
    assert(type(entry.text) == "string", "memory text must be a string")
    assert(type(entry.source) == "table" and type(entry.source.kind) == "string" and entry.source.kind ~= "", "source kind required")
    local id = entry.source.id
    assert((type(id) == "string" and id ~= "") or finite(id), "source id required")
    if capacity == 0 then return false end
    local index
    if count < capacity then
      index = ((first + count - 1) % capacity) + 1
      count = count + 1
    else
      index = first
      first = (first % capacity) + 1
    end
    entries[index] = copy(entry)
    return true
  end

  function memory:list()
    local result = {}
    for i = 0, count - 1 do
      result[#result + 1] = copy(entries[((first + i - 1) % capacity) + 1])
    end
    return result
  end

  function memory:clear()
    entries, first, count = {}, 1, 0
  end

  function memory:size() return count end
  return memory
end

return M

-- Per-character bounded FIFO storage, with optional lexical retrieval.
local M = {}

local function finite(n)
  return type(n) == "number" and n == n and n ~= math.huge and n ~= -math.huge
end

local function copy(entry)
  return {time = entry.time, text = entry.text,
    source = {kind = entry.source.kind, id = entry.source.id}}
end

local function integer(n, minimum)
  return finite(n) and n >= minimum and n == math.floor(n)
end

local function quote(value)
  return '"' .. value:gsub('[%z\1-\31\\"]', function(c)
    if c == '"' then return '\\"' end
    if c == '\\' then return '\\\\' end
    return string.format('\\u%04x', string.byte(c))
  end) .. '"'
end

local function number(value)
  return string.format("%.17g", value)
end

-- Compact JSON, including provenance and array punctuation. UTF-8 bytes are
-- counted conservatively as characters; no entry is truncated to fit a budget.
local function serialize_entry(entry)
  local id = entry.source.id
  return '{"time":' .. number(entry.time) .. ',"text":' .. quote(entry.text)
    .. ',"source":{"kind":' .. quote(entry.source.kind) .. ',"id":'
    .. (type(id) == "number" and number(id) or quote(id)) .. '}}'
end

function M.serialize(entries)
  local result = {}
  for i, entry in ipairs(entries) do result[i] = serialize_entry(entry) end
  return "[" .. table.concat(result, ",") .. "]"
end

local stop_words = {}
for word in ("a an and are as at be by for from has have i in is it of on or "
  .. "the this to was were what which with"):gmatch("%S+") do stop_words[word] = true end

local function tokens(text)
  local result = {}
  -- Keep entity IDs and UTF-8 words intact; never substring-match ID 2 to 20.
  for token in text:lower():gmatch("[%w_\128-\255]+") do
    if not stop_words[token] then result[token] = true end
  end
  return result
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

  -- Both strategies share storage, output limits, serialization and chronology.
  -- FIFO ranks by insertion recency. Retrieval ranks by lexical/entity overlap,
  -- then fact timestamp and insertion recency. This is not semantic inference.
  function memory:select(query, options)
    assert(type(query) == "string", "query must be a string")
    if options == nil then options = {} end
    assert(type(options) == "table", "options must be a table")
    assert(not (options.mode and options.strategy and options.mode ~= options.strategy),
      "conflicting memory modes")
    local strategy = options.mode or options.strategy or "retrieval"
    assert(strategy == "retrieval" or strategy == "fifo", "unknown memory strategy")
    local max_entries = options.max_entries
    if max_entries == nil then max_entries = capacity end
    local max_chars = options.max_chars
    if max_chars == nil then max_chars = 4096 end
    assert(integer(max_entries, 0), "max_entries must be a nonnegative integer")
    assert(integer(max_chars, 2), "max_chars must be an integer >= 2 (JSON array)")
    local query_tokens, ranked = tokens(query), {}
    for i, entry in ipairs(self:list()) do
      local score = 0
      if strategy == "retrieval" then
        local words = tokens(entry.text)
        for token in pairs(query_tokens) do
          if words[token] then score = score + (tonumber(token) and 4 or 1) end
        end
        local id = tostring(entry.source.id):lower()
        if query_tokens[id] then score = score + 4 end
      end
      ranked[#ranked + 1] = {entry = entry, index = i, score = score,
        serialized = serialize_entry(entry)}
    end
    table.sort(ranked, function(a, b)
      if a.score ~= b.score then return a.score > b.score end
      if strategy == "retrieval" and a.score > 0 and a.entry.time ~= b.entry.time then
        return a.entry.time > b.entry.time
      end
      return a.index > b.index
    end)
    local chosen, chars = {}, 2
    for _, candidate in ipairs(ranked) do
      if #chosen == max_entries then break end
      local cost = #candidate.serialized + (#chosen > 0 and 1 or 0)
      if chars + cost <= max_chars then
        chosen[#chosen + 1] = candidate
        chars = chars + cost
      end
    end
    table.sort(chosen, function(a, b) return a.index < b.index end)
    local result = {}
    for i, candidate in ipairs(chosen) do result[i] = copy(candidate.entry) end
    return result, {chars = chars, entries = #result, serialized = M.serialize(result)}
  end

  function memory:clear()
    entries, first, count = {}, 1, 0
  end

  function memory:size() return count end
  return memory
end

return M

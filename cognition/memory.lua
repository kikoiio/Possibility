-- Per-character bounded FIFO storage, with optional lexical retrieval.
local M = {}

local function finite(n)
  return type(n) == "number" and n == n and n ~= math.huge and n ~= -math.huge
end

local function copy(entry)
  local source = {kind = entry.source.kind, id = entry.source.id}
  if entry.source.revision ~= nil then source.revision = entry.source.revision end
  local result = {time = entry.time, text = entry.text, source = source}
  for _, key in ipairs({"epistemic", "classification", "layer", "owner", "captured_at"}) do
    if entry[key] ~= nil then result[key] = entry[key] end
  end
  if entry.audience ~= nil then
    result.audience = {}
    for i, recipient in ipairs(entry.audience) do result.audience[i] = recipient end
  end
  return result
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
  local source = '{"kind":' .. quote(entry.source.kind) .. ',"id":'
    .. (type(id) == "number" and number(id) or quote(id))
  if entry.source.revision ~= nil then source = source .. ',"revision":' .. number(entry.source.revision) end
  source = source .. '}'
  local result = '{"time":' .. number(entry.time) .. ',"text":' .. quote(entry.text)
    .. ',"source":' .. source
  for _, key in ipairs({"epistemic", "classification", "layer", "owner", "captured_at"}) do
    if entry[key] ~= nil then
      local value = entry[key]
      result = result .. ',"' .. key .. '":' .. (type(value) == "number" and number(value) or quote(value))
    end
  end
  if entry.audience ~= nil then
    local recipients = {}
    for i, recipient in ipairs(entry.audience) do recipients[i] = quote(recipient) end
    result = result .. ',"audience":[' .. table.concat(recipients, ',') .. ']'
  end
  return result .. '}'
end

function M.serialize(entries)
  local result = {}
  for i, entry in ipairs(entries) do result[i] = serialize_entry(entry) end
  return "[" .. table.concat(result, ",") .. "]"
end

local stop_words = {}
for word in ("a an and are as at be by for from has have i in is it of on or "
  .. "the this to was were what which with"):gmatch("%S+") do stop_words[word] = true end

local function next_character(text, index)
  local first = text:byte(index)
  if first < 0x80 then return first, text:sub(index, index), index + 1 end
  local length
  if first >= 0xC2 and first <= 0xDF then length = 2
  elseif first >= 0xE0 and first <= 0xEF then length = 3
  elseif first >= 0xF0 and first <= 0xF4 then length = 4
  else return -1, text:sub(index, index), index + 1 end
  if index + length - 1 > #text then return -1, text:sub(index, index), index + 1 end
  local bytes = {text:byte(index + 1, index + length - 1)}
  for _, byte in ipairs(bytes) do
    if byte < 0x80 or byte > 0xBF then return -1, text:sub(index, index), index + 1 end
  end
  if length == 3 and ((first == 0xE0 and bytes[1] < 0xA0)
      or (first == 0xED and bytes[1] > 0x9F)) then
    return -1, text:sub(index, index), index + 1
  end
  if length == 4 and ((first == 0xF0 and bytes[1] < 0x90)
      or (first == 0xF4 and bytes[1] > 0x8F)) then
    return -1, text:sub(index, index), index + 1
  end
  local codepoint
  if length == 2 then
    codepoint = (first - 0xC0) * 0x40 + bytes[1] - 0x80
  elseif length == 3 then
    codepoint = (first - 0xE0) * 0x1000 + (bytes[1] - 0x80) * 0x40 + bytes[2] - 0x80
  else
    codepoint = (first - 0xF0) * 0x40000 + (bytes[1] - 0x80) * 0x1000
      + (bytes[2] - 0x80) * 0x40 + bytes[3] - 0x80
  end
  return codepoint, text:sub(index, index + length - 1), index + length
end

local function cjk(codepoint)
  return codepoint >= 0x3400 and codepoint <= 0x4DBF
    or codepoint >= 0x4E00 and codepoint <= 0x9FFF
    or codepoint >= 0xF900 and codepoint <= 0xFAFF
    or codepoint >= 0x20000 and codepoint <= 0x3134F
end

local function tokens(text)
  local result = {}
  -- Keep entity IDs and UTF-8 words intact; never substring-match ID 2 to 20.
  for token in text:lower():gmatch("[%w_\128-\255]+") do
    if not stop_words[token] then result[token] = true end
    -- Whole Han runs are too coarse for short Chinese queries. Add adjacent
    -- Han bigrams while keeping whole-token matches for existing behavior.
    local previous, index = nil, 1
    while index <= #token do
      local codepoint, character, next_index = next_character(token, index)
      if cjk(codepoint) then
        if previous then result["CJK2:" .. previous .. character] = true end
        previous = character
      else
        previous = nil
      end
      index = next_index
    end
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
    if entry.source.revision ~= nil then assert(integer(entry.source.revision, 0), "source revision must be a nonnegative integer") end
    for _, key in ipairs({"epistemic", "classification"}) do
      if entry[key] ~= nil then assert(type(entry[key]) == "string" and ({fact=true, experience=true, rumor=true, belief=true, unknown=true})[entry[key]], "invalid " .. key) end
    end
    if entry.layer ~= nil then assert(entry.layer == "L0" or entry.layer == "L1" or entry.layer == "L2", "invalid memory layer") end
    if entry.owner ~= nil then assert(type(entry.owner) == "string" and entry.owner ~= "", "invalid memory owner") end
    if entry.captured_at ~= nil then assert(finite(entry.captured_at), "invalid captured_at") end
    if entry.audience ~= nil then
      assert(type(entry.audience) == "table" and #entry.audience > 0, "invalid memory audience")
      local seen = {}
      for _, recipient in ipairs(entry.audience) do
        assert(type(recipient) == "string" and recipient ~= "" and not seen[recipient], "invalid memory audience")
        seen[recipient] = true
      end
    end
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

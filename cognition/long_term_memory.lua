-- Standalone Lua 5.1 long-term memory. All callers, including the owner
-- argument, must be authenticated by the host; this is not a security sandbox.
-- export() is privileged: it contains all owners and all world events.
local M = {}

local function string_required(s, name)
  assert(type(s) == "string" and s ~= "", name .. " must be a nonempty string")
end

local function finite(n)
  return type(n) == "number" and n == n and n ~= math.huge and n ~= -math.huge
end

local function integer(n, min, max, name)
  assert(finite(n) and n == math.floor(n) and n >= min and n <= max, "invalid " .. name)
end

local function fields(t, allowed)
  assert(type(t) == "table" and getmetatable(t) == nil, "expected plain table")
  for k in pairs(t) do assert(allowed[k], "unknown field: " .. tostring(k)) end
end

local function array(t)
  assert(type(t) == "table" and getmetatable(t) == nil, "expected plain array")
  local count, max = 0, 0
  for k in pairs(t) do
    assert(type(k) == "number" and k >= 1 and k == math.floor(k), "invalid array key")
    count = count + 1
    if k > max then max = k end
  end
  assert(count == max, "sparse array")
  return count
end

local function copy(t)
  if type(t) ~= "table" then return t end
  local result = {}
  for k, v in pairs(t) do result[k] = copy(v) end
  return result
end

-- Conservative JSON byte bound (including escaping, punctuation and keys).
local function byte_bound(value)
  local kind = type(value)
  if kind == "string" then return 2 + 6 * #value end
  if kind == "number" then return 32 end
  local n = 2
  for k, v in pairs(value) do
    n = n + 1 + byte_bound(v)
    if type(k) == "string" then n = n + byte_bound(k) + 1 end
  end
  return n
end

local record_fields = {id=true, owner=true, time=true, text=true, source=true, layer=true,
  topic=true, version=true, experiences=true, classification=true, importance=true}
local source_fields = {kind=true, id=true}
local classifications = {fact=true, rumor=true, belief=true, unknown=true}

local function validate_record(r)
  fields(r, record_fields)
  string_required(r.id, "id")
  string_required(r.owner, "owner")
  assert(finite(r.time), "time must be finite")
  assert(type(r.text) == "string", "text must be a string")
  fields(r.source, source_fields)
  string_required(r.source.kind, "source.kind")
  string_required(r.source.id, "source.id")
  assert(r.layer == "L0" or r.layer == "L1" or r.layer == "L2", "invalid layer")
  if r.importance ~= nil then assert(finite(r.importance), "invalid importance") end
  if r.layer == "L0" then
    assert(r.topic == nil and r.version == nil and r.experiences == nil and r.classification == nil,
      "invalid L0 fields")
  elseif r.layer == "L1" then
    assert(classifications[r.classification], "L1 classification required")
    assert(r.topic == nil and r.version == nil and r.experiences == nil, "invalid L1 fields")
  else
    string_required(r.topic, "topic")
    integer(r.version, 1, 9007199254740991, "version")
    assert(r.classification == nil, "invalid L2 classification")
    assert(array(r.experiences) > 0, "L2 requires L1 sources")
    local seen = {}
    for _, id in ipairs(r.experiences) do
      string_required(id, "experience id")
      assert(not seen[id], "duplicate L1 source")
      seen[id] = true
    end
  end
end

local function build()
  local records, by_id, by_owner, versions = {}, {}, {}, {}
  local store = {}

  local function append(record)
    validate_record(record)
    assert(not by_id[record.id], "duplicate record id")
    if record.layer == "L1" and record.source.kind == "event" then
      local event = by_id[record.source.id]
      assert(event and event.layer == "L0", "unknown L0 event source")
    elseif record.layer == "L2" then
      for _, id in ipairs(record.experiences) do
        local source = by_id[id]
        assert(source and source.layer == "L1" and source.owner == record.owner,
          "L2 sources must be owner's L1 records")
      end
      local topics = versions[record.owner] or {}
      assert(record.version == (topics[record.topic] or 0) + 1, "nonconsecutive L2 version")
    end
    local saved = copy(record)
    records[#records + 1], by_id[saved.id] = saved, saved
    if saved.layer ~= "L0" then
      local own = by_owner[saved.owner] or {}
      by_owner[saved.owner] = own
      own[#own + 1] = saved
    end
    if saved.layer == "L2" then
      local topics = versions[saved.owner] or {}
      versions[saved.owner] = topics
      topics[saved.topic] = saved.version
    end
    return copy(saved)
  end

  -- Append requires layer and all required fields. IDs are globally unique.
  -- L1 source.kind="event" links to L0; other kinds identify external sources.
  -- L2 additionally requires topic, consecutive version, and experiences (L1 IDs).
  function store:append(record) return append(record) end

  -- Privileged snapshot, not a role-facing API. No implicit writes or eviction.
  function store:export() return {version = 1, records = copy(records)} end

  function store:count() return #records end

  -- Runtime bridge: one actual outcome and the participants who experienced it.
  -- The host supplies a recipient only after verified delivery. Other agents
  -- (including nearby observers) do not become witnesses implicitly.
  function store:record_outcome(actor, kind, ok, reason, time, recipient, message, detail, event_id)
    string_required(actor, "actor")
    string_required(kind, "kind")
    assert(type(ok) == "boolean" and finite(time), "invalid outcome")
    string_required(reason, "reason")
    assert(detail == nil or type(detail) == "string", "invalid outcome detail")
    if recipient ~= nil then
      string_required(recipient, "recipient")
      assert(kind == "say" and ok and recipient ~= actor and type(message) == "string", "invalid delivery")
    end
    if event_id ~= nil then string_required(event_id, "event_id") end
    event_id = event_id or ("outcome:" .. tostring(#records + 1))
    assert(not by_id[event_id], "duplicate event id")
    local outcome = kind .. (ok and " succeeded: " or " failed: ") .. reason
    local event_text = "agent " .. actor .. " " .. outcome
    local actor_text = "I " .. outcome
    if detail then event_text, actor_text = event_text .. "; " .. detail, actor_text .. "; " .. detail end
    local recipient_text
    if recipient then
      event_text = event_text .. "; to agent " .. recipient .. ": " .. message
      actor_text = actor_text .. "; to agent " .. recipient .. ": " .. message
      recipient_text = "agent " .. actor .. " said to me: " .. message
    end
    local batch = {
      {layer="L0", id=event_id, owner="world", time=time, text=event_text,
        source={kind="action", id=actor}},
      {layer="L1", id=event_id .. ":actor", owner=actor, time=time, text=actor_text,
        classification="fact", source={kind="event", id=event_id}},
    }
    if recipient_text then
      batch[3] = {layer="L1", id=event_id .. ":recipient", owner=recipient, time=time,
        text=recipient_text, classification="fact", source={kind="event", id=event_id}}
    end
    for _, record in ipairs(batch) do
      validate_record(record)
      assert(not by_id[record.id], "duplicate outcome id")
    end
    for _, record in ipairs(batch) do append(record) end
    return event_id
  end

  function store:record_meeting(actor, other, time, event_id)
    string_required(actor, "actor")
    string_required(other, "other")
    assert(actor ~= other and finite(time), "invalid meeting")
    if event_id ~= nil then string_required(event_id, "event_id") end
    local id = event_id or ("outcome:" .. tostring(#records + 1))
    assert(not by_id[id], "duplicate event id")
    local batch = {
      {layer="L0", id=id, owner="world", time=time,
        text="agent " .. actor .. " met agent " .. other, source={kind="contact", id=actor}},
      {layer="L1", id=id .. ":actor", owner=actor, time=time,
        text="I met agent " .. other, source={kind="event", id=id}, classification="fact"},
      {layer="L1", id=id .. ":recipient", owner=other, time=time,
        text="I met agent " .. actor, source={kind="event", id=id}, classification="fact"},
    }
    for _, record in ipairs(batch) do
      validate_record(record)
      assert(not by_id[record.id], "duplicate outcome id")
    end
    for _, record in ipairs(batch) do append(record) end
    return id
  end

  -- Returns newest-first pages from this owner's private L1/L2 index. cursor is
  -- an exclusive upper index, captured from next_cursor; it remains stable as
  -- new records append. max_scan bounds work, max_entries bounds output.
  -- The caller may supply a plain substring query; empty means all records.
  -- max_bytes bounds conservative JSON encoding size, including the array.
  -- Metadata makes filtering and every budget omission explicit. A page with
  -- omissions can be replayed using the same cursor and a larger budget.
  function store:retrieve(owner, options)
    string_required(owner, "owner")
    fields(options, {cursor=true, max_scan=true, max_entries=true, max_bytes=true, query=true})
    integer(options.max_scan, 1, 10000, "max_scan")
    integer(options.max_entries, 0, 10000, "max_entries")
    integer(options.max_bytes, 2, 10000000, "max_bytes")
    assert(type(options.query) == "string", "query must be a string")
    local own = by_owner[owner] or {}
    local cursor = options.cursor
    if cursor == nil then cursor = #own + 1 end
    integer(cursor, 1, #own + 1, "cursor")
    local result, scanned, matched, omitted, bytes = {}, 0, 0, 0, 2
    local i = cursor - 1
    local query = options.query:lower()
    while i >= 1 and scanned < options.max_scan do
      local record = own[i]
      scanned = scanned + 1
      if query == "" or record.text:lower():find(query, 1, true) then
        matched = matched + 1
        local cost = byte_bound(record) + 1
        if #result < options.max_entries and bytes + cost <= options.max_bytes then
          result[#result + 1] = copy(record)
          bytes = bytes + cost
        else omitted = omitted + 1 end
      end
      i = i - 1
    end
    return result, {scanned = scanned, matched = matched, omitted = omitted, byte_bound = bytes,
      remaining = i, next_cursor = i > 0 and i + 1 or nil,
      scan_limited = i > 0, result_limited = omitted > 0}
  end

  return store
end

function M.new() return build() end

-- Loading validates every record and reference in order before returning a store.
function M.load(snapshot)
  fields(snapshot, {version=true, records=true})
  assert(snapshot.version == 1, "unsupported snapshot version")
  local store = build()
  for i = 1, array(snapshot.records) do store:append(snapshot.records[i]) end
  return store
end

return M

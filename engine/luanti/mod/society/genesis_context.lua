-- Public Genesis facts for role-specific model envelopes.
local M = {}

function M.public_world_fact(manifest, actor_id)
  assert(type(manifest) == 'table' and type(manifest.public) == 'table',
    'public Genesis projection required')
  assert(type(manifest.origin_event_id) == 'string' and manifest.origin_event_id ~= '',
    'Genesis origin required')
  assert(type(actor_id) == 'string' and actor_id ~= '', 'actor id required')
  local title = manifest.public.title
  local description = manifest.public.description
  assert(type(title) == 'string' and title ~= '', 'public world title required')
  if description ~= nil then
    assert(type(description) == 'string', 'public world description must be text')
  else
    description = '' -- Compatibility with manifests created before this projection existed.
  end
  local text = 'World: ' .. title
  if description ~= '' then text = text .. '. ' .. description end
  assert(#text <= 4096, 'public world context exceeds model-input limit')
  return {
    id = 'genesis:world:' .. manifest.origin_event_id,
    text = text,
    source = {kind = 'genesis.public', id = manifest.origin_event_id},
    scope = 'public', audience = {actor_id},
  }
end

return M

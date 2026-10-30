-- lua5.1 engine/luanti/mod/society/test_genesis_context.lua
local context = dofile('engine/luanti/mod/society/genesis_context.lua')
local manifest = {
  origin_event_id = 'genesis:confirmed-1',
  public = {title = 'River Settlement', description = 'Residents share the valley.'},
  actors = {{actor_id = 'alice', goal = 'PRIVATE_GOAL', memory_seeds = {'PRIVATE_SEED'}}},
}
local fact = context.public_world_fact(manifest, 'alice')
assert(fact.id == 'genesis:world:genesis:confirmed-1')
assert(fact.text == 'World: River Settlement. Residents share the valley.')
assert(fact.scope == 'public' and #fact.audience == 1 and fact.audience[1] == 'alice')
assert(fact.source.kind == 'genesis.public' and fact.source.id == manifest.origin_event_id)
assert(not fact.text:find('PRIVATE_GOAL', 1, true))
assert(not fact.text:find('PRIVATE_SEED', 1, true))

-- Old confirmed worlds remain loadable and retain their public title context.
manifest.public.description = nil
local old_fact = context.public_world_fact(manifest, 'bob')
assert(old_fact.text == 'World: River Settlement')
assert(old_fact.audience[1] == 'bob')
print('ok - public Genesis context is shared as a fact and remains actor-scoped')

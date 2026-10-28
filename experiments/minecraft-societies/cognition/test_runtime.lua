local nodes = dofile('node_cache.lua')
local scheduler = dofile('scheduler.lua')
local world, calls = {['-1:1:0']='mark', ['16:1:0']='resource'}, 0
local function k(p) return p.x..':'..p.y..':'..p.z end
local engine = {
  find_nodes_in_area=function(lo,hi,names)
    calls=calls+1
    local result={}
    for key,name in pairs(world) do
      local x,y,z=key:match('([^:]+):([^:]+):([^:]+)')
      x,y,z=tonumber(x),tonumber(y),tonumber(z)
      if x>=lo.x and x<=hi.x and y>=lo.y and y<=hi.y and z>=lo.z and z<=hi.z then
        result[#result+1]={x=x,y=y,z=z}
      end
    end
    return result
  end,
  get_node_or_nil=function(p) return {name=world[k(p)] or 'air'} end,
}
local c=nodes.new(engine,{'mark','resource'},16,4)
local lo,hi={x=-2,y=1,z=0},{x=16,y=1,z=0}
assert(#c:find(lo,hi,{'mark'})==1 and calls==3)
assert(#c:find(lo,hi,{'resource'})==1 and calls==3)
local result=c:find(lo,hi,{'mark'}); result[1].x=99
assert(c:find(lo,hi,{'mark'})[1].x==-1)
world['-1:1:0']=nil; c:invalidate({x=-1,y=1,z=0})
assert(#c:find(lo,hi,{'mark'})==0 and calls==4)
world['0:1:0']='mark'; c:invalidate({x=0,y=1,z=0})
assert(#c:find(lo,hi,{'mark'})==1)
for x=1,10 do c:find({x=x*16,y=1,z=0},{x=x*16,y=1,z=0},{'mark'}) end
assert(c:stats().cells<=4)
assert(#c:find(lo,hi,{'resource'})==1)
local time, seen, rounds = 0, {}, {}
local s=scheduler.new({count=5,interval_us=100,budget_us=10,clock=function() return time end,
  visit=function(id) seen[#seen+1]=id; time=time+6 end,
  on_round=function(n,wall,cpu) rounds[#rounds+1]={n,wall,cpu} end})
assert(not s:step() and #seen==0)
time=100; assert(not s:step() and #seen==2)
time=140; assert(not s:step() and #seen==4)
time=180; assert(s:step() and #seen==5)
assert(rounds[1][2]==86 and rounds[1][3]==30)
time=199; assert(not s:step() and #seen==5)
time=200; s:step(); assert(#seen==7)
time=10000; s:step(); assert(#seen==9)
s:step(); assert(#seen==10 and #rounds==2) -- no second round in same callback
for i,id in ipairs(seen) do assert(id==(i-1)%5) end
print('node cache and scheduler tests passed')

import {validateSceneDocument, islandContains, rectCorners, rectsSeparated, pointInRect, pointSegmentDistance} from './scene-validation.js';
// Placement is a deterministic compiler task. Keep world facts, station points,
// object identity and dimensions; fit display geometry to valid ground/clearance.
export function normalizeWorldScene(definition) {
  const adjustments=[];
  if (definition?.world?.profile!=='generated-world' || definition?.scene?.profile!=='world' || validateSceneDocument(definition.scene).length) return {definition,adjustments};
  const result=structuredClone(definition),scene=result.scene,world=result.world;
  const land=scene.regions.filter(r=>r.kind==='island'),buildings=scene.objects.filter(o=>['house','library','porch'].includes(o.kind)),trees=scene.objects.filter(o=>o.kind==='tree'),paths=scene.objects.filter(o=>o.kind==='path');
  const places=Array.isArray(world.places)?world.places.filter(p=>Array.isArray(p?.position)&&p.position.length===3&&p.position.every(Number.isFinite)):[];
  const unit=scene.style.voxelUnit;
  const attached = new Set();
  for (const building of buildings) for (const link of building.attachments || []) {
    const target = buildings.find(other => other.id === link.target);
    if (target && (building.kind === 'porch' || target.kind === 'porch')) { attached.add(building.id); attached.add(target.id); }
  }
  function* candidates(original) {
    yield [original[0],original[2]];
    // Bounded radial search, closest to the requested placement first.
    for(let radius=1;radius<=64;radius+=1)for(let k=0;k<24;k++){const angle=k*Math.PI/12;yield[original[0]+radius*Math.cos(angle),original[2]+radius*Math.sin(angle)];}
    for(const region of land)yield[...region.center];
  }
  function segmentHits(a,b,object,margin){
    const angle=object.transform.rotation,[ox,,oz]=object.transform.position;
    const local=p=>[(p[0]-ox)*Math.cos(angle)-(p[1]-oz)*Math.sin(angle),(p[0]-ox)*Math.sin(angle)+(p[1]-oz)*Math.cos(angle)];
    const p=local(a),q=local(b),extent=[object.bounds.width/2+margin,object.bounds.depth/2+margin];let lo=0,hi=1;
    for(let i=0;i<2;i++){const delta=q[i]-p[i];if(Math.abs(delta)<1e-9){if(Math.abs(p[i])>extent[i])return false;continue;}const a1=(-extent[i]-p[i])/delta,a2=(extent[i]-p[i])/delta;lo=Math.max(lo,Math.min(a1,a2));hi=Math.min(hi,Math.max(a1,a2));if(lo>hi)return false;}return true;
  }
  const circleHits=(building,x,z,radius)=>{const a=building.transform.rotation,dx=x-building.transform.position[0],dz=z-building.transform.position[2],px=dx*Math.cos(a)-dz*Math.sin(a),pz=dx*Math.sin(a)+dz*Math.cos(a);return Math.hypot(Math.max(0,Math.abs(px)-building.bounds.width/2),Math.max(0,Math.abs(pz)-building.bounds.depth/2))<radius;};
  for(const node of buildings){
    // Connected entrance assemblies must be preserved as a unit. Unsupported
    // invalid assemblies stay invalid rather than being moved apart.
    if(attached.has(node.id))continue;
    const before=[...node.transform.position];let accepted=false;
    for(const [x,z] of candidates(before)){
      node.transform.position=[x,before[1],z];
      const region=land.find(r=>rectCorners(node,Math.max(node.roof?.overhang??.2,.4)).every(([cx,cz])=>islandContains(r,cx,cz,unit)));
      if(!region)continue;
      node.transform.position[1]=region.elevation-node.bounds.floor;
      if(buildings.some(other=>other!==node&&!rectsSeparated(node,other,.6)))continue;
      if(places.some(p=>pointInRect(node,p.position[0],p.position[2],.35)))continue;
      if(paths.some(path=>path.points.slice(1).some((p,i)=>segmentHits(path.points[i],p,node,path.width/2+unit/2))))continue;
      accepted=true;break;
    }
    if(!accepted)node.transform.position=before;
    if(JSON.stringify(node.transform.position)!==JSON.stringify(before))adjustments.push(`建筑 ${node.name||node.id} 已吸附到地面并避让站立点`);
  }
  for(const node of trees){
    const before=[...node.position];let accepted=false;
    for(const [x,z]of candidates(before)){
      const region=land.find(r=>islandContains(r,x,z,3.2*node.scale+unit/2));if(!region)continue;
      if(buildings.some(b=>circleHits(b,x,z,3.2*node.scale+.15)))continue;
      if(trees.some(other=>other!==node&&Math.hypot(x-other.position[0],z-other.position[2])<3.2*(node.scale+other.scale)))continue;
      if(places.some(p=>Math.abs(p.position[1]-region.elevation)<.3&&Math.hypot(x-p.position[0],z-p.position[2])<.4*node.scale+.35))continue;
      if(paths.some(path=>path.points.slice(1).some((p,i)=>pointSegmentDistance(x,z,[path.points[i][0],0,path.points[i][1]],[p[0],0,p[1]])<path.width/2+unit/2+.4*node.scale)))continue;
      node.position=[x,region.elevation,z];accepted=true;break;
    }
    if(!accepted)node.position=before;
    if(JSON.stringify(node.position)!==JSON.stringify(before))adjustments.push(`树木 ${node.name||node.id} 已对齐陆地并避让边缘与通道`);
  }
  return{definition:result,adjustments};
}

// Public schema example and injected observation input only. Never a live fallback.
export const MANSION_DESCRIPTION = '参考《假面山庄》的封闭空间与人物秘密，生成一个原创的山庄当晚片段，暂名“山雨未停”。四位互有旧事的成年人在暴雨山庄过夜，山路暂时封闭。只设会客厅、书房、餐厅、走廊四个相连室内房间，每个房间一个地点；至少两人在会客厅，以便当场交流。人物姓名、关系、私有目标、各自知道的秘密、三到四件可检查线索由你创造。场面从晚饭后开始，尚未有人说话或调查。矛盾围绕一封失踪的旧信与互相冲突的回忆，不预写凶手、死亡或固定结局。每人只知道自己见过的事情，秘密不能写进公共描述。使用开放屋顶的室内剖面、四个room和四个人物，房间无重叠、不加house/tree/path/water；室内中心可站立。资源、持续过程与perform行动均为空，冲突通过移动、检查与说话自然发展。';

export function createMansionFixture() {
  const places=[
    {id:'hall',name:'会客厅',description:'晚饭后的客人停留在这里。',position:[-3.4,.8,3.4],visibleFrom:[],roomId:'room-hall'},
    {id:'study',name:'书房',description:'保管旧文件的安静房间。',position:[-3.4,.8,-3.4],visibleFrom:[],roomId:'room-study'},
    {id:'dining',name:'餐厅',description:'餐桌还没有收拾。',position:[3.4,.8,3.4],visibleFrom:[],roomId:'room-dining'},
    {id:'passage',name:'走廊',description:'四间房之间的过道。',position:[3.4,.8,-3.4],visibleFrom:[],roomId:'room-passage'}
  ];
  const actors=[
    {id:'lin',name:'林岑',role:'山庄主人',goal:'在客人离开前弄清旧信的下落。',background:'家里的一封旧信突然找不到了。',location:'hall',fatigue:12},
    {id:'xu',name:'许遥',role:'旧友',goal:'了解今晚为何邀请自己。',background:'多年没有见过山庄主人。',location:'hall',fatigue:18},
    {id:'wen',name:'温宁',role:'整理员',goal:'弄清文件被移动的原因。',background:'替主人整理过书房。',location:'study',fatigue:10},
    {id:'qiao',name:'乔雨',role:'访客',goal:'保护自己不愿公开的旧事。',background:'收到邀请后从邻镇赶来。',location:'dining',fatigue:20}
  ];
  return {schemaVersion:1,world:{profile:'generated-world',title:'山雨未停',description:'四位旧识困在暴雨中的山庄。晚饭刚结束，旧事尚未被说起。',environment:{weather:'夜间暴雨，山路暂时封闭'},places,actors,resources:[],processes:[],actions:[],story:{
    premise:'一封旧信不见了。客人有各自的打算，尚无人当众提起信件。',
    connections:[{from:'hall',to:'study'},{from:'hall',to:'dining'},{from:'study',to:'passage'},{from:'dining',to:'passage'}],
    facts:[{id:'lin-secret',text:'你把旧信放在书房的蓝色文件夹里，从未告诉许遥。',knownBy:['lin']},{id:'xu-secret',text:'你在晚饭前看到有人把蓝色文件夹带进走廊，没有看清那个人。',knownBy:['xu']},{id:'wen-secret',text:'你只移动了桌上的便签，没有动过蓝色文件夹。',knownBy:['wen']},{id:'qiao-secret',text:'你曾经撕掉一张与自己有关的旧信复印件，原件下落不明。',knownBy:['qiao']}],
    clues:[{id:'folded-note',name:'折叠的便签',location:'hall',detail:'便签写着“原件仍在，不必今晚说”。没有署名。',discoveredBy:[]},{id:'empty-folder',name:'蓝色文件夹',location:'study',detail:'文件夹里有一张空白隔页，靠近折口的地方有新鲜水渍。',discoveredBy:[]},{id:'table-copy',name:'餐桌边的纸片',location:'dining',detail:'纸片上只留下半个日期，与旧信的日期不同。',discoveredBy:[]}],conversations:[]
  }},scene:{schemaVersion:1,profile:'world',id:'rain-mansion',title:'山雨未停 · 室内剖面',style:{palette:'wetland-sage',voxelUnit:.42,seed:91},regions:[{id:'ground',kind:'island',center:[0,0],radius:15,elevation:.8,irregularity:0}],objects:[
    ...places.map(p=>({id:p.roomId,kind:'room',name:p.name,transform:{position:[p.position[0],0,p.position[2]],rotation:0},bounds:{width:6,depth:6,wallHeight:2.8,floor:.8}})),
    ...actors.map(a=>({id:a.id,kind:'character',name:a.name,position:[...places.find(p=>p.id===a.location).position]}))
  ]},initialMemories:actors.map(a=>({actorId:a.id,text:`晚饭刚结束。我留在${places.find(p=>p.id===a.location).name}，还没有开始调查。`}))};
}

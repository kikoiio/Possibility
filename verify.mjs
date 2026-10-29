import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
const here=dirname(fileURLToPath(import.meta.url));const root=here;
const jobs=[
 ...['ui/app.js','ui/scene.js','ui/world-scene.js','ui/voxel-scene.js'].map(file=>['--check',resolve(here,file)]),
 ['--test','--test-isolation=none','--test-concurrency=1',...['tests/geometry.test.mjs','tests/generated-geometry.test.mjs','tests/generated-world.test.mjs','tests/conditional-world.test.mjs','tests/dialogue-flow.test.mjs','tests/red-headed-league.test.mjs','tests/voxel-building.test.mjs','tests/voxel-tools.test.mjs','tests/voxel-world.test.mjs','tests/voxel-parts.test.mjs','tests/voxel-inspection.test.mjs','tests/voxel-dialogue.test.mjs','tests/creation-recovery.test.mjs','tests/creation-interruption.test.mjs','tests/voxel-world-entry.test.mjs'].map(file=>resolve(here,file))],
 ...['tests/observe-world.mjs','tests/observe-experience.mjs','tests/observe-ui.mjs','tests/observe-workshop.mjs','tests/observe-creation.mjs','tests/observe-story.mjs','tests/observe-mansion-flow.mjs','tests/observe-interior.mjs','model/observe-config.mjs','model/observe-client-paths.mjs','model/observe-stream.mjs'].map(file=>[resolve(here,file)])
];
for(const args of jobs){const result=spawnSync(process.execPath,args,{cwd:root,stdio:'inherit'});if(result.error)throw result.error;if(result.status!==0)process.exit(result.status??1);}
console.log('Unified prototype checks passed. No model requests or browser sessions.');

"""Fake-engine persistence across Python process boundaries, not Luanti evidence."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from world.origin_resources import Coordinator
from world.store import WorldStore

WORLD = '12345678-1234-4234-8234-123456789abc'


class FileEngine:
    """Small test fixture whose identity and projection are stored separately."""
    def __init__(self, path):
        self.path = Path(path)

    def read(self): return json.loads(self.path.read_text(encoding='utf-8'))
    def write(self, state): self.path.write_text(json.dumps(state), encoding='utf-8')
    def get_world_id(self): return self.read()['world_id']
    def get_node(self, key): return self.read()['nodes'][key]
    def get_inventory(self, actor): return copy.deepcopy(self.read()['inventories'][actor])
    def set_node(self, key, value):
        state = self.read(); state['nodes'][key] = value; self.write(state)
    def set_inventory(self, actor, value):
        state = self.read(); state['inventories'][actor] = copy.deepcopy(value); self.write(state)


class ProcessRecoveryTests(unittest.TestCase):
    def test_recover_with_fresh_process_and_independent_persisted_projection(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as tmp:
            root = Path(tmp)
            engine_path = root / 'engine.json'
            engine_path.write_text(json.dumps({'world_id': WORLD, 'nodes': {'1,0,0': 'ore'},
                                                'inventories': {'traveler': {}}}), encoding='utf-8')
            db_path = root / 'world.sqlite'
            script = '''
import json, sys
from pathlib import Path
from world.origin import draft_sha256
from world.origin_store import create_origin
from world.origin_resources import Coordinator
from world.store import WorldStore
from world.test_origin_process import FileEngine, WORLD
draft = json.loads(Path('genesis/example.json').read_text(encoding='utf-8'))
ref = {'draft_id': 'draft', 'draft_revision': 1, 'draft_sha256': draft_sha256(draft),
       'operation_id': 'create', 'status': 'confirmed', 'draft': draft}
store = WorldStore(sys.argv[1], create=True)
try:
    engine = FileEngine(sys.argv[2])
    create_origin(store, engine, WORLD, 'create', ref)
    co = Coordinator(store, engine, world_id=WORLD, exclusive=True)
    co.register('register', {'1,0,0':'ore'}, {'1,0,0':'ore'}, {'traveler':{}})
    co.apply('gather', 2, 'gather', '1,0,0', 'traveler')
finally:
    store.close()
'''
            env = dict(os.environ, PYTHONDONTWRITEBYTECODE='1')
            subprocess.run([sys.executable, '-c', script, str(db_path), str(engine_path)],
                           cwd=Path(__file__).parent.parent, env=env, check=True)
            engine = FileEngine(engine_path)
            self.assertEqual(engine.get_node('1,0,0'), 'air')
            self.assertEqual(engine.get_inventory('traveler'), {'ore': 1})
            # Model a persisted projection that lagged the committed database.
            state = engine.read()
            state['nodes']['1,0,0'] = 'ore'; state['inventories']['traveler'] = {}
            engine.write(state)
            reopened = WorldStore(db_path)
            try:
                co = Coordinator(reopened, FileEngine(engine_path), world_id=WORLD, exclusive=True)
                self.assertEqual(co.reconcile(), {'phase': 'READY', 'version': 3})
                self.assertEqual(engine.get_node('1,0,0'), 'air')
                self.assertEqual(engine.get_inventory('traveler'), {'ore': 1})
                self.assertEqual(co.apply('gather', 2, 'gather', '1,0,0', 'traveler')['version'], 3)
                self.assertEqual(reopened.recover()['version'], 3)
            finally:
                reopened.close()


if __name__ == '__main__':
    unittest.main()

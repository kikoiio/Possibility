import ctypes
import ctypes.util
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import sys
import unittest
from unittest.mock import patch

from genesis.preview import launch, prepare_preview
from genesis.preflight import PreflightError
from genesis.store import DraftStore
from genesis.test_compiler import with_actors


class PreviewTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.store = DraftStore(self.root / 'drafts.sqlite', create=True)
        self.preview_root = self.root / 'previews'; self.preview_root.mkdir(mode=0o700)

    def tearDown(self):
        self.store.close(); self.tmp.cleanup()

    def confirm(self, value):
        row = self.store.create(value)
        self.store.confirm(row['id'], 1, self.root / (row['id'] + '.sqlite'))
        return row

    def test_private_unique_worlds_and_no_saved_world_mutation(self):
        row = self.confirm(with_actors(2))
        origin = Path(self.store.read(row['id'])['target']); before = origin.read_bytes()
        one, count = prepare_preview(self.store, row['id'], 1, self.preview_root)
        two, _ = prepare_preview(self.store, row['id'], 1, self.preview_root)
        self.assertNotEqual(one, two); self.assertEqual(count, 2)
        self.assertEqual(one.stat().st_mode & 0o777, 0o700)
        path = one / 'world' / 'private' / 'genesis-preview.json'
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual((one / 'world' / 'private').stat().st_mode & 0o777, 0o700)
        doc = json.loads(path.read_text())
        self.assertEqual([a['ordinal'] for a in doc['actors']], [0, 1])
        self.assertEqual(doc['actors'][0]['memory_seeds'], ['Secret0'])
        self.assertNotIn('Secret1', json.dumps(doc['actors'][0]))
        self.assertEqual(origin.read_bytes(), before)

    def test_require_confirmed_revision_private_root_and_supported_space(self):
        row = self.store.create(with_actors(1))
        with self.assertRaises(PreflightError): prepare_preview(self.store, row['id'], 1, self.preview_root)
        self.store.confirm(row['id'], 1, self.root / 'world.sqlite')
        with self.assertRaises(PreflightError): prepare_preview(self.store, row['id'], 2, self.preview_root)
        self.preview_root.chmod(0o755)
        with self.assertRaises(PreflightError): prepare_preview(self.store, row['id'], 1, self.preview_root)
        self.preview_root.chmod(0o700)
        bad = with_actors(1); bad['rules'] = [{'id': 'rule', 'description': 'required rule'}]
        other = self.confirm(bad)
        with self.assertRaises(PreflightError): prepare_preview(self.store, other['id'], 1, self.preview_root)
        self.assertEqual(list(self.preview_root.iterdir()), [])

    def test_source_permissions_and_retained_private_spool(self):
        row = self.confirm(with_actors(1))
        origin = Path(self.store.read(row['id'])['target'])
        origin.chmod(0o644)
        with self.assertRaises(PreflightError) as e:
            prepare_preview(self.store, row['id'], 1, self.preview_root)
        self.assertEqual(e.exception.code, 'source_not_private')
        origin.chmod(0o600)
        self.store.path.chmod(0o644)
        with self.assertRaises(PreflightError): prepare_preview(self.store, row['id'], 1, self.preview_root)
        self.store.path.chmod(0o600)
        one, _ = prepare_preview(self.store, row['id'], 1, self.preview_root)
        self.assertTrue((one / 'world' / 'private' / 'genesis-preview.json').is_file())
        self.assertTrue(origin.exists())
        self.assertTrue(self.store.path.exists())

    def test_private_temp_files_and_no_secret_in_console(self):
        row = self.confirm(with_actors(1)); world, count = prepare_preview(self.store, row['id'], 1, self.preview_root)
        class Process:
            returncode = None
            def poll(self): return self.returncode
            def terminate(self): self.returncode = -15
            def wait(self, timeout=None): return self.returncode
        calls = []
        def spawn(*args, **kwargs):
            obj = Process(); calls.append(obj)
            if len(calls) == 1:
                # Simulate an engine/worker temporary request under inherited umask.
                (world / 'world' / 'private' / 'model-spool' / '.request.tmp').write_text('Secret0')
                obj.returncode = 1
            return obj
        out, err = io.StringIO(), io.StringIO()
        with patch('genesis.preview.subprocess.Popen', side_effect=spawn), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            self.assertEqual(launch(world, count, engine=Path('/fake'), runtime_home=self.root, libdir=self.root, port=30077, seconds=2, fixture=True), 1)
        temp = world / 'world' / 'private' / 'model-spool' / '.request.tmp'
        self.assertEqual(temp.stat().st_mode & 0o777, 0o600)
        self.assertNotIn('Secret0', out.getvalue() + err.getvalue())
        self.assertEqual(temp.read_text(), 'Secret0')  # retained for owner cleanup
        self.assertTrue((world / 'world' / 'private' / 'genesis-preview.json').exists())

    def test_preview_fixture_emits_real_say_and_move_with_fixture_origin(self):
        model_dir = str(Path('model').resolve())
        sys.path.insert(0, model_dir)
        try:
            from genesis.preview_fixture import fixture_runner
            from model.adapter import _validate_action
            context = {'observation': {'pos': {'x': 0, 'y': 1, 'z': 0},
                       'nearby_agents': [1], 'has_target': False},
                       'bounds': {'min': {'x': -32, 'y': 1, 'z': -32},
                                  'max': {'x': 32, 'y': 1, 'z': 32}}}
            def step():
                result = fixture_runner({'id': 1, 'context': context}, None, 1)
                self.assertEqual(result['action']['why'], 'fixture')
                raw = {k: v for k, v in result['action'].items() if k != 'why'}
                self.assertEqual(_validate_action(json.dumps(raw), context)['kind'], raw['kind'])
                return raw
            said = step(); self.assertEqual(said['kind'], 'say'); self.assertEqual(said['target'], 1)
            context['last_action'] = {'kind': 'say', 'ok': True}
            moved = step(); self.assertEqual(moved['kind'], 'wander'); self.assertEqual(moved['point']['x'], 2)
            context['observation']['has_target'] = True
            self.assertEqual(step()['kind'], 'advance')
        finally:
            sys.path.remove(model_dir)

    def test_real_spool_worker_private_file_lifecycle(self):
        model_dir = str(Path('model').resolve())
        sys.path.insert(0, model_dir)
        try:
            from model import spool_worker
            spool = self.preview_root / 'spool'; spool.mkdir(mode=0o700)
            request = spool / 'request-1.json'
            fd = os.open(request, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(fd, 'w') as handle:
                json.dump({'id': 1, 'context': {'genesis_profile': {'memory_seeds': ['Secret0']}}}, handle)
            def runner(data, stop, timeout):
                self.assertEqual(data['context']['genesis_profile']['memory_seeds'], ['Secret0'])
                return {'id': 1, 'ok': True, 'action': {'kind': 'inspect'}}
            self.assertTrue(spool_worker.process_one(spool, request, 1, runner=runner))
            response = spool / 'response-1.json'
            self.assertEqual(response.stat().st_mode & 0o777, 0o600)
            self.assertFalse(request.exists())
            self.assertFalse((spool / '.processing-1.json').exists())
            self.assertNotIn('Secret0', response.read_text())
            self.assertEqual(list(spool.glob('.response-*.tmp')), [])
        finally:
            sys.path.remove(model_dir)

    def test_seed_limits_reject_without_creating_world(self):
        d = with_actors(1); d['memories'] = [{'actorId': 'person0', 'text': str(i)} for i in range(9)]
        row = self.confirm(d)
        with self.assertRaises(PreflightError) as e: prepare_preview(self.store, row['id'], 1, self.preview_root)
        self.assertEqual(e.exception.code, 'private_profile_too_large')
        self.assertEqual(list(self.preview_root.iterdir()), [])

    def test_worker_failure_terminates_server_and_returns_failure(self):
        row = self.confirm(with_actors(1)); world, count = prepare_preview(self.store, row['id'], 1, self.preview_root)
        class Process:
            def __init__(self, worker): self.worker = worker; self.returncode = 1 if worker else None; self.terminated = False
            def poll(self): return self.returncode
            def terminate(self): self.terminated = True; self.returncode = -15
            def wait(self, timeout=None): return self.returncode
            def kill(self): self.returncode = -9
        calls = []
        def spawn(*args, **kwargs):
            obj = Process(not calls); calls.append(obj); return obj
        with patch('genesis.preview.subprocess.Popen', side_effect=spawn):
            result = launch(world, count, engine=Path('/fake'), runtime_home=self.root, libdir=self.root, port=30077, seconds=2, fixture=True)
        self.assertEqual(result, 1); self.assertTrue(calls[1].terminated)
        conf = (world / 'world' / 'server.conf').read_text()
        self.assertIn('society_persist = false', conf); self.assertIn('society_restore = false', conf); self.assertNotIn('secure.trusted_mods', conf)
        self.assertNotIn('Secret0', conf)
        self.assertFalse((world / 'world' / 'genesis-preview.json').exists())
        self.assertEqual((world / 'world' / 'private' / 'model-spool').stat().st_mode & 0o777, 0o700)
        for item in (world / 'world').rglob('*'):
            if item.is_file() and item.relative_to(world / 'world').parts[0] != 'private':
                self.assertNotIn(b'Secret0', item.read_bytes())

    def test_success_requires_preview_marker_spawn_and_done(self):
        row = self.confirm(with_actors(1)); world, count = prepare_preview(self.store, row['id'], 1, self.preview_root)
        class Process:
            def __init__(self, worker): self.worker = worker; self.returncode = None if worker else 0
            def poll(self): return self.returncode
            def terminate(self): self.returncode = -15
            def wait(self, timeout=None): return self.returncode
            def kill(self): self.returncode = -9
        calls = []
        def spawn(*args, **kwargs):
            worker = not calls
            obj = Process(worker); calls.append(obj)
            if not worker:
                (world / 'world' / 'preview.log').write_text('SOCIETY preview mode=disposable persistent=false terrain=flat connections=none\nSOCIETY check stage=spawn alive=1 expected=1 ok=true\nSOCIETY done result=ok reason=decisions-reached\n')
            return obj
        with patch('genesis.preview.subprocess.Popen', side_effect=spawn):
            self.assertEqual(launch(world, count, engine=Path('/fake'), runtime_home=self.root, libdir=self.root, port=30077, seconds=2, fixture=True), 0)
        self.assertEqual(calls[0].returncode, -15)

    def test_reject_symlink_root_and_duplicate_random_destination(self):
        row = self.confirm(with_actors(1))
        link = self.root / 'link'; link.symlink_to(self.preview_root)
        with self.assertRaises(PreflightError): prepare_preview(self.store, row['id'], 1, link)
        with patch('genesis.preview.uuid.uuid4') as generate:
            generate.return_value.hex = '1' * 32
            first, _ = prepare_preview(self.store, row['id'], 1, self.preview_root)
            original = (first / 'world' / 'private' / 'genesis-preview.json').read_bytes()
            with self.assertRaises(PreflightError): prepare_preview(self.store, row['id'], 1, self.preview_root)
            self.assertEqual((first / 'world' / 'private' / 'genesis-preview.json').read_bytes(), original)


class LuaPreviewTests(unittest.TestCase):
    def test_lua_module_privacy_validation_and_init_syntax(self):
        name = ctypes.util.find_library('lua5.4') or ctypes.util.find_library('lua5.3')
        if not name: self.skipTest('Lua shared library unavailable')
        lua = ctypes.CDLL(name)
        lua.luaL_newstate.restype = ctypes.c_void_p
        lua.luaL_openlibs.argtypes = [ctypes.c_void_p]
        lua.luaL_loadstring.argtypes = [ctypes.c_void_p, ctypes.c_char_p]; lua.luaL_loadstring.restype = ctypes.c_int
        lua.lua_pcallk.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_longlong, ctypes.c_void_p]; lua.lua_pcallk.restype = ctypes.c_int
        lua.lua_tolstring.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]; lua.lua_tolstring.restype = ctypes.c_char_p
        lua.lua_close.argtypes = [ctypes.c_void_p]
        state = lua.luaL_newstate(); lua.luaL_openlibs(state)
        script = r'''
local m = dofile('genesis/preview.lua')
local d = {format='genesis-disposable-preview', version=1, draft_id=string.rep('a',32), revision=1,
 actors={{id='a',ordinal=0,name='A',position={x=0,y=1,z=0},role='ROLE_A',goal='GOAL_A',memory_seeds={'SECRET_A'}},
         {id='b',ordinal=1,name='B',position={x=2,y=1,z=0},role='ROLE_B',goal='GOAL_B',memory_seeds={'SECRET_B'}},
         {id='c',ordinal=2,name='C',position={x=4,y=1,z=0},role='ROLE_C',goal='GOAL_C',memory_seeds={'SECRET_C'}}}}
local a = m.validate(d, 3)
local ctx = {}; m.attach_context(ctx, a[1])
assert(ctx.goal == 'GOAL_A' and ctx.genesis_profile.role == 'ROLE_A' and ctx.genesis_profile.memory_seeds[1] == 'SECRET_A')
assert(ctx.genesis_profile.goal ~= 'GOAL_B' and ctx.genesis_profile.memory_seeds[1] ~= 'SECRET_B')
local function episodic()
  return {items={}, add=function(self, value) self.items[#self.items+1] = value end}
end
local function actor(id)
  return {_id=id, _inbox={}, _episodic=episodic(), object={get_pos=function() return {x=0,y=1,z=0} end}}
end
local sender, receiver, third = actor(0), actor(1), actor(2)
local third_context = {}; m.attach_context(third_context, a[3])
assert(third_context.goal == 'GOAL_C' and third_context.genesis_profile.memory_seeds[1] == 'SECRET_C')
assert(third_context.goal ~= 'GOAL_A' and third_context.genesis_profile.memory_seeds[1] ~= 'SECRET_A')
local recipient_context = {}; m.attach_context(recipient_context, a[2])
assert(recipient_context.goal == 'GOAL_B' and recipient_context.genesis_profile.memory_seeds[1] == 'SECRET_B')
assert(#receiver._inbox == 0 and #third._inbox == 0)
local ok = m.deliver(sender, receiver, 'SECRET_A', 10)
assert(ok and receiver._inbox[1].text == 'SECRET_A' and #third._inbox == 0)
assert(receiver._episodic.items[1].text == 'SECRET_A' and #third._episodic.items == 0)
ctx.genesis_profile.memory_seeds[1] = 'changed'; assert(a[1].memory_seeds[1] == 'SECRET_A')
d.actors[2].position.x = 0; assert(not pcall(m.validate, d, 3))
d.actors[2].position.x = 33; assert(not pcall(m.validate, d, 3))
assert(loadfile('engine/luanti/mod/society/init.lua'))
dofile('genesis/test_preview_runtime.lua')
'''
        try:
            status = lua.luaL_loadstring(state, script.encode())
            if status == 0: status = lua.lua_pcallk(state, 0, 0, 0, 0, None)
            self.assertEqual(status, 0, lua.lua_tolstring(state, -1, None).decode() if status else '')
        finally: lua.lua_close(state)

if __name__ == '__main__': unittest.main()

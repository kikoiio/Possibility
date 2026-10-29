"""One-shot, disposable Luanti preview; never commits or resumes a world."""
from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import time
import uuid

from .preflight import PreflightError, preflight
from .store import DraftStore
from engine.luanti.world_session import WorldSession

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / 'engine' / 'luanti'
COGNITION = ROOT / 'cognition'
GENESIS = ROOT / 'genesis'
MODEL = ROOT / 'model'
MODULES = ('observation.lua', 'memory.lua', 'long_term_memory.lua', 'world_events.lua', 'persistence.lua',
           'resource_actions.lua', 'action_context.lua', 'spatial.lua', 'node_cache.lua', 'scheduler.lua',
           'model_envelope.lua')


def _private_root(path):
    path = Path(path)
    if not path.is_absolute() or path.is_symlink() or not path.is_dir():
        raise PreflightError('invalid_preview_root')
    actual = path.resolve(strict=True)
    info = actual.stat()
    if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise PreflightError('preview_root_not_private')
    if any(ord(c) < 32 for c in str(actual)):
        raise PreflightError('invalid_preview_root')
    return actual


def _private_source(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise PreflightError('source_not_private')
    info = path.stat()
    parent = path.parent.stat()
    if (info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600
        or parent.st_uid != os.geteuid() or stat.S_IMODE(parent.st_mode) & 0o077):
        raise PreflightError('source_not_private')


def prepare_preview(store, draft_id, revision, root):
    """Create one exclusive preview directory; never creates or modifies a saved world."""
    root = _private_root(root)
    _private_source(store.path)
    try:
        row = store.read(draft_id)
    except KeyError:
        raise PreflightError('confirmation_not_found') from None
    if row['status'] != 'confirmed' or type(revision) is not int or row['revision'] != revision:
        raise PreflightError('confirmation_mismatch')
    _private_source(row['target'])
    target = root / ('genesis-preview-' + uuid.uuid4().hex)
    result = preflight(store, draft_id, revision, target)
    plan = result['plan']
    actors = []
    for public in plan['public']['actors']:
        private = plan['private_actors'][public['actor_id']]
        # Keep every seed available in each model request; reject rather than truncate.
        if len(private['memory_seeds']) > 8 or len(json.dumps(private, ensure_ascii=True).encode()) > 4096:
            raise PreflightError('private_profile_too_large')
        actors.append({'id': public['actor_id'], 'ordinal': public['ordinal'], 'name': public['name'],
                       'position': public['position'], 'role': private['role'], 'goal': private['goal'],
                       'memory_seeds': private['memory_seeds']})
    manifest = {'format': 'genesis-disposable-preview', 'version': 1,
                'draft_id': draft_id, 'revision': revision, 'actors': actors}
    if len(json.dumps(manifest, ensure_ascii=True, separators=(',', ':')).encode()) + 1 > 32768:
        raise PreflightError('preview_manifest_too_large')
    try:
        os.mkdir(target, 0o700)
    except FileExistsError:
        raise PreflightError('runtime_path_exists') from None
    # Never remove a directory on failure: it could contain forensic evidence.
    world = target / 'world'
    world.mkdir(mode=0o700)
    # A preview still has a real Luanti world directory. Give it the same
    # durable identity boundary as a persistent world before adding manifests.
    with WorldSession(world, create=True):
        pass
    private = world / 'private'
    private.mkdir(mode=0o700)
    fd = os.open(private / 'genesis-preview.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as file:
        json.dump(manifest, file, ensure_ascii=True, separators=(',', ':'))
        file.write('\n')
    return target, len(actors)


def launch(world, count, *, engine, runtime_home, libdir, port, seconds, fixture):
    """Launch only a newly prepared private preview directory, synchronously."""
    container = world
    world = container / 'world'
    if world.is_symlink() or not world.is_dir():
        raise PreflightError('invalid_preview_world')
    mod = world / 'worldmods' / 'society'
    mod.mkdir(parents=True, exist_ok=False, mode=0o700)
    for source in (ENGINE / 'mod' / 'society').glob('*.lua'):
        shutil.copyfile(source, mod / source.name)
    for name in MODULES:
        shutil.copyfile(COGNITION / name, mod / name)
    shutil.copyfile(GENESIS / 'preview.lua', mod / 'genesis_preview.lua')
    spool = world / 'private' / 'model-spool'
    spool.mkdir(mode=0o700)
    settings = ('bind_address = 127.0.0.1\nport = %d\nmg_name = singlenode\n'
                'server_announce = false\nenable_damage = false\nmax_forceloaded_blocks = -1\n'
                'society_count = %d\nsociety_bound = 32\nsociety_persist = false\n'
                'society_restore = false\nsociety_genesis_preview = true\nsociety_visual = true\n'
                'society_genesis_private_manifest = %s\n'
                'society_model = true\nsociety_cognition = true\nsociety_spool = %s\n') % (port, count, world / 'private' / 'genesis-preview.json', spool)
    (world / 'server.conf').write_text(settings, encoding='utf-8')
    (world / 'world.mt').write_text('gameid = minetest_game\nbackend = sqlite3\nload_mod_society = true\n', encoding='utf-8')
    env = dict(os.environ, HOME=str(runtime_home), LD_LIBRARY_PATH=str(libdir))
    env['PYTHONDONTWRITEBYTECODE'] = '1'
    # Child files, including model spool requests, remain private.
    old_umask = os.umask(0o077)
    worker = None
    try:
        worker_command = ([sys.executable, '-B', str(GENESIS / 'preview_fixture.py'), str(spool)] if fixture
                          else [sys.executable, '-B', str(MODEL / 'spool_worker.py'), str(spool), '--timeout', '45'])
        worker = subprocess.Popen(worker_command, env=env)
        server = subprocess.Popen([
            sys.executable, '-B', str(ENGINE / 'launch.py'), '--world', str(world), '--',
            str(engine), '--config', str(world / 'server.conf'), '--world', str(world),
            '--gameid', 'minetest_game', '--logfile', str(world / 'preview.log')], env=env)
        try:
            deadline = time.monotonic() + seconds
            while server.poll() is None:
                if worker.poll() is not None:
                    print('preview: model worker exited', file=sys.stderr)
                    return 1
                if time.monotonic() >= deadline:
                    print('preview: timeout', file=sys.stderr)
                    return 124
                time.sleep(0.1)
            if server.returncode != 0:
                return server.returncode or 1
            try: log = (world / 'preview.log').read_text(encoding='utf-8', errors='replace')
            except OSError: return 1
            if ('SOCIETY done result=ok' not in log or 'SOCIETY fail=' in log
                or 'SOCIETY preview mode=disposable persistent=false' not in log
                or not re.search(r'SOCIETY check stage=spawn alive=%d expected=%d ok=true\b' % (count, count), log)):
                print('preview: engine liveness verification failed', file=sys.stderr)
                return 1
            return 0
        finally:
            if server.poll() is None:
                server.terminate()
                try: server.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    server.kill(); server.wait()
    finally:
        if worker is not None:
            worker.terminate()
            try: worker.wait(timeout=5)
            except subprocess.TimeoutExpired:
                worker.kill(); worker.wait()
        os.umask(old_umask)


def main(argv=None):
    parser = argparse.ArgumentParser(description='Disposable confirmed-draft preview; not a saved world.')
    parser.add_argument('--draft-db', required=True); parser.add_argument('--draft-id', required=True)
    parser.add_argument('--revision', required=True, type=int); parser.add_argument('--preview-root', required=True)
    parser.add_argument('--fixture', action='store_true', help='use deterministic fake model')
    parser.add_argument('--seconds', type=int, default=180); parser.add_argument('--port', type=int, default=30077)
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535 or not 1 <= args.seconds <= 3600:
        parser.error('invalid port or timeout')
    runtime = Path(os.environ.get('LUANTI_RT', str(ENGINE / '.runtime'))).absolute()
    engine = runtime / 'root/usr/libexec/luanti/luantiserver'
    if not engine.is_file() or not os.access(engine, os.X_OK):
        print('preview: engine unavailable', file=sys.stderr); return 2
    try:
        store = DraftStore(args.draft_db)
        try: world, count = prepare_preview(store, args.draft_id, args.revision, args.preview_root)
        finally: store.close()
        print('DISPOSABLE PREVIEW, NOT A SAVED OR RESTORED WORLD:', world, flush=True)
        print('Flat terrain only; no rules or connections; mark/gather/build are rejected.', flush=True)
        return launch(world, count, engine=engine, runtime_home=runtime / 'home',
                      libdir=runtime / 'root/usr/lib/x86_64-linux-gnu', port=args.port,
                      seconds=args.seconds, fixture=args.fixture)
    except (PreflightError, OSError, ValueError) as error:
        print('preview failed:', getattr(error, 'code', 'io_error'), file=sys.stderr)
        if isinstance(error, PreflightError) and error.diagnostics:
            print(json.dumps(error.diagnostics), file=sys.stderr)
        return 1

if __name__ == '__main__':
    sys.exit(main())

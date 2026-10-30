"""Run one Luanti process inside a controlled Wispiva world session.

The session owns the world lock for the complete child lifetime.  This keeps
identity validation and cooperative exclusion at the process boundary instead
of leaving them as a library convention that the launcher could accidentally
skip.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import signal
import subprocess
import sys

# ``run.sh`` executes this file by path, so the repository root is not
# automatically on sys.path as it is when the module is imported by tests.
if __package__ in (None, ''):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from engine.luanti.world_session import WorldSession
from engine.luanti.recovery_journal import RecoveryRequired, SessionJournal
from world.product_contract import ProductContractError, validate_world_contract


def _forward(child, signum, _frame):
    if child.poll() is None:
        try:
            child.send_signal(signum)
        except ProcessLookupError:
            pass


def run(command, world_dir, *, create=False, expected_world_id=None, env=None,
        require_product_contract=False, cwd=None):
    """Run *command* while holding the world's exclusive session lock."""
    if not command:
        raise ValueError('missing child command')
    child = None
    with WorldSession(world_dir, create=create,
                      expected_world_id=expected_world_id) as session:
        if require_product_contract:
            validate_world_contract(world_dir, expected_world_id=session.world_id)
        journal = SessionJournal(world_dir, session.world_id)
        journal.begin()
        child_env = dict(os.environ if env is None else env)
        child_env['WISPIVA_WORLD_ID'] = session.world_id
        try:
            child = subprocess.Popen(command, cwd=cwd, env=child_env)
            previous = {}
            for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
                previous[signum] = signal.signal(
                    signum, lambda sig, frame, child=child: _forward(child, sig, frame))
            try:
                return child.wait()
            finally:
                for signum, handler in previous.items():
                    signal.signal(signum, handler)
                if child.poll() is None:
                    child.terminate()
                    try:
                        child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait()
        finally:
            journal.finish()


def main(argv=None):
    parser = argparse.ArgumentParser(
        description='Run a child process inside a controlled Wispiva world session.')
    parser.add_argument('--world', required=True, type=Path)
    parser.add_argument('--create-if-missing', action='store_true')
    parser.add_argument('--expected-world-id')
    parser.add_argument('--require-product-contract', action='store_true')
    parser.add_argument('--cwd', type=Path)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    command = list(args.command)
    if command[:1] == ['--']:
        command.pop(0)
    if not command:
        parser.error('a child command is required after --')
    try:
        return run(command, args.world, create=args.create_if_missing,
                   expected_world_id=args.expected_world_id,
                   require_product_contract=args.require_product_contract,
                   cwd=args.cwd)
    except (BlockingIOError, OSError, ValueError, RecoveryRequired, ProductContractError) as error:
        print('wispiva launcher: ' + str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())

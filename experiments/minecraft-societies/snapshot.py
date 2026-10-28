#!/usr/bin/env python3
"""Copy a stopped Luanti world and verify the copy by content hash."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess


def files(root):
    result = {}
    for path in sorted(root.rglob('*')):
        if path.is_symlink():
            raise ValueError(f'symlinks are not supported: {path}')
        if path.is_file():
            digest = hashlib.sha256()
            with path.open('rb') as source:
                for chunk in iter(lambda: source.read(1024 * 1024), b''):
                    digest.update(chunk)
            result[str(path.relative_to(root))] = digest.hexdigest()
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    source = args.source.resolve(strict=True)
    dest = args.destination.resolve()
    if not source.is_dir() or source == dest or source in dest.parents or dest in source.parents:
        parser.error('source and destination must be separate directories')
    if dest.exists():
        parser.error('destination already exists')
    # A live database can be copied inconsistently even when file hashes match.
    pids = subprocess.run(['pgrep', '-f', '[l]uantiserver'], capture_output=True, text=True)
    if pids.returncode == 0:
        parser.error('stop all Luanti servers on this host before copying')
    if pids.returncode != 1:
        parser.error('could not determine whether Luanti is running')
    before = files(source)
    dest.mkdir()
    try:
        shutil.copytree(source, dest, symlinks=False, dirs_exist_ok=True)
        if before != files(dest) or before != files(source):
            raise RuntimeError('copy or source changed during snapshot')
    except Exception:
        if dest.exists():
            shutil.rmtree(dest)
        raise
    print(json.dumps({'files': len(before), 'source': str(source), 'destination': str(dest)}, sort_keys=True))


if __name__ == '__main__':
    main()

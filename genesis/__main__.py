"""CLI for validating, storing, confirming and preflighting world drafts."""
import argparse
import json
import sys
from pathlib import Path
from .genesis import GenesisError, generate, parse_json, validate
from .preflight import PreflightError, preflight
from .store import DraftConflict, DraftCorrupt, DraftStore
from .world_create import WorldCreationError, create_world


def _read_draft(path):
    return parse_json(Path(path).read_text(encoding='utf-8'))


def _open_store(path, *, create=False):
    return DraftStore(path, create=create)


def _print(value):
    print(json.dumps(value, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description='Manage world drafts and confirmed world origins.')
    sub = parser.add_subparsers(dest='command', required=True)
    check = sub.add_parser('validate'); check.add_argument('draft')
    create = sub.add_parser('generate'); create.add_argument('--intent', required=True); create.add_argument('--response', required=True, help='file containing a model-generated JSON response')
    create_draft = sub.add_parser('create-draft', help='generate and persist one editable draft with its private intent')
    create_draft.add_argument('--draft-db', required=True)
    create_draft.add_argument('--intent', required=True)
    create_draft.add_argument('--response', required=True, help='file containing a model-generated JSON response')
    save = sub.add_parser('save', help='persist a validated draft in a new or existing private DraftStore')
    save.add_argument('--draft-db', required=True); save.add_argument('--draft', required=True)
    confirm = sub.add_parser('confirm', help='explicitly confirm one draft revision into a new WorldStore')
    confirm.add_argument('--draft-db', required=True); confirm.add_argument('--draft-id', required=True)
    confirm.add_argument('--revision', required=True, type=int); confirm.add_argument('--world-path', required=True)
    recover = sub.add_parser('recover', help='resume or verify an already confirmed draft request')
    recover.add_argument('--draft-db', required=True); recover.add_argument('--draft-id', required=True)
    inspect = sub.add_parser('read', help='read a private draft record')
    inspect.add_argument('--draft-db', required=True); inspect.add_argument('--draft-id', required=True)
    check_confirmed = sub.add_parser('preflight', help='check a confirmed revision without creating a Luanti world')
    check_confirmed.add_argument('--draft-db', required=True); check_confirmed.add_argument('--draft-id', required=True)
    check_confirmed.add_argument('--revision', required=True, type=int); check_confirmed.add_argument('--world-path', required=True)
    create_world_cmd = sub.add_parser('create-world', help='publish a confirmed draft as a persistent Luanti world')
    create_world_cmd.add_argument('--draft-db', required=True); create_world_cmd.add_argument('--draft-id', required=True)
    create_world_cmd.add_argument('--revision', required=True, type=int); create_world_cmd.add_argument('--world-path', required=True)
    args = parser.parse_args()
    try:
        if args.command == 'validate':
            draft = _read_draft(args.draft)
            errors = validate(draft)
            if errors: raise GenesisError('invalid_draft', errors)
            _print({'status': 'valid'})
        elif args.command == 'generate':
            response = Path(args.response).read_text(encoding='utf-8')
            draft = generate(args.intent, lambda system, user: response)
            _print(draft)
        elif args.command == 'create-draft':
            response = Path(args.response).read_text(encoding='utf-8')
            path = Path(args.draft_db)
            store = _open_store(path, create=not path.exists())
            try:
                record = store.create_from_intent(args.intent, lambda system, user: response)
            finally:
                store.close()
            _print({'id': record['id'], 'revision': record['revision'],
                    'status': record['status'], 'intent': record['intent']})
        elif args.command == 'save':
            path = Path(args.draft_db)
            store = _open_store(path, create=not path.exists())
            try:
                record = store.create(_read_draft(args.draft))
            finally:
                store.close()
            _print({'id': record['id'], 'revision': record['revision'], 'status': record['status']})
        elif args.command == 'read':
            store = _open_store(args.draft_db)
            try: record = store.read(args.draft_id)
            finally: store.close()
            _print(record)
        elif args.command == 'confirm':
            store = _open_store(args.draft_db)
            try: result = store.confirm(args.draft_id, args.revision, args.world_path)
            finally: store.close()
            _print(result)
        elif args.command == 'recover':
            store = _open_store(args.draft_db)
            try: result = store.recover_confirmation(args.draft_id)
            finally: store.close()
            _print(result)
        elif args.command == 'create-world':
            store = _open_store(args.draft_db)
            try: result = create_world(store, args.draft_id, args.revision, args.world_path)
            finally: store.close()
            _print(result)
        else:
            store = _open_store(args.draft_db)
            try: result = preflight(store, args.draft_id, args.revision, args.world_path)
            finally: store.close()
            _print(result)
    except (GenesisError, DraftConflict, DraftCorrupt, PreflightError, WorldCreationError, OSError, UnicodeError, ValueError) as error:
        print(json.dumps({'error': getattr(error, 'code', type(error).__name__), 'diagnostics': getattr(error, 'diagnostics', [])}, ensure_ascii=False), file=sys.stderr)
        return 1
    return 0

if __name__ == '__main__':
    sys.exit(main())

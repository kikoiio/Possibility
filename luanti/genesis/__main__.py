"""Offline CLI: validate a file or generate from a supplied model response."""
import argparse
import json
import sys
from pathlib import Path
from .genesis import GenesisError, generate, parse_json, validate


def main():
    parser = argparse.ArgumentParser(description='Validate or create a world draft; never writes a world.')
    sub = parser.add_subparsers(dest='command', required=True)
    check = sub.add_parser('validate'); check.add_argument('draft')
    create = sub.add_parser('generate'); create.add_argument('--intent', required=True); create.add_argument('--response', required=True, help='file containing a model-generated JSON response')
    args = parser.parse_args()
    try:
        if args.command == 'validate':
            draft = parse_json(Path(args.draft).read_text(encoding='utf-8'))
            errors = validate(draft)
            if errors: raise GenesisError('invalid_draft', errors)
        else:
            response = Path(args.response).read_text(encoding='utf-8')
            draft = generate(args.intent, lambda system, user: response)
        print(json.dumps(draft, ensure_ascii=False, indent=2))
    except (GenesisError, OSError, UnicodeError) as error:
        print(json.dumps({'error': getattr(error, 'code', 'input_error'), 'diagnostics': getattr(error, 'diagnostics', [])}), file=sys.stderr)
        return 1
    return 0

if __name__ == '__main__':
    sys.exit(main())

"""Local stdin/stdout JSONL bridge. Each request is processed sequentially."""
import json
import sys

try:
    from .adapter import Config, MAX_REQUEST, ModelError, decide
except ImportError:  # direct worker script execution
    from adapter import Config, MAX_REQUEST, ModelError, decide

MAX_LINE = MAX_REQUEST * 2
ERRORS = frozenset({'invalid_config', 'invalid_context', 'request_too_large',
                    'transport_error', 'invalid_content_type', 'response_too_large',
                    'output_too_large', 'invalid_response', 'provider_failed',
                    'incomplete_response', 'invalid_action'})


def serve(source, sink, config, decision=decide):
    while True:
        line = source.readline(MAX_LINE + 1)
        if not line:
            return
        request_id = None
        try:
            if len(line) > MAX_LINE or not line.endswith('\n'):
                # Drain a partial oversized line, keeping memory bounded.
                while line and not line.endswith('\n'):
                    line = source.readline(MAX_LINE + 1)
                raise ValueError
            request = json.loads(line)
            if not isinstance(request, dict) or set(request) != {'id', 'context'}:
                raise ValueError
            if type(request['id']) is not int or not 0 <= request['id'] <= 2**53 - 1:
                raise ValueError
            request_id = request['id']
            if not isinstance(request['context'], dict):
                raise ValueError
            result = decision(config, request['context'])
            response = {'id': request_id, 'ok': True, **result}
        except ModelError as exc:
            code = str(exc)
            response = {'id': request_id, 'ok': False,
                        'error': code if code in ERRORS else 'internal_error'}
            if exc.audit is not None:
                response['audit'] = exc.audit
        except Exception:
            response = {'id': request_id, 'ok': False, 'error': 'invalid_request'}
        sink.write(json.dumps(response, ensure_ascii=True, separators=(',', ':')) + '\n')
        sink.flush()


def main():
    serve(sys.stdin, sys.stdout, Config.from_env())


if __name__ == '__main__':
    main()

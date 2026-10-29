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


def _validate_model_input(value):
    """Validate the optional product envelope before invoking a provider."""
    if (not isinstance(value, dict) or value.get('schema') != 'wispiva.model-input'
            or value.get('version') != 1):
        raise ValueError('invalid_model_input')
    request = value.get('request')
    actor = value.get('actor')
    knowledge = value.get('knowledge')
    if (not isinstance(request, dict) or not isinstance(actor, dict)
            or not isinstance(knowledge, dict)):
        raise ValueError('invalid_model_input')
    world_id, actor_id = request.get('world_id'), request.get('actor_id')
    if (not isinstance(world_id, str) or not world_id or actor.get('id') != actor_id
            or not isinstance(actor_id, str) or not actor_id):
        raise ValueError('invalid_model_input')
    kinds = {'facts': 'fact', 'experiences': 'experience', 'rumors': 'rumor', 'unknowns': 'unknown'}
    for section, epistemic in kinds.items():
        records = knowledge.get(section)
        if not isinstance(records, list) or len(records) > 32:
            raise ValueError('invalid_model_input')
        for record in records:
            if (not isinstance(record, dict) or record.get('epistemic') != epistemic
                    or not isinstance(record.get('id'), str) or not isinstance(record.get('text'), str)
                    or not isinstance(record.get('source'), dict)):
                raise ValueError('invalid_model_input')
            source = record['source']
            if (not isinstance(source.get('kind'), str) or not source['kind']
                    or not isinstance(source.get('id'), str) or not source['id']):
                raise ValueError('invalid_model_input')
            access = record.get('access')
            if (not isinstance(access, dict) or not isinstance(access.get('scope'), str)
                    or not isinstance(access.get('audience'), list)
                    or any(not isinstance(item, str) or not item for item in access['audience'])
                    or actor_id not in access['audience']):
                raise ValueError('invalid_model_input')
    if not isinstance(value.get('current'), dict) or not isinstance(value.get('feedback'), dict):
        raise ValueError('invalid_model_input')
    return True


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
            if 'model_input' in request['context']:
                _validate_model_input(request['context']['model_input'])
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

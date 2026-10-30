"""Local stdin/stdout JSONL bridge. Each request is processed sequentially."""
import json
import sys

try:
    from .adapter import Config, MAX_REQUEST, ModelError, decide
    from .product_envelope import EnvelopeError, validate as validate_product_envelope
    from .reflection import ReflectionError, build_input, reflect
except ImportError:  # direct worker script execution
    from adapter import Config, MAX_REQUEST, ModelError, decide
    from product_envelope import EnvelopeError, validate as validate_product_envelope
    from reflection import ReflectionError, build_input, reflect

MAX_LINE = MAX_REQUEST * 2
ERRORS = frozenset({'invalid_config', 'invalid_context', 'request_too_large',
                    'transport_error', 'invalid_content_type', 'response_too_large',
                    'output_too_large', 'invalid_response', 'provider_failed',
                    'incomplete_response', 'invalid_action', 'rate_limited', 'timeout'})


def _validate_model_input(value):
    """Validate the product envelope before invoking a provider."""
    try:
        return validate_product_envelope(value)
    except EnvelopeError as exc:
        raise ValueError('invalid_model_input') from exc


def _validate_reflection_input(value, model_input):
    """Check the exact reflection schema and bind it to the validated actor/world."""
    if (type(value) is not dict or
            set(value) != {'schema', 'version', 'request', 'experiences'} or
            value['schema'] != 'wispiva.reflection-input' or
            type(value['version']) not in (int, float) or value['version'] != 1):
        raise ValueError('invalid_reflection_input')
    request = value['request']
    if type(request) is not dict or set(request) != {'world_id', 'actor_id', 'topic'}:
        raise ValueError('invalid_reflection_input')
    # Pass the original collection to build_input: coercion could hide a malformed
    # request (for example, an object masquerading as an experience array).
    validated = build_input(**request, experiences=value['experiences'])
    if (request['actor_id'] != model_input['actor']['id'] or
            request['world_id'] != model_input['request']['world_id']):
        raise ValueError('invalid_reflection_input')
    return validated


def _request_pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError('duplicate_request_field')
        result[key] = value
    return result


def serve(source, sink, config, decision=decide, reflection=reflect):
    while True:
        line = source.readline(MAX_LINE + 1)
        if not line:
            return
        request_id = None
        reflection_fields = {}
        try:
            if len(line) > MAX_LINE or not line.endswith('\n'):
                # Drain a partial oversized line, keeping memory bounded.
                while line and not line.endswith('\n'):
                    line = source.readline(MAX_LINE + 1)
                raise ValueError
            request = json.loads(line, object_pairs_hook=_request_pairs)
            if not isinstance(request, dict) or set(request) != {'id', 'context'}:
                raise ValueError
            if type(request['id']) is not int or not 0 <= request['id'] <= 2**53 - 1:
                raise ValueError
            request_id = request['id']
            if not isinstance(request['context'], dict):
                raise ValueError
            context = request['context']
            if 'model_input' in context:
                _validate_model_input(context['model_input'])
            if 'reflection_input' in context:
                if 'model_input' not in context:
                    raise ValueError('missing_model_input')
                reflection_input = _validate_reflection_input(
                    context['reflection_input'], context['model_input'])
                try:
                    reflected = reflection(config, reflection_input)
                    reflection_fields = {'reflection': reflected['reflection'],
                                         'reflection_audit': reflected['audit']}
                except ReflectionError as exc:
                    code = str(exc)
                    raise ModelError(code if code in ERRORS else 'invalid_response') from None
                except ModelError:
                    raise
                except Exception:
                    raise ModelError('provider_failed') from None
                context = {key: value for key, value in context.items()
                           if key != 'reflection_input'}
            result = decision(config, context)
            response = {'id': request_id, 'ok': True, **result, **reflection_fields}
        except ModelError as exc:
            code = str(exc)
            response = {'id': request_id, 'ok': False,
                        'error': code if code in ERRORS else 'internal_error'}
            if exc.audit is not None:
                response['audit'] = exc.audit
        except Exception:
            response = {'id': request_id, 'ok': False, 'error': 'invalid_request'}
        if response['ok'] is False and 'reflection_audit' in reflection_fields:
            response['reflection_audit'] = reflection_fields['reflection_audit']
        sink.write(json.dumps(response, ensure_ascii=True, separators=(',', ':')) + '\n')
        sink.flush()


def main():
    serve(sys.stdin, sys.stdout, Config.from_env())


if __name__ == '__main__':
    main()

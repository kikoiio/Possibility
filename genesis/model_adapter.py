"""Explicit-config bridge to the existing Responses transport; no configuration discovery."""
import json
from model import adapter


def responses_model(config, *, transport=None, usage_callback=None):
    """Return a genesis model callable with optional sanitized usage reporting."""
    def call(system, user):
        config.endpoint()
        body = json.dumps({'model': config.model, 'stream': True,
                           'text': {'format': {'type': 'json_object'}},
                           'reasoning': {'effort': 'none'}, 'max_output_tokens': 4096,
                           'input': [{'role': 'system', 'content': system},
                                     {'role': 'user', 'content': user}]},
                          ensure_ascii=True, separators=(',', ':')).encode()
        if len(body) > adapter.MAX_REQUEST:
            raise adapter.ModelError('request_too_large')
        data = (transport or adapter._transport)(config, body)
        text, usage = adapter._parse_stream(data)
        if usage_callback is not None:
            usage_callback(dict(usage))
        return text
    return call

"""Explicit-config bridge to the existing Responses transport; no configuration discovery."""
import json
from model import adapter


def responses_model(config, *, transport=None):
    """Return a genesis model callable. Caller supplies Config and optionally transport."""
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
        return adapter._parse_stream(data)[0]
    return call

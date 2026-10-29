import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from genesis.__main__ import main


class GenesisCliTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.draft = json.loads((Path(__file__).parent / 'example.json').read_text(encoding='utf-8'))
        self.draft_path = self.root / 'draft.json'
        self.draft_path.write_text(json.dumps(self.draft), encoding='utf-8')
        self.db = self.root / 'drafts.sqlite'

    def run_cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with patch('sys.argv', ['genesis', *argv]), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = main()
        return code, json.loads(out.getvalue()) if out.getvalue() else None, err.getvalue()

    def test_save_confirm_read_and_preflight(self):
        code, saved, err = self.run_cli('save', '--draft-db', str(self.db), '--draft', str(self.draft_path))
        self.assertEqual((code, err), (0, ''))
        self.assertEqual(saved['status'], 'draft')
        world = self.root / 'origin.sqlite'
        code, confirmed, err = self.run_cli('confirm', '--draft-db', str(self.db), '--draft-id', saved['id'], '--revision', '1', '--world-path', str(world))
        self.assertEqual((code, err), (0, ''))
        self.assertEqual(confirmed['status'], 'confirmed')
        self.assertTrue(world.is_file())
        code, record, err = self.run_cli('read', '--draft-db', str(self.db), '--draft-id', saved['id'])
        self.assertEqual((code, err), (0, ''))
        self.assertEqual(record['status'], 'confirmed')
        code, result, err = self.run_cli('preflight', '--draft-db', str(self.db), '--draft-id', saved['id'], '--revision', '1', '--world-path', str(self.root / 'new-world.sqlite'))
        self.assertEqual((code, err), (0, ''))
        self.assertFalse(result['launchable'])
        self.assertEqual(result['status'], 'blocked')

    def test_validate_reports_success(self):
        code, result, err = self.run_cli('validate', str(self.draft_path))
        self.assertEqual((code, err), (0, ''))
        self.assertEqual(result, {'status': 'valid'})


if __name__ == '__main__':
    unittest.main()

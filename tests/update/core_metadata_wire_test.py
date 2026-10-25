import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('core_wire_fixture_support', Path(__file__).with_name('context_core_observer_test.py'))
support = importlib.util.module_from_spec(spec)
spec.loader.exec_module(support)


class MetadataOmissionTests(unittest.TestCase):
    run_case = support.CoreTests.run_case

    def test_metadata_only_body_is_intentionally_absent_not_invalid_frame(self):
        directory, result = self.run_case('denied_frame')
        self.assertEqual(result['result']['reply']['reason'], 'product_admission_unknown')
        self.assertIsNone(result['result']['reply']['result_original'])
        value = json.loads((directory / 'core_result.json').read_text())
        self.assertEqual(value['completion']['frame_admission']['reason'], 'unsupported_fields')
        self.assertIsNone(value['input_frame_sha256'])
        self.assertIsNone(value['input_frame_bytes'])
        self.assertFalse(value['frame_body_supplied'])
        self.assertFalse((directory / 'core_result.frame').exists())

    def test_failed_write_body_is_absent_and_original_code_is_kept(self):
        directory, result = self.run_case('write_failed')
        self.assertEqual(result['result']['reply']['reason'], 'output_unconfirmed')
        value = json.loads((directory / 'core_result.json').read_text())
        self.assertEqual(value['completion']['exit_code'], 2)
        self.assertEqual(value['completion']['stdout_write'], 'failed')
        self.assertFalse(value['frame_body_supplied'])
        self.assertIsNone(value['result_original'])

    def test_no_body_does_not_bypass_admission_and_completion_digest_binding(self):
        directory, result = self.run_case('bad_metadata_digest')
        self.assertEqual(result['result']['reply']['reason'], 'admission_digest_or_size_mismatch')
        self.assertFalse((directory / 'core_result.frame').exists())
        self.assertIsNone(result['result']['reply']['result_original'])


if __name__ == '__main__':
    unittest.main()

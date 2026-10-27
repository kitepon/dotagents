import importlib.util
import json
from pathlib import Path
import subprocess
import unittest

SPEC = importlib.util.spec_from_file_location('context_fixture_support', Path(__file__).with_name('context_observer_test.py'))
SUPPORT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SUPPORT)
ROOT = SUPPORT.ROOT
WRITER = (ROOT / 'bin/agents-update.sh').read_text()
PREFIX = WRITER[WRITER.index('run_npm() ('):WRITER.index('\nrecord_toolchain() {')]
START = WRITER.index('      PATH="$npm_global_bin:$PATH"')
POST = WRITER[START:WRITER.index('\n    fi\n    for pkg', START)]


class OperationTests(unittest.TestCase):
    setUp = SUPPORT.ObserverTests.setUp
    launch = SUPPORT.ObserverTests.launch
    read = SUPPORT.ObserverTests.read

    def prepare(self, prefix_exit=0, root_exit=0, root_value=None):
        prefix = self.home / 'prefix'
        bin_dir = prefix / 'bin'
        bin_dir.mkdir(parents=True)
        initial = self.home / 'initial-bin'
        initial.mkdir()
        self.env['PATH'] = str(initial) + ':/usr/bin:/bin'
        for parent, stage in [(initial, 'before'), (bin_dir, 'after')]:
            npm = parent / 'npm'
            npm.write_text('#!/bin/bash\nprintf "%s:%s\\n" ' + stage + ' "$1" >> "$HOME/npm-calls"\n'
                           'case "$1" in\nprefix) printf "%s\\n" "$HOME/prefix"; exit ' + str(prefix_exit) + ';;\n'
                           'root) printf "%s\\n" ' + json.dumps(root_value or str(prefix / 'lib/node_modules')) + '; exit ' + str(root_exit) + ';;\nesac\nexit 99\n')
            npm.chmod(0o700)
        return 'runtime_os=Linux\n' + PREFIX + '\ndotagents_observe_context launcher_input "$0"\ndotagents_observe_context writer_after_nvm "$0"\n'

    def test_existing_prefix_and_root_once_stdout_exit_time_and_distinct_context(self):
        body = self.prepare() + '\nnpm_global_bin="$(resolve_npm_global_bin)"\n' + POST + '\nprintf "ordinary=%s\\n" "$npm_global_root"\n'
        process = self.launch(body)
        self.assertEqual((self.home / 'npm-calls').read_text().splitlines(), ['before:prefix', 'after:root'])
        first, result = self.read('prefix_before'), self.read('prefix_result')
        after, root = self.read('global_bin_after'), self.read('root_result')
        self.assertEqual(first['process_identity'], result['process_identity'])
        self.assertNotEqual(first['process_identity'], after['process_identity'])
        self.assertEqual(result['operation_original']['exit'], 0)
        self.assertEqual(result['operation_original']['value_status'], 'absolute_single_path')
        self.assertEqual(result['operation_original']['clock_status'], 'shell_epochrealtime')
        self.assertLessEqual(result['operation_original']['started_at_utc_us'], result['operation_original']['ended_at_utc_us'])
        self.assertNotEqual(first['command_resolution']['npm']['resolved_path'], after['command_resolution']['npm']['resolved_path'])
        self.assertTrue(after['global_bin_metadata']['exists_as_directory'])
        self.assertEqual(root['operation_original']['value'], str(self.home / 'prefix/lib/node_modules'))
        self.assertEqual(root['predecessor_originals'][0]['phase'], 'root_before')
        self.assertIn('ordinary=' + str(self.home / 'prefix/lib/node_modules'), process.stdout)
        self.assertEqual(process.stdout, 'ordinary=' + str(self.home / 'prefix/lib/node_modules') + '\n')
        for file in self.capture.glob('*.json'):
            self.assertNotIn('fixture-secret-value', file.read_text())

    def test_prefix_failure_retains_original_nonzero_and_function_failure(self):
        process = self.launch(self.prepare(prefix_exit=37) + '\nif npm_global_bin="$(resolve_npm_global_bin)"; then exit 90; else rc=$?; fi\nprintf "function-exit=%s\\n" "$rc"\n')
        self.assertEqual(self.read('prefix_result')['operation_original']['exit'], 37)
        self.assertIn('function-exit=1', process.stdout)
        self.assertFalse((self.capture / 'global_bin_after.json').exists())
        self.assertEqual((self.home / 'npm-calls').read_text().splitlines(), ['before:prefix'])

    def test_root_failure_keeps_original_exit_and_existing_empty_fallback(self):
        process = self.launch(self.prepare(root_exit=42) + '\nnpm_global_bin="$(resolve_npm_global_bin)"\n' + POST + '\nprintf "root-value=<%s>\\n" "$npm_global_root"\n')
        self.assertEqual(self.read('root_result')['operation_original']['exit'], 42)
        self.assertIsNone(self.read('root_result')['operation_original']['value'])
        self.assertIn('root-value=<>', process.stdout)

    def test_invalid_root_output_is_not_exported_or_promoted_to_path(self):
        self.launch(self.prepare(root_value='invalid\nprivate-output') + '\nnpm_global_bin="$(resolve_npm_global_bin)"\n' + POST + '\nprintf ordinary\\n\n')
        value = self.read('root_result')['operation_original']
        self.assertEqual(value['value_status'], 'invalid_path')
        self.assertIsNone(value['value'])
        self.assertNotIn('private-output', (self.capture / 'root_result.json').read_text())

    def test_missing_predecessor_blocks_only_capture_and_leaves_ordinary_success(self):
        process = self.launch('dotagents_observe_context launcher_input "$0"\ndotagents_observe_operation root_result "$0" --operation-exit 0 --operation-value v:/fixture/root\nprintf ordinary-success\\n\n')
        self.assertFalse((self.capture / 'root_result.json').exists())
        self.assertIn('ordinary-success', process.stdout)
        self.assertIn('observation unknown', process.stderr)

    def test_operation_result_from_different_process_is_not_same_operation(self):
        process = self.launch('dotagents_observe_context launcher_input "$0"\ndotagents_observe_context writer_after_nvm "$0"\ndotagents_observe_operation prefix_before "$0"\n(dotagents_observe_operation prefix_result "$0" --operation-exit 0 --operation-value v:/fixture/prefix)\nprintf ordinary-success\n\n')
        self.assertFalse((self.capture / 'prefix_result.json').exists())
        self.assertIn('operation_process_changed', process.stderr)
        self.assertIn('ordinary-success', process.stdout)

    def test_existing_factory_js_bridge_once_keeps_product_result_and_core_unknown(self):
        # This is a synthetic execute port; no product CLI, NVM, or npm install.
        node = subprocess.check_output(['which', 'node'], text=True).strip()
        js = self.root / 'bridge.mjs'
        module = (ROOT / 'lib/factory/product-setup.mjs').as_uri()
        js.write_text('import {runProductSetup} from ' + json.dumps(module) + ';\n'
                      'let calls=0; const state=await runProductSetup("gpt-connector",{execute:async()=>{calls++;return {ok:false,code:2,stdout:JSON.stringify({overall:"partial"}),stderr:""}},output:{write(){}}});\n'
                      'if(calls!==1||state!=="partial")throw Error("ordinary result changed");\nconsole.log("same-product-result");\n')
        self.launch(self.prepare() + '\nnpm_global_bin="$(resolve_npm_global_bin)"\n' + POST + '\n' + json.dumps(node) + ' ' + json.dumps(str(js)) + '\n')
        before, after = self.read('public_setup_before'), self.read('public_setup_after')
        self.assertEqual(before['process_identity'], after['process_identity'])
        self.assertEqual(after['operation_original']['exit'], 2)
        self.assertTrue(after['factory_bridge_runtime']['process_version'].startswith('v'))
        self.assertEqual(after['public_core_actual_run'], 'unknown_requires_product_owned_original')
        self.assertEqual(after['kind'], 'observed_writer_operation')
        self.assertFalse(after['resource_read_authorized'])


if __name__ == '__main__':
    unittest.main()

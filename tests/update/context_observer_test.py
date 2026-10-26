import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = Path('/srv/bellteam/bots/bot-62c62f61/artifacts/2026-10-25-job-context-observer/fixtures')


class ObserverTests(unittest.TestCase):
    def setUp(self):
        self.root = FIXTURES / str(uuid.uuid4())
        self.root.mkdir(parents=True, mode=0o700)
        self.home = self.root / 'home'
        self.home.mkdir(mode=0o700)
        (self.home / 'after').mkdir(mode=0o700)
        self.capture = self.root / 'capture'
        self.capture.mkdir(mode=0o700)
        self.env = {
            'HOME': str(self.home), 'PATH': '/usr/bin:/bin', 'SHELL': '/bin/bash',
            'DOTAGENTS_UPDATE_CONTEXT_OBSERVER': '1',
            'DOTAGENTS_UPDATE_CONTEXT_SOURCE_ROOT': str(ROOT),
            'DOTAGENTS_UPDATE_CONTEXT_DIR': str(self.capture),
            'DOTAGENTS_UPDATE_CONTEXT_EXPIRES_AT': str(time.time_ns() // 1000000 + 60000),
            'SHOULD_NOT_CAPTURE': 'fixture-secret-value', 'NVM_CD_FLAGS': '-P',
        }

    def launch(self, body, name='launcher.sh'):
        path = self.root / name
        path.write_text('set -euo pipefail\n. "$DOTAGENTS_UPDATE_CONTEXT_SOURCE_ROOT/bin/factory-update-context-observer.sh"\n' + body)
        process = subprocess.run(['/bin/bash', '--noprofile', '--norc', str(path)],
                                 cwd=self.home, env=self.env, capture_output=True, text=True, timeout=10)
        (self.root / (name + '.stdout')).write_text(process.stdout)
        (self.root / (name + '.stderr')).write_text(process.stderr)
        self.assertEqual(process.returncode, 0, process.stderr)
        return process

    def read(self, stage):
        return json.loads((self.capture / (stage + '.json')).read_text())

    def test_actual_parent_and_child_snapshots_without_starting_nvm_node_or_npm(self):
        fake = self.home / 'fake-bin'
        fake.mkdir()
        for name in ['node', 'npm']:
            path = fake / name
            path.write_text('#!/bin/bash\nprintf called >> "$HOME/forbidden-runtime"\nexit 90\n')
            path.chmod(0o700)
        nvm = self.home / '.nvm'
        nvm.mkdir()
        (nvm / 'nvm.sh').write_text('printf sourced >> "$HOME/forbidden-nvm"\n')
        writer = self.root / 'writer.sh'
        writer.write_text('. "$DOTAGENTS_UPDATE_CONTEXT_SOURCE_ROOT/bin/factory-update-context-observer.sh"\n'
                          'dotagents_observe_context writer_input "$0"\n'
                          'dotagents_observe_context writer_after_nvm "$0"\n'
                          'printf writer-done\\n\n')
        process = self.launch('''dotagents_observe_context launcher_input "$0"
dotagents_observe_context wrapper_before_nvm "$0"
PATH="$HOME/fake-bin:$PATH"; export PATH
cd "$HOME/after"
dotagents_observe_context wrapper_after_nvm "$0"
/bin/bash "$HOME/../writer.sh"
printf 'ordinary-complete\\n'
''')
        first = self.read('launcher_input')
        after = self.read('wrapper_after_nvm')
        child = self.read('writer_input')
        self.assertEqual(first['process']['uid_fields'][1], os.geteuid())
        self.assertIsInstance(first['process']['comm'], str)
        self.assertIn('cgroups', first['process'])
        self.assertEqual(first['cwd'], str(self.home))
        self.assertEqual(after['cwd'], str(self.home / 'after'))
        self.assertEqual(first['launcher_identity'], after['process_identity'])
        self.assertNotEqual(first['process_identity'], child['process_identity'])
        self.assertEqual(first['launcher_identity'], child['launcher_identity'])
        self.assertEqual(first['restore_inputs']['NVM_CD_FLAGS']['value'], '-P')
        self.assertEqual(after['restore_inputs']['PATH']['value'], str(fake) + ':/usr/bin:/bin')
        for path in self.capture.glob('*.json'):
            text = path.read_text()
            self.assertNotIn('SHOULD_NOT_CAPTURE', text)
            self.assertNotIn('fixture-secret-value', text)
            value = json.loads(text)
            self.assertEqual(value['kind'], 'observed_launcher')
            self.assertEqual(value['normal_job_binding'], 'unknown_until_dispatcher_source_correlation')
            self.assertFalse(value['reporting_allowed'])
            self.assertFalse(value['resource_read_authorized'])
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertFalse((self.home / 'forbidden-runtime').exists())
        self.assertFalse((self.home / 'forbidden-nvm').exists())
        self.assertIn('ordinary-complete', process.stdout)
        self.assertNotIn('update-context-observer', process.stdout)

    def test_default_off_has_no_capture_and_keeps_ordinary_stdout(self):
        self.env.pop('DOTAGENTS_UPDATE_CONTEXT_OBSERVER')
        process = self.launch('dotagents_observe_context launcher_input "$0"\nprintf ordinary\\n\n')
        self.assertEqual(list(self.capture.iterdir()), [])
        self.assertNotIn('observer', process.stderr)
        self.assertIn('ordinary', process.stdout)

    def test_expired_window_records_no_inputs_and_does_not_extend_itself(self):
        self.env['DOTAGENTS_UPDATE_CONTEXT_EXPIRES_AT'] = '1'
        process = self.launch('dotagents_observe_context launcher_input "$0"\nprintf ordinary\\n\n')
        self.assertEqual(list(self.capture.iterdir()), [])
        self.assertIn('capture_window_invalid_or_expired', process.stderr)
        self.assertIn('ordinary', process.stdout)

    def test_missing_or_broad_directory_is_not_created_or_chmodded(self):
        self.env['DOTAGENTS_UPDATE_CONTEXT_DIR'] = str(self.root / 'missing')
        self.launch('dotagents_observe_context launcher_input "$0"\nprintf ordinary\\n\n', 'missing.sh')
        self.assertFalse((self.root / 'missing').exists())
        self.env['DOTAGENTS_UPDATE_CONTEXT_DIR'] = str(self.capture)
        self.capture.chmod(0o777)
        process = self.launch('dotagents_observe_context launcher_input "$0"\nprintf ordinary\\n\n', 'broad.sh')
        self.assertEqual(self.capture.stat().st_mode & 0o777, 0o777)
        self.assertEqual(list(self.capture.iterdir()), [])
        self.assertIn('output_directory_not_private', process.stderr)
        self.capture.chmod(0o700)
        process = self.launch('umask 0777\ndotagents_observe_context launcher_input "$0"\nprintf ordinary\\n\n', 'restrictive.sh')
        self.assertIn('observation_file_permission_mismatch', process.stderr)
        self.assertFalse((self.capture / 'launcher_input.json').exists())

    def test_pending_original_is_preserved_and_not_recovered_by_guessing(self):
        pending = self.capture / 'launcher_input.pending'
        pending.write_text('interrupted-original')
        process = self.launch('dotagents_observe_context launcher_input "$0"\nprintf ordinary\\n\n')
        self.assertEqual(pending.read_text(), 'interrupted-original')
        self.assertEqual(len(list(self.capture.iterdir())), 1)
        self.assertIn('incomplete_capture_original', process.stderr)

    def test_second_invocation_cannot_overwrite_or_join_the_first_job(self):
        self.launch('dotagents_observe_context launcher_input "$0"\nprintf first\\n\n', 'first.sh')
        original = (self.capture / 'launcher_input.json').read_bytes()
        process = self.launch('dotagents_observe_context launcher_input "$0"\n'
                              'dotagents_observe_context wrapper_after_nvm "$0"\nprintf second\\n\n', 'second.sh')
        self.assertEqual((self.capture / 'launcher_input.json').read_bytes(), original)
        self.assertEqual(list(self.capture.iterdir()), [self.capture / 'launcher_input.json'])
        self.assertIn('stage_already_recorded', process.stderr)
        self.assertIn('different_launcher_invocation', process.stderr)

    def test_wrong_parent_is_rejected_before_reading_other_process_or_writing(self):
        process = subprocess.run(['/usr/bin/python3', str(ROOT / 'bin/factory-update-context-observer.py'),
                                  '--phase', 'launcher_input', '--parent-pid', '999999',
                                  '--entry', str(ROOT / 'bin/setup-linux-factory.sh'),
                                  '--output-dir', str(self.capture), '--expires-at', self.env['DOTAGENTS_UPDATE_CONTEXT_EXPIRES_AT']],
                                 cwd=self.home, env=self.env, capture_output=True, text=True, timeout=10)
        self.assertEqual(process.returncode, 1)
        self.assertIn('caller_is_not_direct_parent', process.stderr)
        self.assertEqual(list(self.capture.iterdir()), [])

    def test_source_hooks_observe_existing_boundaries_and_never_add_a_restore(self):
        common = (ROOT / 'bin/setup-linux-common.sh').read_text()
        function = common[common.index('run_scheduled_update() {'):common.index('\nbackup_managed_config()')]
        source_call = function.index('. "$NVM_DIR/nvm.sh"')
        self.assertLess(function.index('dotagents_observe_context wrapper_before_nvm'), source_call)
        self.assertGreater(function.index('dotagents_observe_context wrapper_after_nvm'), source_call)
        writer = (ROOT / 'bin/agents-update.sh').read_text()
        self.assertLess(writer.index('dotagents_observe_context writer_input'), writer.index('. "$NVM_DIR/nvm.sh"'))
        self.assertLess(writer.index('dotagents_observe_context writer_after_nvm'), writer.index('mkdir -p "$LOG_DIR"'))
        self.assertEqual(writer.count('. "$NVM_DIR/nvm.sh"'), 1)
        helper = (ROOT / 'bin/factory-update-context-observer.sh').read_text()
        self.assertNotIn('nvm.sh', helper)
        self.assertNotIn('npm prefix', helper)
        self.assertNotIn('npm root', helper)


if __name__ == '__main__':
    unittest.main()

import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

if sys.platform == 'win32':
    # Policy tests are portable; Linux owns the actual advisory file locks.
    sys.modules['fcntl'] = types.SimpleNamespace(LOCK_EX=1, LOCK_NB=2, flock=lambda *args: None)
spec = importlib.util.spec_from_file_location('publisher', Path(__file__).with_name('publisher.py'))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
SHA = 'a' * 40
RUN = '22222222-2222-4222-8222-222222222222'
CONFIG = {'repository': 'https://gitee.com/example/YuanPlan', 'branch': 'main',
          'yuanci_origin': 'https://ci.example.com', 'yuanci_project_id': '11111111-1111-4111-8111-111111111111',
          'token_file': '/etc/yuanplan-release/token', 'state_dir': '/var/lib/yuanplan-release',
          'deployment_root': '/opt/yuanplan', 'release_script': '/usr/local/lib/yuanplan-release/release.sh'}

def check(id=1, **values):
    result = {'id': id, 'name': 'YuanCI/' + RUN, 'head_sha': SHA, 'status': 'completed', 'conclusion': 'success',
              'details_url': CONFIG['yuanci_origin'] + '/projects/' + CONFIG['yuanci_project_id'] + '/runs/' + RUN,
              'output': {'summary': 'Run succeeded\nYUANCI_SOURCE_V1 ' + json.dumps({'event': 'push', 'ref': 'refs/heads/main', 'commit': SHA})}}
    result.update(values)
    return result

class PolicyTests(unittest.TestCase):
    def test_exact_main_success(self):
        self.assertEqual(p.select_check([check()], SHA, CONFIG)['id'], 1)

    def test_latest_failed_queued_cancelled_blocks_old_success(self):
        for values in ({'conclusion': 'failure'}, {'status': 'queued'}, {'conclusion': 'cancelled'}):
            self.assertIsNone(p.select_check([check(), check(2, **values)], SHA, CONFIG))

    def test_different_project_sha_origin_or_old_output_rejected(self):
        for values in ({'head_sha': 'b'*40}, {'details_url': 'https://other.test'}, {'output': {}}, {'name': 'OtherCI/' + RUN}):
            self.assertIsNone(p.select_check([check(**values)], SHA, CONFIG))

    def test_non_main_and_non_push_do_not_authorize_deploy(self):
        for event, ref in [('push', 'refs/heads/feature'), ('pull_request', 'refs/heads/main'), ('manual', 'refs/heads/main')]:
            source = {'event': event, 'ref': ref, 'commit': SHA}
            self.assertIsNone(p.select_check([check(output={'summary': 'YUANCI_SOURCE_V1 ' + json.dumps(source)})], SHA, CONFIG))

    def test_duplicate_and_invalid_source_markers_rejected(self):
        for summary in ('YUANCI_SOURCE_V1 invalid', check()['output']['summary'] + '\n' + check()['output']['summary']):
            self.assertIsNone(p.select_check([check(output={'summary': summary})], SHA, CONFIG))

    def test_invalid_configuration_rejected(self):
        for key, value in [('branch', 'dev'), ('repository', 'https://evil.test/owner/repo'),
                           ('yuanci_project_id', '00000000-0000-0000-0000-000000000000')]:
            with self.assertRaises(ValueError):
                p.validate(dict(CONFIG, **{key: value}))

    def test_crash_or_failed_attempt_is_not_repeated(self):
        with tempfile.TemporaryDirectory() as temp:
            state = Path(temp)
            (state / (SHA + '.json')).write_text('{"status":"deploying"}')
            api = types.SimpleNamespace(head=lambda: SHA, checks=lambda _: self.fail('Should not check or deploy again'))
            self.assertEqual(p.tick(dict(CONFIG, state_dir=temp), api), 'already-attempted')

    def test_main_moved_during_fetch_blocks_deployment(self):
        with tempfile.TemporaryDirectory() as temp:
            api = types.SimpleNamespace(head=lambda: SHA, checks=lambda _: [check()])
            with patch.object(p, 'command'), patch.object(p.subprocess, 'check_output', return_value=('b'*40+'\n').encode()), patch.object(p, 'deploy') as deploy:
                result = p.tick(dict(CONFIG, state_dir=temp, deployment_root=temp,
                                     token_file=str(Path(temp) / 'token'), release_script=str(Path(temp) / 'release.sh')), api)
                self.assertEqual(result, 'main-moved')
                deploy.assert_not_called()

health_spec = importlib.util.spec_from_file_location('public_health_url', Path(__file__).with_name('public_health_url.py'))
health = importlib.util.module_from_spec(health_spec)
health_spec.loader.exec_module(health)

class PublicHealthTests(unittest.TestCase):
    def resolve(self, url):
        return health.public_health_url({'services': {'app': {'environment': {'APP_URL': url, 'AUTH_SECRET': 'must-not-be-emitted'}}}})

    def test_configured_instance_used(self):
        self.assertEqual(self.resolve('https://projects.example.com'), 'https://projects.example.com/api/health')

    def test_path_and_port_preserved(self):
        self.assertEqual(self.resolve('https://projects.example.com:8443/work/'), 'https://projects.example.com:8443/work/api/health')

    def test_unsafe_urls_rejected(self):
        for url in ['http://projects.example.com', 'https://user:secret@projects.example.com', 'https://projects.example.com?a=secret', 'https://projects.example.com#fragment']:
            with self.assertRaises(ValueError):
                self.resolve(url)

    def test_missing_configuration_rejected(self):
        with self.assertRaises(KeyError):
            health.public_health_url({'services': {'app': {'environment': {}}}})

if __name__ == '__main__':
    unittest.main()

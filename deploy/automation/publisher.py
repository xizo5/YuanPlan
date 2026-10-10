#!/usr/bin/env python3
"""Poll Gitee main and publish only its latest successful YuanCI check. No dependencies."""
import argparse
import contextlib
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import uuid

SHA = re.compile(r'[0-9a-f]{40}\Z')
COMPONENT = re.compile(r'[A-Za-z0-9_.-]{1,128}\Z')

def validate(config):
    repo = urllib.parse.urlsplit(config['repository'])
    parts = repo.path.strip('/').removesuffix('.git').split('/')
    if repo.scheme != 'https' or repo.netloc != 'gitee.com' or repo.query or repo.fragment or len(parts) != 2:
        raise ValueError('repository must be https://gitee.com/owner/repository')
    if not all(COMPONENT.fullmatch(p) and p not in ('.', '..') for p in parts):
        raise ValueError('Invalid repository path')
    if config.get('branch') != 'main':
        raise ValueError('Only main deployment is allowed')
    if uuid.UUID(config['yuanci_project_id']).int == 0:
        raise ValueError('Set the imported YuanCI project ID')
    origin = urllib.parse.urlsplit(config['yuanci_origin'])
    if origin.scheme != 'https' or not origin.netloc or origin.path not in ('', '/') or origin.query or origin.fragment:
        raise ValueError('yuanci_origin must be an HTTPS origin')
    for key in ('token_file', 'state_dir', 'deployment_root', 'release_script'):
        if not Path(config[key]).is_absolute():
            raise ValueError(f'{key} must be absolute')
    return parts

def select_check(checks, sha, config):
    """Fail closed on incomplete/failed later reruns and mismatched project/run links."""
    prefix = config['yuanci_origin'].rstrip('/') + '/projects/' + config['yuanci_project_id'] + '/runs/'
    matching = []
    for check in checks:
        name = check.get('name', '')
        if not name.startswith('YuanCI/') or check.get('head_sha') != sha:
            continue
        try:
            run_id = str(uuid.UUID(name.removeprefix('YuanCI/')))
        except (ValueError, AttributeError):
            continue
        if name != 'YuanCI/' + run_id or check.get('details_url') != prefix + run_id:
            continue
        summary = (check.get('output') or {}).get('summary', '')
        markers = [line.removeprefix('YUANCI_SOURCE_V1 ') for line in summary.splitlines()
                   if line.startswith('YUANCI_SOURCE_V1 ')]
        try:
            source = json.loads(markers[0]) if len(markers) == 1 else None
        except (ValueError, TypeError):
            continue
        if source != {'event': 'push', 'ref': 'refs/heads/main', 'commit': sha}:
            continue
        if isinstance(check.get('id'), int) and check['id'] > 0:
            matching.append(check)
    if not matching:
        return None
    latest = max(matching, key=lambda c: c['id'])
    return latest if latest.get('status') == 'completed' and latest.get('conclusion') == 'success' else None

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('Gitee redirect refused')

class Gitee:
    def __init__(self, owner, repo, token):
        self.base = f'https://gitee.com/api/v5/repos/{owner}/{repo}'
        self.token = token
        self.opener = urllib.request.build_opener(NoRedirect())

    def get(self, path, query=None):
        query = dict(query or {}, access_token=self.token)
        request = urllib.request.Request(self.base + path + '?' + urllib.parse.urlencode(query),
                                         headers={'Accept': 'application/json', 'User-Agent': 'YuanPlan-publisher/1'})
        # Never log exceptions containing the credential-bearing request URL.
        with self.opener.open(request, timeout=15) as response:
            body = response.read(2 * 1024 * 1024 + 1)
        if len(body) > 2 * 1024 * 1024:
            raise ValueError('Gitee response too large')
        return json.loads(body)

    def head(self):
        sha = self.get('/branches/main')['commit']['sha']
        if not isinstance(sha, str) or not SHA.fullmatch(sha):
            raise ValueError('Invalid main SHA')
        return sha

    def checks(self, sha):
        checks = []
        for page in range(1, 11):
            rows = self.get(f'/commits/{sha}/check-runs', {'filter': 'all', 'per_page': 100, 'page': page})
            if not isinstance(rows, list):
                raise ValueError('Unexpected check-runs response')
            checks.extend(rows)
            if len(rows) < 100:
                return checks
        raise ValueError('Too many check runs; refusing incomplete selection')

def atomic_json(path, value):
    temp = path.with_suffix('.tmp')
    with temp.open('w', encoding='utf-8') as output:
        os.chmod(temp, 0o600)
        json.dump(value, output)
        output.flush()
        os.fsync(output.fileno())
    temp.replace(path)

def command(args, timeout=300, env=None):
    # Git errors can contain remote strings; only expose a stable error code.
    result = subprocess.run(args, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=timeout)
    if result.returncode:
        raise RuntimeError('Source preparation failed')

def deploy(args):
    process = subprocess.Popen(args, start_new_session=True)
    def stop():
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)
            process.wait()
    def interrupted(signum, frame):
        stop()
        raise RuntimeError('Deployment interrupted')
    previous = signal.signal(signal.SIGTERM, interrupted)
    try:
        if process.wait(timeout=3600):
            raise RuntimeError('Deployment failed; maintenance and backup retained')
    except subprocess.TimeoutExpired:
        stop()
        raise RuntimeError('Deployment timed out') from None
    finally:
        signal.signal(signal.SIGTERM, previous)

def tick(config, api):
    state = Path(config['state_dir'])
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (state / 'publisher.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 'busy'
        sha = api.head()
        record = state / (sha + '.json')
        if record.exists():
            return 'already-attempted'
        deployed = Path(config['deployment_root']) / 'DEPLOYED_COMMIT'
        if deployed.exists():
            previous = deployed.read_text().strip()
            if re.fullmatch(r'[0-9a-f]{7,40}', previous) and sha.startswith(previous):
                return 'already-deployed'
        check = select_check(api.checks(sha), sha, config)
        if check is None:
            return 'waiting-for-ci'
        owner, repo = validate(config)
        git_dir = state / 'source.git'
        # Read-only Gitee deploy key and known_hosts are configured on this host.
        git_env = {k: os.environ[k] for k in ('PATH', 'HOME', 'LANG') if k in os.environ}
        git_env.update(GIT_TERMINAL_PROMPT='0', GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null',
                       GIT_SSH_COMMAND='ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes')
        if not git_dir.exists():
            command(['git', 'init', '--bare', str(git_dir)], env=git_env)
        remote = f'git@gitee.com:{owner}/{repo}.git'
        command(['git', '--git-dir', str(git_dir), 'fetch', '--no-tags', remote,
                 '+refs/heads/main:refs/heads/main'], env=git_env)
        fetched = subprocess.check_output(['git', '--git-dir', str(git_dir), 'rev-parse', 'refs/heads/main'], env=git_env).decode().strip()
        if fetched != sha or api.head() != sha:
            return 'main-moved'
        archive = state / (sha + '.tar')
        command(['git', '--git-dir', str(git_dir), 'archive', '--format=tar', '--output=' + str(archive), sha], env=git_env)
        # Recheck immediately before publication; a new queued/failed run blocks it.
        check = select_check(api.checks(sha), sha, config)
        if check is None or api.head() != sha:
            archive.unlink()
            return 'ci-or-main-changed'
        value = {'sha': sha, 'check_id': check['id'], 'status': 'deploying', 'started_at': int(time.time())}
        atomic_json(record, value)  # crashes do not silently repeat migrations
        try:
            deploy(['/bin/bash', config['release_script'], sha, str(archive), config['deployment_root']])
            value['status'] = 'success'
            return 'published-' + sha
        except BaseException:
            value['status'] = 'failed'
            raise
        finally:
            value['finished_at'] = int(time.time())
            atomic_json(record, value)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--check-config', action='store_true')
    args = parser.parse_args()
    try:
        config = json.loads(Path(args.config).read_text())
        owner, repo = validate(config)
        if args.check_config:
            print('Configuration valid')
            return 0
        token = Path(config['token_file']).read_text().strip()
        if not token or len(token) > 4096 or re.search(r'\s', token):
            raise ValueError('Invalid token file')
        print(tick(config, Gitee(owner, repo, token)), flush=True)
        return 0
    except Exception:
        print('Publisher stopped: check configuration, credentials, API availability or protected deployment logs', file=sys.stderr)
        return 1

if __name__ == '__main__':
    sys.exit(main())

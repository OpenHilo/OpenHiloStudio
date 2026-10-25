#!/usr/bin/env python3
"""Rebuild pinned core archives from public Git source and any explicitly pinned patches.

Runs only in a new temporary directory; never changes installed or vendored packages.
Use Node 22/24 on PATH. Network is needed for Git and npm dependencies.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parent.parent
PIN = ROOT / 'vendor' / 'openhilo'
manifest = json.loads((PIN / 'manifest.json').read_text())
work = Path(tempfile.mkdtemp(prefix='openhilo-core-source-')).resolve()
source, home, packs = work / 'source', work / 'home', work / 'archives'
home.mkdir(); packs.mkdir()
# No account configuration, model credentials or global Git configuration is inherited.
env = {key: os.environ[key] for key in ('PATH', 'SystemRoot', 'LANG', 'LC_ALL', 'TMPDIR') if key in os.environ}
env.update(HOME=str(home), USERPROFILE=str(home), GIT_CONFIG_GLOBAL=os.devnull,
           GIT_CONFIG_SYSTEM=os.devnull, GIT_TERMINAL_PROMPT='0',
           npm_config_cache=str(work / 'npm-cache'))

def digest(data):
    return hashlib.sha256(data).hexdigest()

def command(label, args, cwd=work):
    result = subprocess.run(args, cwd=cwd, env=env, capture_output=True, timeout=900)
    (work / (label + '.log')).write_bytes(result.stdout + result.stderr)
    if result.returncode:
        # CI runners are disposable: expose isolated check diagnostics before exit.
        print((result.stdout + result.stderr).decode('utf-8', errors='replace'), file=sys.stderr)
        raise RuntimeError('%s failed; inspect %s' % (label, work / (label + '.log')))
    return result.stdout

def contents(file):
    result = {}
    with tarfile.open(file) as archive:
        for member in archive.getmembers():
            if member.name.startswith('/') or '..' in Path(member.name).parts or member.issym() or member.islnk():
                raise ValueError('Unsafe archive member')
            if member.isfile():
                result[member.name] = {'sha256': digest(archive.extractfile(member).read()), 'mode': member.mode & 0o777}
    return result

print('Public source verification: %s' % work, flush=True)
command('clone', ['git', '-c', 'credential.helper=', 'clone', '--no-checkout', manifest['sourceRepository'], str(source)])
command('checkout', ['git', 'checkout', '--detach', manifest['sourceCommit']], source)
assert command('revision', ['git', 'rev-parse', 'HEAD'], source).decode().strip() == manifest['sourceCommit']
for index, patch in enumerate(manifest['patches']):
    file = PIN / patch['file']
    assert digest(file.read_bytes()) == patch['sha256'], 'Patch integrity mismatch'
    command('patch-%s' % index, ['git', 'apply', '--check', str(file)], source)
    command('apply-%s' % index, ['git', 'apply', str(file)], source)
command('install', ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], source)
command('build', ['npm', 'run', 'build:packages'], source)
# The core's offline runner isolates fixtures and guards live provider/network access.
command('test', ['node', 'scripts/test-offline.cjs'], source)
rows = []
for package in manifest['packages']:
    # A clean build can create CLI files after npm's bin-link chmod has run.
    # Normalize only declared executable entries before packing, matching npm installs.
    package_root = source / package['previousSource']
    metadata = json.loads((package_root / 'package.json').read_text())
    bins = metadata.get('bin', {})
    for entry in ([bins] if isinstance(bins, str) else bins.values()):
        executable = package_root / entry
        executable.chmod(executable.stat().st_mode | 0o111)
    bundled = PIN / package['file']
    assert digest(bundled.read_bytes()) == package['sha256'], 'Archive integrity mismatch'
    packed = json.loads(command('pack-' + package['name'].split('/')[1],
        ['npm', 'pack', '--ignore-scripts', '--json', '--pack-destination', str(packs)],
        source / package['previousSource']))[0]
    expected, actual = contents(bundled), contents(packs / packed['filename'])
    differences = [name for name in sorted(set(expected) | set(actual)) if expected.get(name) != actual.get(name)]
    rows.append({'package': package['name'], 'files': len(actual), 'differences': differences})
    print('%s: %s' % (package['name'], 'MATCH' if not differences else 'DIFFERENT'), flush=True)
report = {'sourceRepository': manifest['sourceRepository'], 'sourceCommit': manifest['sourceCommit'],
          'patches': manifest['patches'], 'packages': rows,
          'comparison': 'File bytes and permissions; archive container metadata is not compared.'}
(work / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
if any(row['differences'] for row in rows):
    raise RuntimeError('Core archive content differs from public source reconstruction; see result.json')
print('All pinned core package contents reproduce from the declared public source (%s patches).' % len(manifest['patches']), flush=True)

#!/usr/bin/env python3
"""Check distributable source, generated bundles and vendored archives.

This is a regression guard, not a substitute for manual secret/license review.
Only locations and rule names are reported, never matching credential values.
"""
from pathlib import Path
import re
import tarfile
import subprocess

ROOT = Path(__file__).resolve().parent.parent
SKIP = {'.git', 'node_modules', 'coverage', 'test-results', 'playwright-report', '__pycache__'}
RULES = {
    'personal-home-path': re.compile(r'/Users/[A-Za-z0-9_.-]+/|/home/(?!runner/)[A-Za-z0-9_.-]+/|[A-Za-z]:\\Users\\[^\\\s]+\\'),
    'private-key': re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
    'credential-pattern': re.compile(r'gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:proj-)?[A-Za-z0-9_-]{25,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{20,}'),
    'credential-in-url': re.compile(r'https?://[^\s/:]+:[^\s/@]+@'),
}
issues, counts = [], {'files': 0, 'archives': 0}

def private_file(file):
    return file.name.startswith('.env') or file.suffix.lower() in {'.db', '.sqlite', '.sqlite3', '.jsonl', '.log', '.mp4', '.mov', '.webm', '.pem', '.key'} or file.name.endswith(('.db-wal', '.db-shm', '.sqlite-wal', '.sqlite-shm', '.sqlite3-wal', '.sqlite3-shm'))

def inspect(name, data):
    counts['files'] += 1
    # Binary framing and UTF-16 BOMs must not hide otherwise recognizable secrets.
    texts = [data.decode('utf8', errors='replace')]
    if data.startswith((b'\xff\xfe\x00\x00', b'\x00\x00\xfe\xff')):
        texts.append(data.decode('utf-32', errors='replace'))
    elif data.startswith((b'\xff\xfe', b'\xfe\xff')):
        texts.append(data.decode('utf-16', errors='replace'))
    for text in texts:
        for rule, pattern in RULES.items():
            for match in pattern.finditer(text):
                issues.append('%s:%s: %s' % (name, text.count('\n', 0, match.start()) + 1, rule))

# A local dependency/build folder is excluded from traversal, but must never hide
# a file deliberately added to the public Git tree. Export scans need no Git.
if (ROOT / '.git').exists():
    result = subprocess.run(['git', '-C', str(ROOT), 'ls-files', '-z'], capture_output=True)
    if result.returncode:
        issues.append('Git tracked-file inventory could not be read')
    else:
        for raw in result.stdout.split(b'\0'):
            if not raw:
                continue
            name = raw.decode('utf8', errors='replace')
            if any(part in SKIP | {'dist'} for part in Path(name).parts):
                issues.append(name + ': tracked private or generated directory')

def walk(directory):
    for file in sorted(directory.iterdir()):
        if file.name in SKIP:
            continue
        relative = str(file.relative_to(ROOT))
        if file.is_symlink():
            issues.append(relative + ': unexpected source symlink'); continue
        if file.is_dir():
            walk(file); continue
        if private_file(file):
            issues.append(relative + ': private or runtime file')
        inspect(relative, file.read_bytes())
        if file.suffix == '.tgz':
            counts['archives'] += 1
            with tarfile.open(file) as archive:
                seen = set()
                for member in archive.getmembers():
                    name = relative + '!' + member.name
                    canonical = str(Path(member.name))
                    if canonical in seen:
                        issues.append(name + ': duplicate archive member'); continue
                    seen.add(canonical)
                    if member.name.startswith('/') or '..' in Path(member.name).parts or not (member.isfile() or member.isdir()):
                        issues.append(name + ': unsafe archive member'); continue
                    if member.isfile():
                        if private_file(Path(member.name)):
                            issues.append(name + ': private or runtime file')
                        inspect(name, archive.extractfile(member).read())

walk(ROOT)
for issue in issues:
    print(issue)
print('Privacy guard: %s files, %s archives, %s findings.' % (counts['files'], counts['archives'], len(issues)))
raise SystemExit(1 if issues else 0)

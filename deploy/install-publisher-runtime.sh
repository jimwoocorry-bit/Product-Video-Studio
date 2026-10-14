#!/bin/sh
# Run in the PVS image with the separate, reviewed source mounted at /opt/pvs-publisher.
# This installs program dependencies only. Never copy Windows venvs or cookies.
set -eu
cd /opt/pvs-publisher
test -f pyproject.toml
test -f pvs_bridge.py
test -f conf.py
test -f uv.lock
test ! -e .venv
python3 - <<'PY'
from pathlib import Path
import re
import tomllib
project = tomllib.loads(Path('pyproject.toml').read_text())
packages = tomllib.loads(Path('uv.lock').read_text())['package']
constraints = []
for requirement in project['project']['dependencies']:
    name = re.match(r'[A-Za-z0-9_.-]+', requirement).group().lower().replace('_', '-')
    pinned = re.fullmatch(r'[A-Za-z0-9_.-]+\s*==\s*([A-Za-z0-9_.+-]+)', requirement)
    if pinned:
        constraints.append(name + '==' + pinned.group(1))
        continue
    versions = {p['version'] for p in packages if p['name'] == name and 'registry' in p.get('source', {})}
    assert len(versions) == 1, f'Expected one reviewed version for {name}'
    constraints.append(name + '==' + versions.pop())
Path('pvs-install-constraints.txt').write_text('\n'.join(constraints) + '\n')
PY
python3 -m venv .venv
.venv/bin/python -m pip install --disable-pip-version-check -c pvs-install-constraints.txt .
.venv/bin/python -m pip freeze > pvs-installed-requirements.txt
# Linux-only display adaptation of the reviewed external integration branch.
.venv/bin/python - <<'PY'
from pathlib import Path
import shutil
import site
import sys
assert sys.platform == 'linux'
changes = [
    ('    max_checks: int = 60,', '    max_checks: int = 240,'),
    ('            browser = await playwright.chromium.launch(headless=headless, channel="chromium")\n            context = await browser.new_context()',
     '            browser = await playwright.chromium.launch(headless=headless, channel="chromium", args=["--start-maximized", "--force-device-scale-factor=0.75", "--disable-dev-shm-usage"])\n            context = await browser.new_context(no_viewport=True)'),
]
paths = [Path('uploader/douyin_uploader/main.py')]
paths += [Path(p) / 'uploader/douyin_uploader/main.py' for p in site.getsitepackages()]
for path in paths:
    if not path.is_file():
        continue
    before = path.read_text()
    after = before
    for old, new in changes:
        if new in after:
            continue
        assert after.count(old) == 1, f'Unexpected publisher source: {path}'
        after = after.replace(old, new)
    if after != before:
        backup = path.with_suffix('.py.before-pvs-linux')
        if not backup.exists():
            shutil.copy2(path, backup)
        path.write_text(after)
print('Linux publisher login display adapted; QR wait is eight minutes.')
PY
PLAYWRIGHT_BROWSERS_PATH=/opt/pvs-publisher/browsers .venv/bin/python -m patchright install chromium
SAU_RUNTIME_HOME=/tmp/pvs-publisher-install-check .venv/bin/sau-pvs probe

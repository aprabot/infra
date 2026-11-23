#!/usr/bin/env python3
"""Build every Lambda package into .build/<name>/ for CDK to upload.

Lambda code comes from a git commit of the sibling aprabot/homepage repo
(default HEAD), never its working tree, so uncommitted work can't be deployed by accident. forecast.py comes from a
pinned commit of the sibling aprabot/forecast repo.

  python3 scripts/package.py            # everything
  python3 scripts/package.py chat-api   # just some
  REF=<commit> HOMEPAGE_REPO=<path> FORECAST_REPO=<path> python3 scripts/package.py
"""
import io, os, shutil, subprocess, sys, tarfile, tempfile, zipfile
from pathlib import Path

INFRA = Path(__file__).resolve().parent.parent
BUILD = INFRA / '.build'
REPO = Path(os.environ.get('HOMEPAGE_REPO', INFRA.parent / 'homepage'))
REF = os.environ.get('REF', 'HEAD')
FORECAST_REPO = Path(os.environ.get('FORECAST_REPO', INFRA.parent / 'forecast'))
# The forecast.py each model Lambda runs. These match what is live; they
# should be the same commit, so move both together on the next model release.
FORECAST_COMMIT = {'scenario-runner': 'c266c89', 'explain-runner': '3965619'}
PLAIN = ['forecast-api', 'insights-api', 'scenarios-api', 'amplify-oauth', 'amplify-campaigns',
         'amplify-sync-dispatcher', 'amplify-sync-worker']
ALL = PLAIN + ['chat-api'] + list(FORECAST_COMMIT)
# Source of libgomp.so.1, which Amazon Linux lacks and LightGBM needs.
LIBGOMP_WHEEL = 'scikit-learn==1.7.2'
# scipy submodules LightGBM never imports (see lambda/scenario-runner/README.md).
SCIPY_UNUSED = ('cluster constants datasets differentiate fft fftpack integrate interpolate io misc ndimage '
                'odr optimize signal spatial special stats').split()


def run(*cmd, cwd=None):
    return subprocess.run(cmd, cwd=cwd, check=True, stdout=subprocess.PIPE).stdout


def source(name, dest):
    """Committed files of lambda/<name>, minus its README."""
    tar = tarfile.open(fileobj=io.BytesIO(run('git', 'archive', REF, f'lambda/{name}', cwd=REPO)))
    for m in tar.getmembers():
        rel = Path(m.name).relative_to(f'lambda/{name}') if m.name.startswith(f'lambda/{name}/') else None
        if m.isfile() and rel and rel.name != 'README.md' and '__pycache__' not in rel.parts:
            out = dest / rel
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(tar.extractfile(m).read())


def pip(requirements, dest, *platforms):
    run(sys.executable, '-m', 'pip', 'install', '-q', '--disable-pip-version-check', '--no-deps', '--no-compile',
        '--implementation', 'cp', '--python-version', '3.12', '--only-binary=:all:',
        *[a for p in platforms for a in ('--platform', p)], '--target', str(dest), '-r', str(requirements))


def prune(root):
    for d in list(root.rglob('__pycache__')):
        shutil.rmtree(d, ignore_errors=True)


def model_base():
    """Python dependencies shared by the two model Lambdas."""
    base = BUILD / '_model'
    if base.exists():
        shutil.rmtree(base)
    base.mkdir(parents=True)
    pip(INFRA / 'packages/model.txt', base, 'manylinux_2_28_x86_64', 'manylinux_2_27_x86_64',
        'manylinux_2_17_x86_64', 'manylinux2014_x86_64')
    for sub in SCIPY_UNUSED:
        shutil.rmtree(base / 'scipy' / sub, ignore_errors=True)
    prune(base)
    # "tests"/"test" only: numpy.testing is imported at runtime.
    for d in [d for d in base.rglob('*') if d.is_dir() and d.name in ('tests', 'test')]:
        shutil.rmtree(d, ignore_errors=True)
    for f in base.rglob('*.pyi'):
        f.unlink()
    with tempfile.TemporaryDirectory() as tmp:
        run(sys.executable, '-m', 'pip', 'download', '-q', '--disable-pip-version-check', '--no-deps', '--implementation', 'cp',
            '--python-version', '3.12', '--only-binary=:all:', '--platform', 'manylinux2014_x86_64', '-d', tmp, LIBGOMP_WHEEL)
        with zipfile.ZipFile(next(Path(tmp).glob('*.whl'))) as z:
            member = next(n for n in z.namelist() if n.startswith('scikit_learn.libs/libgomp'))
            (base / 'lib').mkdir()
            (base / 'lib/libgomp.so.1').write_bytes(z.read(member))
            (base / 'lib/libgomp.so.1').chmod(0o755)
    return base


def main(names):
    for repo, var in ((REPO, 'HOMEPAGE_REPO'), (FORECAST_REPO, 'FORECAST_REPO')):
        if not (repo / '.git').exists():
            sys.exit(f'{repo} is not a git checkout. Set {var}.')
    unknown = set(names) - set(ALL)
    if unknown:
        sys.exit(f'Unknown Lambda: {", ".join(sorted(unknown))}. Choose from: {", ".join(ALL)}')
    dirty = run('git', 'status', '--porcelain', '--untracked-files=no', '--', 'lambda', cwd=REPO).decode().strip()
    if dirty:
        print(f'note: uncommitted changes under homepage/lambda/ are NOT packaged (building from {REF}):\n{dirty}')
    commit = run('git', 'rev-parse', '--short', REF, cwd=REPO).decode().strip()
    base = model_base() if set(names) & set(FORECAST_COMMIT) else None
    for name in names:
        dest = BUILD / name
        if dest.exists():
            shutil.rmtree(dest)
        if name in FORECAST_COMMIT:
            shutil.copytree(base, dest)
            (dest / 'forecast.py').write_bytes(run('git', 'show', f'{FORECAST_COMMIT[name]}:forecast.py', cwd=FORECAST_REPO))
        else:
            dest.mkdir(parents=True)
            if name == 'chat-api':
                pip(INFRA / 'packages/chat-api.txt', dest)
        source(name, dest)
        prune(dest)
        mb = sum(f.stat().st_size for f in dest.rglob('*') if f.is_file()) / 1e6
        if mb > 250:
            sys.exit(f'{name} is {mb:.0f} MB unzipped; Lambda allows 250 MB.')
        print(f'{name:26s} {mb:7.1f} MB  from {commit}')
    if base:
        shutil.rmtree(base)


main(sys.argv[1:] or ALL)

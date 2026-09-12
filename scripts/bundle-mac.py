#!/usr/bin/env python3
"""Bundle the complete non-system dylib closure into Nimbus.app, then ad-hoc sign."""
import os
from pathlib import Path
import shutil
import subprocess

root = Path(__file__).resolve().parents[1]
macos_dir = root / 'src-tauri/target/release/bundle/macos'
apps = sorted(macos_dir.glob('*.app'), key=lambda p: p.stat().st_mtime, reverse=True)
if not apps:
    raise RuntimeError(f'No .app bundle found in {macos_dir}')
app = apps[0]
exe_candidates = [p for p in (app / 'Contents/MacOS').iterdir() if p.is_file()]
if not exe_candidates:
    raise RuntimeError(f'No executable found in {app / "Contents/MacOS"}')
exe = exe_candidates[0]
frameworks = app / 'Contents/Frameworks'
frameworks.mkdir(parents=True, exist_ok=True)

def run(*args):
    return subprocess.check_output([str(arg) for arg in args], text=True)

def dependencies(path):
    return [line.strip().split(' (compatibility', 1)[0] for line in run('otool', '-L', path).splitlines()[1:]]

def resolve(name, owner):
    if name.startswith('/'): return Path(name)
    if name.startswith('@loader_path/'): return owner.parent / name.removeprefix('@loader_path/')
    if name.startswith('@executable_path/'): return exe.parent / name.removeprefix('@executable_path/')
    if name.startswith('@rpath/'):
        leaf = name.removeprefix('@rpath/')
        custom_prefix = os.environ.get('NIMBUS_MPV_PREFIX')
        candidates = [owner.parent]
        if custom_prefix:
            candidates.append(Path(custom_prefix) / 'lib')
        candidates.extend([Path('/opt/homebrew/lib'), Path('/usr/local/lib')])
        lines = run('otool', '-l', owner).splitlines()
        for i, line in enumerate(lines):
            if line.strip() == 'cmd LC_RPATH':
                value = lines[i+2].strip().removeprefix('path ').split(' (offset',1)[0]
                value = value.replace('@loader_path', str(owner.parent)).replace('@executable_path', str(exe.parent))
                candidates.insert(0,Path(value))
        for base in candidates:
            if (base/leaf).exists(): return base/leaf
    raise RuntimeError(f'Cannot resolve dependency {name} required by {owner.name}')

seen = {}
queue = [(exe,exe)]
while queue:
    original,target = queue.pop()
    for name in dependencies(original):
        if name.startswith(('/System/Library/', '/usr/lib/')): continue
        dependency = resolve(name, original).resolve()
        if dependency == original.resolve(): continue # dylib's own install name
        destination = frameworks / dependency.name
        previous = seen.get(destination.name)
        if previous and previous != dependency: raise RuntimeError(f'Dylib basename collision: {destination.name}')
        if not previous:
            seen[destination.name] = dependency
            shutil.copy2(dependency,destination)
            destination.chmod(0o755)
            subprocess.run(['install_name_tool','-id',f'@rpath/{destination.name}',str(destination)],check=True)
            queue.append((dependency,destination))
        replacement = f'@executable_path/../Frameworks/{destination.name}' if target == exe else f'@loader_path/{destination.name}'
        subprocess.run(['install_name_tool','-change',name,replacement,str(target)],check=True)
for binary in [*frameworks.iterdir(),exe]:
    remaining = [name for name in dependencies(binary) if name.startswith(('/opt/homebrew/','/usr/local/'))]
    if remaining: raise RuntimeError(f'Unbundled dependencies in {binary.name}: {remaining}')
    subprocess.run(['codesign','--force','--sign','-',str(binary)],check=True,stdout=subprocess.DEVNULL)
subprocess.run(['codesign','--force','--deep','--sign','-','--identifier','app.cove.desktop',str(app)],check=True)
subprocess.run(['codesign','--verify','--deep','--strict',str(app)],check=True)
print(f'Bundled and verified {len(seen)} libraries in {app}')

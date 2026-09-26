import hashlib,json,subprocess,sys
from pathlib import Path
root=Path.cwd(); phase=sys.argv[1]; dest=root/'docs/frontend/evidence'/phase
if phase=='VD0':
 paths=[p for p in subprocess.check_output(['git','ls-files','-z'],text=True).split('\0') if p.endswith('.png')]
 (dest/'historical-hashes.json').write_text(json.dumps({p:hashlib.sha256((root/p).read_bytes()).hexdigest() for p in paths},indent=2)+'\n')
entries={str(p.relative_to(dest)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(dest.rglob('*')) if p.is_file() and p.name!='SHA256SUMS.json'}
(dest/'SHA256SUMS.json').write_text(json.dumps(entries,indent=2)+'\n')

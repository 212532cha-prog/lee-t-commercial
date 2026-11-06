"""Independent ZIP reader: reject missing, duplicate, unexpected or altered sources."""
import glob
import hashlib
import json
import zipfile

archives = glob.glob('dist/*-candidate.zip')
assert len(archives) == 1, 'Exactly one candidate archive is required'
with zipfile.ZipFile(archives[0]) as archive:
    names = archive.namelist()
    assert len(names) == len(set(names)), 'Duplicate archive members'
    manifest = json.loads(archive.read('warehouse-inventory/CANDIDATE-MANIFEST.json'))
    assert manifest['candidate'] is True
    expected = {'warehouse-inventory/CANDIDATE-MANIFEST.json'}
    for entry in manifest['files']:
        path = entry['path']
        assert not path.startswith('/') and '..' not in path.split('/')
        name = 'warehouse-inventory/' + path
        expected.add(name)
        data = archive.read(name)
        assert len(data) == entry['bytes']
        assert hashlib.sha256(data).hexdigest() == entry['sha256']
    assert set(names) == expected
    assert 'warehouse-inventory/docs/deployment/install-and-migrate.md' in expected
    assert 'warehouse-inventory/package-lock.json' in expected
    print(f"Candidate verified: {len(manifest['files'])} source files; deployment still requires device acceptance.")

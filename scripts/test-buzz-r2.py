import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('r2', Path(__file__).with_name('buzz-r2.py'))
r2 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r2)


class MemoryStore(r2.Store):
    def __init__(self):
        self.objects = {}
        self.revision = 0
        self.fail = False
        self.race = False

    def get(self, key):
        if key not in self.objects:
            return None
        data, rev = self.objects[key]
        return {'Body': io.BytesIO(data), 'ETag': str(rev)}

    def put(self, key, body, *, etag=None, immutable=True):
        if key == 'latest.json' and self.fail:
            raise RuntimeError('transport failure')
        if key == 'latest.json' and self.race:
            self.objects[key] = (b'{"version":"9.0.0"}', 999)
        old = self.objects.get(key)
        if (etag and (old is None or str(old[1]) != etag)) or (not etag and old):
            raise RuntimeError('precondition failed')
        data = body.read() if hasattr(body, 'read') else body
        self.revision += 1
        self.objects[key] = (data, self.revision)


class R2Test(unittest.TestCase):
    def setUp(self):
        self.store = MemoryStore()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.directory = Path(self.tmp.name)
        for platform in r2.updater.PLATFORMS:
            name = f'Buzz_1.2.3_{platform}.app.tar.gz'
            (self.directory / name).write_bytes(b'archive')
            (self.directory / (name + '.sig')).write_text('signed')
        self.addCleanup(patch.stopall)
        patch.object(r2.updater, 'gh', return_value='a'*40).start()
        self.public = patch.object(r2, 'public_verify').start()

    def publish(self):
        r2.publish(self.store, '1.2.3', self.directory, 'a'*40)

    def test_fetch_factory_content_addressed_artifacts(self):
        prefix = 'linux/' + 'a' * 40 + '/' + 'b' * 64 + '/attempt-2'
        data = b'remote build'
        sha = hashlib.sha256(data).hexdigest()
        name = 'buzz-linux.tar.gz'
        key = f'{prefix}/{sha}/{name}'
        self.store.put(key, data)
        self.store.put(f'{prefix}/artifacts.json', r2.encode({name: {'sha256': sha, 'size': len(data), 'key': key}}))
        output = self.directory / 'fetched'
        r2.fetch(self.store, prefix, output)
        self.assertEqual((output / name).read_bytes(), data)
        self.store.objects[f'{prefix}/artifacts.json'] = (r2.encode({name: {'sha256': sha, 'size': len(data), 'key': 'other/build/file'}}), 100)
        with self.assertRaisesRegex(ValueError, 'escapes'):
            r2.fetch(self.store, prefix, self.directory / 'bad')

    def test_publish_retry_is_identical(self):
        self.publish()
        old = dict(self.store.objects)
        self.publish()
        self.assertEqual(old, self.store.objects)
        self.assertIn('releases/1.2.3/release.json', old)

    def test_immutable_artifact_cannot_be_replaced(self):
        self.publish()
        next(self.directory.glob('*.gz')).write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            self.publish()

    def test_failed_public_read_never_marks_release_ready(self):
        self.public.side_effect = RuntimeError('public unavailable')
        with self.assertRaises(RuntimeError):
            self.publish()
        self.assertNotIn('releases/1.2.3/release.json', self.store.objects)

    def test_promote_and_retry(self):
        self.publish()
        r2.promote(self.store, '1.2.3')
        old = dict(self.store.objects)
        r2.promote(self.store, '1.2.3')
        self.assertEqual(old, self.store.objects)
        self.assertEqual(self.store.document('latest.json')[0], self.store.document('promotions/1.2.3.json')[0])

    def test_failed_feed_write_preserves_old_feed_and_retry(self):
        self.publish()
        previous = b'{"version":"1.2.2"}'
        self.store.put('latest.json', previous)
        self.store.fail = True
        with self.assertRaises(RuntimeError):
            r2.promote(self.store, '1.2.3')
        self.assertEqual(self.store.document('latest.json')[0], previous)
        self.store.fail = False
        r2.promote(self.store, '1.2.3')

    def test_concurrent_promotion_cannot_overwrite_newer(self):
        self.publish()
        self.store.put('latest.json', b'{"version":"1.2.2"}')
        self.store.race = True
        with self.assertRaisesRegex(RuntimeError, 'precondition'):
            r2.promote(self.store, '1.2.3')
        self.assertEqual(json.loads(self.store.document('latest.json')[0])['version'], '9.0.0')

    def test_downgrade_rejected(self):
        self.publish()
        self.store.put('latest.json', b'{"version":"1.2.4"}')
        with self.assertRaisesRegex(ValueError, 'downgrade'):
            r2.promote(self.store, '1.2.3')

    def test_incomplete_release_rejected(self):
        with self.assertRaisesRegex(ValueError, 'incomplete'):
            r2.promote(self.store, '1.2.3')

    def test_signature_and_source_are_bound(self):
        self.publish()
        key = 'releases/1.2.3/Buzz_1.2.3_darwin-aarch64.app.tar.gz.sig'
        self.store.objects[key] = (b'other signature', 999)
        with self.assertRaisesRegex(ValueError, 'Signature differs'):
            r2.promote(self.store, '1.2.3')
        with patch.object(r2.updater, 'gh', return_value='b'*40):
            with self.assertRaisesRegex(ValueError, 'source tag'):
                r2.promote(self.store, '1.2.3')

    def test_private_roundtrip(self):
        r2.upload(self.store, 'validation/sha/run/platform', self.directory)
        with tempfile.TemporaryDirectory() as tmp:
            r2.fetch(self.store, 'validation/sha/run/platform', Path(tmp))
            for original in self.directory.iterdir():
                self.assertEqual(original.read_bytes(), (Path(tmp) / original.name).read_bytes())
            with self.assertRaisesRegex(ValueError, 'Duplicate artifact'):
                r2.fetch(self.store, 'validation/sha/run/platform', Path(tmp))

    def test_mixed_build_attempts_and_publisher_retry(self):
        prefixes = []
        for attempt, platform in enumerate(r2.updater.PLATFORMS, 1):
            with tempfile.TemporaryDirectory() as tmp:
                directory = Path(tmp)
                (directory / f"{platform}.tar.gz").write_bytes(platform.encode())
                prefix = f"desktop/sha/run/{attempt}/{platform}"
                r2.upload(self.store, prefix, directory)
                prefixes.append(prefix)
        for _publisher_attempt in (2, 3):
            with tempfile.TemporaryDirectory() as tmp:
                for prefix in prefixes:
                    r2.fetch(self.store, prefix, Path(tmp))
                self.assertEqual(len(list(Path(tmp).iterdir())), 2)
        workflow = Path(__file__).parents[1] / '.github/workflows/enrichlayer-desktop-release.yml'
        source = workflow.read_text()
        self.assertIn('needs.arm64.outputs.artifact-prefix', source)
        self.assertIn('needs.intel.outputs.artifact-prefix', source)
        self.assertNotIn('GITHUB_RUN_ATTEMPT', source)

    def test_sdk_conditional_write_and_cache_contract(self):
        from unittest.mock import Mock
        store = object.__new__(r2.Store)
        store.bucket = 'test'
        store.client = Mock()
        store.put('latest.json', b'feed', etag='old', immutable=False)
        args = store.client.put_object.call_args.kwargs
        self.assertEqual(args['IfMatch'], 'old')
        self.assertEqual(args['CacheControl'], 'no-store')
        self.assertNotIn('IfNoneMatch', args)
        store.put('releases/1.2.3/file', b'data')
        self.assertEqual(store.client.put_object.call_args.kwargs['IfNoneMatch'], '*')

    def test_corrupt_public_response_fails(self):
        # Exercise the real HTTP verification seam, including redirect refusal.
        patch.stopall()
        response = io.BytesIO(b'bad')
        response.geturl = lambda: r2.PUBLIC + '/test'
        with patch.object(r2.urllib.request, 'urlopen', return_value=response):
            with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                r2.public_verify('test', {'sha256': hashlib.sha256(b'good').hexdigest(), 'size': 4})


if __name__ == '__main__':
    unittest.main()

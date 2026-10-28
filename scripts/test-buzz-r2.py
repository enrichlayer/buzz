import base64
from contextlib import contextmanager
import hashlib
import importlib.util
import io
import json
import os
import stat
import subprocess
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('r2', Path(__file__).with_name('buzz-r2.py'))
r2 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r2)
spec = importlib.util.spec_from_file_location('fixture', Path(__file__).with_name('test-enrichlayer-minisign.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


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
            name = r2.updater.asset_name('1.2.3', platform)
            (self.directory / name).write_bytes(fixture.DATA)
            (self.directory / (name + '.sig')).write_text(fixture.PREHASHED_SIG)
        for arch in ("aarch64", "x86_64"):
            (self.directory / f"Buzz_1.2.3_darwin-{arch}.dmg").write_bytes(b"installer")
        self.addCleanup(patch.stopall)
        self.key = patch.object(r2.minisign, 'pinned_public_key', return_value=fixture.PUBLIC_KEY).start()
        patch.object(r2.updater, 'gh', return_value='a'*40).start()
        self.public = patch.object(r2, 'public_verify').start()
        self.extracted = patch.object(
            r2.cli_sidecar, '_extracted_cli',
            return_value=('usr/bin/buzz', {
                'sha256': hashlib.sha256(b'fixture-cli').hexdigest(),
                'size': len(b'fixture-cli'),
            }, 0o755),
        ).start()
        self.write_sidecar(
            f"desktop/{'a'*40}/12345/2/linux-x86_64")

    def write_sidecar(self, prefix):
        image_name = r2.updater.asset_name('1.2.3', 'linux-x86_64')
        image_path = self.directory / image_name
        signature_path = self.directory / (image_name + '.sig')
        image = image_path.read_bytes()
        signature = signature_path.read_bytes()
        receipt = {
            'schema_version': 1,
            'kind': 'enrichlayer-buzz-cli-sidecar',
            'repository': 'enrichlayer/buzz',
            'version': '1.2.3',
            'source_sha': 'a' * 40,
            'platform': 'linux-x86_64',
            'build': {
                'workflow_ref': ('enrichlayer/buzz/.github/workflows/'
                                 'enrichlayer-auto-release.yml@refs/heads/main'),
                'workflow_sha': 'a' * 40,
                'run_id': prefix.split('/')[2],
                'run_attempt': prefix.split('/')[3],
                'r2_prefix': prefix,
            },
            'installer': {
                'filename': image_name,
                'sha256': hashlib.sha256(image).hexdigest(),
                'size': len(image),
            },
            'signature': {
                'filename': image_name + '.sig',
                'sha256': hashlib.sha256(signature).hexdigest(),
                'size': len(signature),
                'updater_public_key_sha256': hashlib.sha256(
                    fixture.PUBLIC_KEY.encode()).hexdigest(),
            },
            'executable': {
                'path': 'usr/bin/buzz',
                'sha256': hashlib.sha256(b'fixture-cli').hexdigest(),
                'size': len(b'fixture-cli'),
                'mode': '0755',
            },
        }
        (self.directory / r2.cli_sidecar_name('1.2.3')).write_bytes(r2.encode(receipt))

    def publish(self):
        r2.publish(self.store, '1.2.3', self.directory, 'a'*40)

    def test_private_candidate_receipt_uses_the_existing_producer_allowlist(self):
        sidecar = self.directory / r2.cli_sidecar_name('1.2.3')
        receipt = json.loads(sidecar.read_bytes())
        for workflow_ref in r2.cli_sidecar.WORKFLOW_REFS:
            with self.subTest(workflow_ref=workflow_ref):
                receipt['build']['workflow_ref'] = workflow_ref
                sidecar.write_bytes(r2.encode(receipt))
                r2.validate_cli_sidecar_directory(
                    self.directory, '1.2.3', 'a' * 40,
                    f"desktop/{'a'*40}/12345/2/linux-x86_64")

    def test_private_candidate_receipt_rejects_unrecognized_caller_before_extraction(self):
        sidecar = self.directory / r2.cli_sidecar_name('1.2.3')
        receipt = json.loads(sidecar.read_bytes())
        for workflow_ref in (
                'enrichlayer/buzz/.github/workflows/macos-intel-canary.yml@refs/heads/unreviewed',
                'other/buzz/.github/workflows/macos-intel-canary.yml@refs/heads/main',
                'enrichlayer/buzz/.github/workflows/unrecognized.yml@refs/heads/main'):
            with self.subTest(workflow_ref=workflow_ref):
                receipt['build']['workflow_ref'] = workflow_ref
                sidecar.write_bytes(r2.encode(receipt))
                self.extracted.reset_mock()
                with self.assertRaisesRegex(ValueError, 'release workflow'):
                    r2.validate_cli_sidecar_directory(
                        self.directory, '1.2.3', 'a' * 40)
                self.extracted.assert_not_called()

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
        with patch.object(r2.minisign, 'verify_stream'), self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            self.publish()

    def test_publish_refuses_archive_not_signed_by_pinned_key(self):
        for platform in r2.updater.PLATFORMS:
            with self.subTest(platform=platform):
                archive = self.directory / r2.updater.asset_name('1.2.3', platform)
                archive.write_bytes(b'unsigned build')
                try:
                    with self.assertRaisesRegex(ValueError, 'sidecar|verification failed'):
                        self.publish()
                    self.assertEqual(self.store.objects, {})
                finally:
                    archive.write_bytes(fixture.DATA)

    def test_promote_reverifies_archives_against_pinned_key(self):
        self.publish()
        other = fixture.wrap(['untrusted comment: other key', base64.b64encode(
            b'Ed' + bytes(range(1, 9)) + bytes.fromhex(fixture.RFC[0][0])).decode()])
        self.key.return_value = other
        with self.assertRaisesRegex(ValueError, 'different updater key|verification failed'):
            r2.promote(self.store, '1.2.3')
        self.assertIsNone(self.store.get('latest.json'))

    def test_promote_rejects_oversized_signature_metadata_before_download(self):
        self.publish()
        prefix = 'releases/1.2.3/'
        image_name = r2.updater.asset_name('1.2.3', 'linux-x86_64')
        signature_name = image_name + '.sig'
        sidecar_name = r2.cli_sidecar_name('1.2.3')
        release_key = prefix + 'release.json'
        sidecar_key = prefix + sidecar_name
        release = json.loads(self.store.objects[release_key][0])
        sidecar = json.loads(self.store.objects[sidecar_key][0])
        oversized = r2.cli_sidecar.MAX_SIGNATURE + 1
        release['artifacts'][signature_name]['size'] = oversized
        sidecar['signature']['size'] = oversized
        sidecar_bytes = r2.encode(sidecar)
        self.store.objects[sidecar_key] = (sidecar_bytes, self.store.objects[sidecar_key][1])
        release['artifacts'][sidecar_name] = {
            'sha256': hashlib.sha256(sidecar_bytes).hexdigest(), 'size': len(sidecar_bytes)}
        self.store.objects[release_key] = (r2.encode(release), self.store.objects[release_key][1])
        self.store.put('latest.json', b'{"version":"1.2.2"}')
        original_get = self.store.get

        def get(key):
            if key == prefix + signature_name:
                self.fail('oversized signature metadata reached object download')
            return original_get(key)

        with patch.object(self.store, 'get', side_effect=get), \
             self.assertRaisesRegex(ValueError, 'Signature size outside release limit'):
            r2.promote(self.store, '1.2.3')
        self.assertEqual(self.store.document('latest.json')[0], b'{"version":"1.2.2"}')

    def test_promote_bounds_signature_body_before_verification(self):
        self.publish()
        prefix = 'releases/1.2.3/'
        signature_key = prefix + r2.updater.asset_name('1.2.3', 'linux-x86_64') + '.sig'
        self.store.put('latest.json', b'{"version":"1.2.2"}')
        original_get = self.store.get

        class ObservedBody(io.BytesIO):
            def __init__(self, data):
                super().__init__(data)
                self.bytes_read = 0
                self.largest_request = 0

            def read(self, size=-1):
                self.largest_request = max(self.largest_request, size)
                chunk = super().read(size)
                self.bytes_read += len(chunk)
                return chunk

        body = ObservedBody(b'x' * (r2.cli_sidecar.MAX_SIGNATURE + 1))

        def get(key):
            if key == signature_key:
                return {'Body': body, 'ETag': 'tampered'}
            return original_get(key)

        with patch.object(self.store, 'get', side_effect=get), \
             self.assertRaisesRegex(ValueError, 'Signature exceeds release limit'):
            r2.promote(self.store, '1.2.3')
        self.assertLessEqual(body.bytes_read, r2.cli_sidecar.MAX_SIGNATURE + 1)
        self.assertLessEqual(body.largest_request, r2.cli_sidecar.MAX_SIGNATURE + 1)
        self.assertEqual(self.store.document('latest.json')[0], b'{"version":"1.2.2"}')

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
                self.assertEqual(len(list(Path(tmp).iterdir())), len(r2.updater.PLATFORMS))
        workflow = Path(__file__).parents[1] / '.github/workflows/enrichlayer-desktop-release.yml'
        source = workflow.read_text()
        self.assertIn('needs.arm64.outputs.artifact-prefix', source)
        self.assertIn('needs.intel.outputs.artifact-prefix', source)
        self.assertIn('needs.linux.outputs.artifact-prefix', source)
        self.assertIn('needs.windows.outputs.artifact-prefix', source)
        self.assertNotIn('GITHUB_RUN_ATTEMPT', source.split('  publish:')[1])

    def test_new_run_resumes_original_build_bytes_after_partial_publish(self):
        prefixes = []
        for platform in r2.updater.PLATFORMS:
            with tempfile.TemporaryDirectory() as tmp:
                directory = Path(tmp)
                for path in self.directory.glob(f"*{platform}*"):
                    (directory / path.name).write_bytes(path.read_bytes())
                prefix = f"desktop/{'a'*40}/10/1/{platform}"
                if platform == 'linux-x86_64':
                    # The immutable receipt must identify the exact Linux build
                    # whose catalog is uploaded beside it.
                    image_name = r2.updater.asset_name('1.2.3', platform)
                    image = (directory / image_name).read_bytes()
                    signature = (directory / (image_name + '.sig')).read_bytes()
                    receipt = json.loads((directory / r2.cli_sidecar_name('1.2.3')).read_bytes())
                    receipt['build'].update(run_id='10', run_attempt='1', r2_prefix=prefix)
                    receipt['installer'].update(sha256=hashlib.sha256(image).hexdigest(), size=len(image))
                    receipt['signature'].update(sha256=hashlib.sha256(signature).hexdigest(), size=len(signature))
                    (directory / r2.cli_sidecar_name('1.2.3')).write_bytes(r2.encode(receipt))
                r2.upload(self.store, prefix, directory)
                prefixes.append(prefix)
        with tempfile.TemporaryDirectory() as tmp:
            r2.stage_release(self.store, '1.2.3', Path(tmp), 'a'*40, prefixes)
            self.public.side_effect = RuntimeError('public unavailable')
            with self.assertRaises(RuntimeError):
                r2.publish(self.store, '1.2.3', Path(tmp), 'a'*40)
        self.public.side_effect = None
        with tempfile.TemporaryDirectory() as tmp:
            # A new workflow's different/missing builds cannot replace pinned inputs.
            r2.stage_release(self.store, '1.2.3', Path(tmp), 'a'*40, ['new-run']*4)
            r2.publish(self.store, '1.2.3', Path(tmp), 'a'*40)
            self.assertIn('releases/1.2.3/release.json', self.store.objects)
        with tempfile.TemporaryDirectory() as tmp, self.assertRaisesRegex(ValueError, 'wrong source'):
            r2.stage_release(self.store, '1.2.3', Path(tmp), 'b'*40, prefixes)

    def test_missing_installer_prevents_public_write(self):
        (self.directory / 'Buzz_1.2.3_darwin-aarch64.dmg').unlink()
        with self.assertRaisesRegex(ValueError, 'team installer'):
            self.publish()
        self.assertEqual(self.store.objects, {})

    def test_missing_or_mismatched_cli_sidecar_prevents_public_write(self):
        sidecar = self.directory / r2.cli_sidecar_name('1.2.3')
        sidecar.unlink()
        with self.assertRaisesRegex(ValueError, 'team installer'):
            self.publish()
        self.assertEqual(self.store.objects, {})

        self.write_sidecar(f"desktop/{'a'*40}/12345/2/linux-x86_64")
        receipt = json.loads(sidecar.read_bytes())
        receipt['installer']['sha256'] = '0' * 64
        sidecar.write_bytes(r2.encode(receipt))
        with self.assertRaisesRegex(ValueError, 'does not match release artifact'):
            self.publish()
        self.assertEqual(self.store.objects, {})

    def test_publish_rejects_sidecar_executable_from_another_image(self):
        sidecar = self.directory / r2.cli_sidecar_name('1.2.3')
        receipt = json.loads(sidecar.read_bytes())
        receipt['executable']['sha256'] = hashlib.sha256(b'another-cli').hexdigest()
        sidecar.write_bytes(r2.encode(receipt))
        with self.assertRaisesRegex(ValueError, 'executable differs from the signed AppImage'):
            self.publish()
        self.assertEqual(self.store.objects, {})

    def test_promote_reextracts_cli_from_the_immutable_signed_image(self):
        self.publish()
        self.extracted.return_value = ('usr/bin/buzz', {
            'sha256': hashlib.sha256(b'another-cli').hexdigest(),
            'size': len(b'another-cli'),
        }, 0o755)
        with self.assertRaisesRegex(ValueError, 'executable differs from the signed AppImage'):
            r2.promote(self.store, '1.2.3')
        self.assertIsNone(self.store.get('latest.json'))

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

    def test_public_verification_identifies_release_client(self):
        patch.stopall()
        data = b'public artifact'
        response = io.BytesIO(data)
        response.geturl = lambda: r2.PUBLIC + '/test'

        def serve(request, *, timeout):
            self.assertEqual(request.full_url, r2.PUBLIC + '/test')
            self.assertEqual(request.get_header('User-agent'), 'EnrichLayer-Buzz-Release/1.0')
            self.assertEqual(request.get_header('Cache-control'), 'no-cache')
            self.assertEqual(timeout, 120)
            return response

        with patch.object(r2.urllib.request, 'urlopen', side_effect=serve):
            r2.public_verify('test', {'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)})

    def test_corrupt_public_response_fails(self):
        # Exercise the real HTTP verification seam, including redirect refusal.
        patch.stopall()
        response = io.BytesIO(b'bad')
        response.geturl = lambda: r2.PUBLIC + '/test'
        with patch.object(r2.urllib.request, 'urlopen', return_value=response):
            with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                r2.public_verify('test', {'sha256': hashlib.sha256(b'good').hexdigest(), 'size': 4})


class RetainedCliTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.root.chmod(0o700)
        self.image = self.root / "verified.AppImage"
        self.image.write_bytes(b"signature verification is a caller prerequisite")
        self.destination = self.root / "retained-buzz"
        self.data = b"actual-discovered-cli\n"
        self.receipt = {"executable": {
            "path": "opt/actual/buzz", "sha256": hashlib.sha256(self.data).hexdigest(),
            "size": len(self.data), "mode": "0755",
        }}
        self.scratch = None

    @contextmanager
    def extract(self, argv, *, env):
        self.assertEqual(argv, [str(self.image.resolve()), "--appimage-extract"])
        self.assertEqual(set(env), {"PATH", "LANG", "LC_ALL"})
        self.assertEqual(env["LANG"], "C.UTF-8")
        self.assertEqual(env["LC_ALL"], "C.UTF-8")
        with tempfile.TemporaryDirectory(dir=self.root) as temporary:
            self.scratch = Path(temporary)
            self.scratch.chmod(0o700)
            executable = self.scratch / "squashfs-root/opt/actual/buzz"
            executable.parent.mkdir(parents=True)
            executable.write_bytes(self.data)
            executable.chmod(0o755)
            if getattr(self, "alter", None):
                self.alter(executable)
            if getattr(self, "before", None):
                raise self.before
            yield self.scratch
            if getattr(self, "after", None):
                raise self.after

    def verify(self):
        return r2.verify_cli_sidecar_executable(
            self.receipt, self.image, destination=self.destination,
            run_extractor=self.extract)

    def assert_no_output(self):
        self.assertFalse(os.path.lexists(self.destination))
        self.assertEqual(list(self.root.glob(".buzz-cli-*")), [])

    def test_copy_survives_scratch_cleanup_and_preserves_actual_bytes(self):
        with patch.dict(os.environ, {"APPIMAGE_EXTRACT_AND_RUN": "1", "SECRET": "omit"}):
            self.assertIsNone(self.verify())
        self.assertFalse(self.scratch.exists())
        self.assertEqual(self.destination.read_bytes(), self.data)
        self.assertEqual(stat.S_IMODE(self.destination.stat().st_mode), 0o755)
        self.assertEqual(list(self.root.glob(".buzz-cli-*")), [])

    def test_full_tuple_mismatch_refuses_before_copy(self):
        for field, value in (("path", "usr/bin/buzz"), ("sha256", "0" * 64),
                             ("size", len(self.data) + 1), ("mode", "0700")):
            with self.subTest(field=field):
                expected = self.receipt["executable"].copy()
                self.receipt["executable"][field] = value
                try:
                    with self.assertRaisesRegex(ValueError, "differs"):
                        self.verify()
                    self.assert_no_output()
                finally:
                    self.receipt["executable"] = expected

    def test_ambiguous_symlink_and_wrong_mode_entries_refuse(self):
        def duplicate(executable):
            other = executable.parents[2] / "other/buzz"
            other.parent.mkdir()
            other.write_bytes(self.data)
            other.chmod(0o755)

        def symlink(executable):
            executable.unlink()
            executable.symlink_to(self.image)

        for alter in (duplicate, symlink, lambda executable: executable.chmod(0o700)):
            with self.subTest(alter=alter):
                self.alter = alter
                with self.assertRaises(ValueError):
                    self.verify()
                self.assert_no_output()

    def test_existing_destination_and_symlink_preserved(self):
        for symlink in (False, True):
            with self.subTest(symlink=symlink):
                if symlink:
                    self.destination.symlink_to(self.image)
                else:
                    self.destination.write_bytes(b"existing")
                try:
                    with self.assertRaises(FileExistsError):
                        self.verify()
                    if symlink:
                        self.assertTrue(self.destination.is_symlink())
                    else:
                        self.assertEqual(self.destination.read_bytes(), b"existing")
                    self.assertEqual(list(self.root.glob(".buzz-cli-*")), [])
                finally:
                    self.destination.unlink()

    def test_no_replace_commit_race_preserves_winner(self):
        link = os.link

        def race(*args, **kwargs):
            self.destination.write_bytes(b"race winner")
            return link(*args, **kwargs)

        with patch.object(r2.cli_sidecar.os, "link", side_effect=race):
            with self.assertRaises(FileExistsError):
                self.verify()
        self.assertEqual(self.destination.read_bytes(), b"race winner")
        self.assertEqual(list(self.root.glob(".buzz-cli-*")), [])

    def test_callback_failure_or_cancellation_before_commit_has_no_output(self):
        for failure in (RuntimeError("extraction failed"), KeyboardInterrupt()):
            with self.subTest(failure=type(failure)):
                self.before = failure
                with self.assertRaises(type(failure)):
                    self.verify()
                self.assert_no_output()
                self.assertFalse(self.scratch.exists())

    def test_callback_cancellation_after_commit_preserves_verified_copy(self):
        self.after = KeyboardInterrupt()
        with self.assertRaises(KeyboardInterrupt):
            self.verify()
        self.assertEqual(self.destination.read_bytes(), self.data)
        self.assertEqual(stat.S_IMODE(self.destination.stat().st_mode), 0o755)
        self.assertFalse(self.scratch.exists())
        self.assertEqual(list(self.root.glob(".buzz-cli-*")), [])

    def test_changed_source_between_inspection_and_copy_refuses(self):
        retain = r2.cli_sidecar._retain_cli

        def change(executable, destination, expected):
            executable.write_bytes(b"x" * len(self.data))
            return retain(executable, destination, expected)

        with patch.object(r2.cli_sidecar, "_retain_cli", side_effect=change):
            with self.assertRaises(ValueError):
                self.verify()
        self.assert_no_output()

    def test_retention_cancellation_before_commit_cleans_staging(self):
        with patch.object(r2.cli_sidecar.os, "fsync", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.verify()
        self.assert_no_output()
        self.assertFalse(self.scratch.exists())

    def test_nonprivate_or_symlink_destination_parent_refuses(self):
        parent = self.root / "public"
        parent.mkdir(mode=0o755)
        # mkdir is masked by umask; establish the non-private fixture explicitly.
        parent.chmod(0o755)
        self.assertEqual(stat.S_IMODE(parent.stat().st_mode), 0o755)
        self.destination = parent / "buzz"
        with self.assertRaisesRegex(ValueError, "private 0700"):
            self.verify()
        self.assert_no_output()
        parent.rmdir()
        parent.symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "private 0700"):
            self.verify()
        self.assert_no_output()

    def test_callback_can_run_exact_argv_in_fresh_scratch(self):
        self.image.write_text(
            '#!/bin/sh\n'
            '[ "$#" = 1 ] && [ "$1" = --appimage-extract ] || exit 41\n'
            '[ "$PWD" = "$HOME" ] && [ "$PWD" = "$TMPDIR" ] || exit 42\n'
            '[ -z "${APPIMAGE_EXTRACT_AND_RUN+x}" ] || exit 43\n'
            'mkdir -p squashfs-root/opt/actual\n'
            'printf "actual-discovered-cli\\n" > squashfs-root/opt/actual/buzz\n'
            'chmod 755 squashfs-root/opt/actual/buzz\n')

        self.image.chmod(0o700)

        @contextmanager
        def run(argv, *, env):
            with tempfile.TemporaryDirectory(dir=self.root) as temporary:
                scratch = Path(temporary).resolve()
                scratch.chmod(0o700)
                subprocess.run(argv, cwd=scratch,
                               env={**env, "HOME": str(scratch), "TMPDIR": str(scratch)},
                               check=True, timeout=5, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL)
                yield scratch

        with patch.dict(os.environ, {"APPIMAGE_EXTRACT_AND_RUN": "1"}):
            r2.verify_cli_sidecar_executable(
                self.receipt, self.image, destination=self.destination, run_extractor=run)
        self.assertEqual(self.destination.read_bytes(), self.data)

    def test_destination_inside_ephemeral_scratch_refuses(self):
        @contextmanager
        def extract(argv, *, env):
            executable = self.root / "squashfs-root/opt/actual/buzz"
            executable.parent.mkdir(parents=True)
            executable.write_bytes(self.data)
            executable.chmod(0o755)
            yield self.root

        with self.assertRaisesRegex(ValueError, "outside ephemeral"):
            r2.verify_cli_sidecar_executable(
                self.receipt, self.image, destination=self.destination,
                run_extractor=extract)
        self.assert_no_output()

    def test_directory_fsync_failure_preserves_committed_verified_copy(self):
        fsync = os.fsync

        def fail_directory(fd):
            if stat.S_ISDIR(os.fstat(fd).st_mode):
                raise OSError("directory fsync failed")
            return fsync(fd)

        with patch.object(r2.cli_sidecar.os, "fsync", side_effect=fail_directory):
            with self.assertRaisesRegex(OSError, "directory fsync failed"):
                self.verify()
        self.assertEqual(self.destination.read_bytes(), self.data)
        self.assertEqual(stat.S_IMODE(self.destination.stat().st_mode), 0o755)
        self.assertFalse(self.scratch.exists())
        self.assertEqual(list(self.root.glob(".buzz-cli-*")), [])

    def test_callback_does_not_chmod_the_presealed_image(self):
        self.image.chmod(0o555)
        chmod = os.chmod

        def guard(path, *args, **kwargs):
            self.assertNotEqual(Path(path).resolve(), self.image.resolve())
            return chmod(path, *args, **kwargs)

        with patch.object(r2.cli_sidecar.os, "chmod", side_effect=guard):
            self.verify()
        self.assertEqual(stat.S_IMODE(self.image.stat().st_mode), 0o555)

    def test_retention_without_callback_refuses_before_any_extraction_or_chmod(self):
        self.image.chmod(0o555)
        with patch.object(r2.cli_sidecar, "_default_extractor") as default, \
             patch.object(r2.cli_sidecar, "_extracted_cli_file") as extraction, \
             patch.object(r2.cli_sidecar.os, "chmod") as chmod:
            with self.assertRaisesRegex(ValueError, "destination requires run_extractor"):
                r2.verify_cli_sidecar_executable(
                    self.receipt, self.image, destination=self.destination)
            default.assert_not_called()
            extraction.assert_not_called()
            chmod.assert_not_called()
        self.assertEqual(stat.S_IMODE(self.image.stat().st_mode), 0o555)
        self.assert_no_output()

    def test_exclusive_staging_collision_preserves_unowned_file(self):
        collision = self.root / ".buzz-cli-fixed"
        collision.write_bytes(b"preexisting unowned staging bytes")
        before = collision.stat()
        opened_fds = []
        open_file = os.open

        def record_open(*args, **kwargs):
            fd = open_file(*args, **kwargs)
            opened_fds.append(fd)
            return fd

        with patch.object(r2.cli_sidecar.secrets, "token_hex", return_value="fixed"), \
             patch.object(r2.cli_sidecar.os, "open", side_effect=record_open):
            with self.assertRaises(FileExistsError):
                self.verify()
        for fd in opened_fds:
            with self.assertRaises(OSError):
                os.fstat(fd)
        self.assertEqual(collision.read_bytes(), b"preexisting unowned staging bytes")
        after = collision.stat()
        self.assertEqual((before.st_ino, before.st_mode, before.st_size, before.st_mtime_ns),
                         (after.st_ino, after.st_mode, after.st_size, after.st_mtime_ns))
        self.assertFalse(os.path.lexists(self.destination))
        self.assertEqual(list(self.root.glob(".buzz-cli-*")), [collision])
        self.assertFalse(self.scratch.exists())

    def test_callback_only_verification_keeps_none_return(self):
        self.assertIsNone(r2.verify_cli_sidecar_executable(
            self.receipt, self.image, run_extractor=self.extract))
        self.assert_no_output()


if __name__ == '__main__':
    unittest.main()

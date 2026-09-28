"""Offline controls for source-driven Biber text generation and exact matching."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('biber_generated', Path(__file__).resolve().parent.parent / 'scripts/collect-biber-generated-evidence.py')
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


def input_record(name, data):
    return {'path': name, 'bytes': len(data), 'sha256': collector.shared.digest(data)}


class GeneratedEvidence(unittest.TestCase):
    def test_inputs_require_original_complete_bytes(self):
        data = b'original generator\n'
        recipe = {'id': 'example', 'inputs': [input_record('generator.pl', data)]}
        self.assertEqual(collector.inputs_for(recipe, {'generator.pl': data}), {'generator.pl': data})
        for sources in [{}, {'generator.pl': data + b'\n'}, {'generator.pl': data[:-1]}]:
            with self.assertRaisesRegex(ValueError, 'differs from reviewed source'):
                collector.inputs_for(recipe, sources)

    def test_inputs_reject_unsafe_names_case_collisions_and_bounds(self):
        for name in ['../escape', '/absolute', 'a/../../escape']:
            with self.assertRaises(ValueError):
                collector.inputs_for({'id': 'case', 'inputs': [input_record(name, b'x')]}, {name: b'x'})
        inputs = [input_record(n, b'x') for n in ['A.pm', 'a.pm']]
        with self.assertRaisesRegex(ValueError, 'collide'):
            collector.inputs_for({'id': 'case', 'inputs': inputs}, {'A.pm': b'x', 'a.pm': b'x'})
        for name in ['../case', 'A', '', 'a' * 42]:
            with self.assertRaisesRegex(ValueError, 'case name'):
                collector.inputs_for({'id': name, 'inputs': []}, {})
        for count, size in [(0, 0), (17, 1), (1, 4 * 1024 * 1024 + 1)]:
            sources = {str(i): b'x' * size for i in range(count)}
            recipe = {'id': 'case', 'inputs': [input_record(n, d) for n, d in sources.items()]}
            with self.assertRaisesRegex(ValueError, 'audit bounds'): collector.inputs_for(recipe, sources)

    def test_packager_keeps_upstream_methods_verbatim_and_requires_boundaries(self):
        main = b'sub _main_pl_single {\n  return "entry";\n}\nsub _main_pl_reuse {\n  1;\n}\n'
        manifest = b'sub _make_manifest {\n  return "metadata";\n}\n'
        source = b'preamble\n' + main + b'sub DESTROY {\n}\n' + manifest + b'sub next {\n}\n'
        expected = main + b'\n' + manifest[:-1] + b'\n'
        self.assertEqual(collector.packer_methods(source), expected)
        self.assertIn(expected, collector.packer_harness(source))
        for candidate in [source.replace(b'sub DESTROY {\n', b''), source + main, source + manifest]:
            with self.assertRaises(ValueError): collector.packer_methods(candidate)

    def test_manifest_inputs_come_from_payload_with_verified_duplicates(self):
        payload = {'lib/A.pm': b'A', 'lib/B.pm': b'B'}
        duplicate = {'lib/A.pm': {**input_record('ignored', b'A'), 'extraOccurrences': 1}}
        result = json.loads(collector.member_input(payload, duplicate))
        self.assertEqual(result, {'members': ['lib/A.pm', 'lib/B.pm'], 'duplicates': ['lib/A.pm']})
        for key, value in [('sha256', '0' * 64), ('bytes', 2), ('extraOccurrences', 2)]:
            bad = copy.deepcopy(duplicate); bad['lib/A.pm'][key] = value
            with self.assertRaises(ValueError): collector.member_input(payload, bad)
        with self.assertRaises(ValueError): collector.member_input({}, duplicate)
        with self.assertRaises(ValueError): collector.member_input({'../escape': b'x'}, {})

    def test_comparison_preserves_whitespace_differences_and_each_target(self):
        recipe = {'id': 'case', 'outputs': {'output.pm': ['par/a', 'loader/b']}}
        original = b'exact\n'; payload = {'par/a': original, 'loader/b': original}
        matches, unmatched = collector.compare_outputs(recipe, {'output.pm': original}, payload, b'')
        self.assertEqual(len(matches), 2); self.assertEqual(unmatched, [])
        for candidate in [original[:-1], original + b'\n', b'exact\r\n', b' exact\n']:
            matches, unmatched = collector.compare_outputs(recipe, {'output.pm': candidate}, payload, b'')
            self.assertEqual(matches, []); self.assertEqual(len(unmatched), 2)
            self.assertEqual(unmatched[0]['rawGeneratedSha256'], collector.shared.digest(candidate))
        with self.assertRaisesRegex(ValueError, 'Missing reviewed payload target'):
            collector.compare_outputs(recipe, {'output.pm': original}, {}, b'')

    def test_only_reviewed_literal_packager_patch_is_applied(self):
        recipe = {'id': 'case', 'outputs': {'XSLoader.pm': ['par/a']}, 'packagerPatch': 'XSLoader.pm'}
        raw = b'before;\n'; patch = b"'XSLoader.pm' => ['before;' => 'after;'],"
        good, bad = collector.compare_outputs(recipe, {'XSLoader.pm': raw}, {'par/a': b'after;\n'}, patch)
        self.assertEqual(len(good), 1); self.assertEqual(bad, [])
        self.assertNotEqual(good[0]['rawGeneratedSha256'], good[0]['comparedGeneratedSha256'])
        good, bad = collector.compare_outputs(recipe, {'XSLoader.pm': raw}, {'par/a': b'after;\n\n'}, patch)
        self.assertEqual(good, []); self.assertEqual(len(bad), 1)
        with self.assertRaises(ValueError):
            collector.compare_outputs(recipe, {'XSLoader.pm': raw}, {'par/a': raw}, b'')

    def test_outputs_reject_missing_links_and_special_files(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve(); file = root / 'output.pm'
            recipe = {'outputs': {'output.pm': ['par/a']}}
            file.write_bytes(b'original\n')
            self.assertEqual(collector.outputs_for(root, recipe), {'output.pm': b'original\n'})
            file.unlink()
            with self.assertRaises(ValueError): collector.outputs_for(root, recipe)
            file.symlink_to(root / 'missing')
            with self.assertRaises(ValueError): collector.outputs_for(root, recipe)
            file.unlink(); os.mkfifo(file)
            with self.assertRaises(ValueError): collector.outputs_for(root, recipe)
            file.unlink(); (root / 'real').mkdir(); (root / 'real/o').write_bytes(b'x'); (root / 'link').symlink_to(root / 'real')
            with self.assertRaises(ValueError): collector.outputs_for(root, {'outputs': {'link/o': []}})

    def test_output_limits_and_path_checks(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve(); file = root / 'big'
            with file.open('wb') as f: f.truncate(4 * 1024 * 1024 + 1)
            with self.assertRaisesRegex(ValueError, 'audit bounds'):
                collector.outputs_for(root, {'outputs': {'big': []}})
            with self.assertRaisesRegex(ValueError, 'Too many'):
                collector.outputs_for(root, {'outputs': {str(i): [] for i in range(9)}})
            for name in ['../escape', '/absolute']:
                with self.assertRaises(ValueError): collector.outputs_for(root, {'outputs': {name: []}})


if __name__ == '__main__': unittest.main()

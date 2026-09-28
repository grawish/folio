"""Controls for the diagnostic graph reader, including misleading weak paths."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/analyze-renderer-retention.py'

class RetentionAnalysis(unittest.TestCase):
    def fixture(self, root, corrupt=False, wrong_hash=False):
        strings = ['', 'blink::UndoStack', '<div>', 'Text', 'WeakOnly', 'undo', 'child', 'weak']
        nodes = [0, 0, 1, 0, 3, 0,
                 1, 1, 3, 16, 1, 0,
                 1, 2, 5, 64, 1, 2,
                 1, 3, 7, 32, 0, 2,
                 1, 4, 9, 16, 0, 2]
        edges = [0, 5, 6, 2, 7, 18, 2, 7, 24, 1, 0, 12, 0, 6, 18]
        if corrupt: edges[-1] = 31
        meta = {'node_fields': ['type', 'name', 'id', 'self_size', 'edge_count', 'detachedness'],
                'edge_fields': ['type', 'name_or_index', 'to_node'],
                'node_types': [['synthetic', 'native'], 'string', 'number', 'number', 'number', 'number'],
                'edge_types': [['internal', 'element', 'weak'], 'string_or_number', 'node']}
        raw = json.dumps({'snapshot': {'meta': meta, 'node_count': 5, 'edge_count': 5}, 'nodes': nodes, 'edges': edges, 'strings': strings}).encode()
        file = root / 'code.heapsnapshot'
        file.write_bytes(raw)
        artifact = {'label': 'code', 'file': str(file), 'bytes': len(raw), 'sha256': '0' * 64 if wrong_hash else hashlib.sha256(raw).hexdigest(), 'nodes': 5, 'edges': 5}
        (root / 'retention.json').write_text(json.dumps({'completed': False, 'snapshots': [artifact]}))

    def run_reader(self, root):
        return subprocess.run([sys.executable, str(SCRIPT), str(root)], capture_output=True, text=True)

    def test_weak_paths_are_not_retaining_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            run = self.run_reader(root)
            self.assertEqual(run.returncode, 0, run.stderr)
            result = json.loads((root / 'retention-analysis.json').read_text())
            self.assertFalse(result['workflowCompleted'])
            snapshot = result['snapshots'][0]
            self.assertEqual(snapshot['detachedNodes'], 3)
            self.assertEqual(snapshot['detachedSelfBytes'], 112)
            self.assertEqual(snapshot['detachedReachableWithoutWeakEdges'], 2)
            self.assertEqual(snapshot['detachedShortestPathGroups'], {'nativeUndoStack': 2, 'other': 1})
            paths = {item['name']: item for item in snapshot['representativePaths']}
            self.assertEqual(len(paths['Text']['pathFromRoot']), 3)
            self.assertFalse(paths['WeakOnly']['reachableIgnoringWeakEdges'])
            self.assertEqual(paths['WeakOnly']['pathFromRoot'], [])

    def test_invalid_node_offset_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root, corrupt=True)
            self.assertNotEqual(self.run_reader(root).returncode, 0)

    def test_changed_snapshot_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root, wrong_hash=True)
            self.assertNotEqual(self.run_reader(root).returncode, 0)

if __name__ == '__main__':
    unittest.main()

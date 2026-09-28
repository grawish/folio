"""Inspect local diagnostic snapshots; never infer a leak from detachedness alone."""
from pathlib import Path
import collections
import hashlib
import json
import sys

root = Path(sys.argv[1]).resolve()
report = json.loads((root / 'retention.json').read_bytes())
assert report['snapshots'], 'No snapshots were captured.'
results = []
all_detached = []
for artifact in report['snapshots']:
    f = root / Path(artifact['file']).name
    raw = f.read_bytes()
    assert len(raw) == artifact['bytes'] and hashlib.sha256(raw).hexdigest() == artifact['sha256']
    p = json.loads(raw)
    meta = p['snapshot']['meta']
    nf, ef = meta['node_fields'], meta['edge_fields']
    ns, es = len(nf), len(ef)
    n, e, strings = p['nodes'], p['edges'], p['strings']
    assert len(n) == ns * p['snapshot']['node_count'] == ns * artifact['nodes']
    assert len(e) == es * p['snapshot']['edge_count'] == es * artifact['edges']
    nt, et = meta['node_types'][nf.index('type')], meta['edge_types'][ef.index('type')]
    offsets = {name: nf.index(name) for name in ['type', 'name', 'id', 'self_size', 'edge_count', 'detachedness']}
    eoffset = {name: ef.index(name) for name in ['type', 'name_or_index', 'to_node']}
    def field(idx, name): return n[idx + offsets[name]]
    def name(idx): return strings[field(idx, 'name')]
    def kind(idx): return nt[field(idx, 'type')]
    def edge_name(idx):
        value = e[idx + eoffset['name_or_index']]
        return str(value) if et[e[idx + eoffset['type']]] in ['element', 'hidden'] else strings[value]
    beginnings = {}
    pos = 0
    detached = []
    counts = collections.Counter()
    kinds = collections.Counter()
    self_bytes = collections.Counter()
    ids = set()
    for idx in range(0, len(n), ns):
        assert field(idx, 'id') not in ids
        ids.add(field(idx, 'id'))
        assert 0 <= field(idx, 'name') < len(strings)
        assert field(idx, 'self_size') >= 0 and field(idx, 'edge_count') >= 0
        assert field(idx, 'detachedness') in [0, 1, 2]
        beginnings[idx] = pos
        pos += es * field(idx, 'edge_count')
        if field(idx, 'detachedness') == 2:
            detached.append(idx)
            counts[name(idx)] += 1
            kinds[kind(idx)] += 1
            self_bytes[name(idx)] += field(idx, 'self_size')
    assert pos == len(e)
    for idx in range(0, len(e), es):
        target = e[idx + eoffset['to_node']]
        assert target % ns == 0 and 0 <= target < len(n)
        assert 0 <= e[idx + eoffset['type']] < len(et)
        edge_name(idx)
    # One shortest graph path from the synthetic root, ignoring weak edges.
    # This is not a dominator/retained-size calculation or a causal owner claim.
    parents = {0: None}
    queue = collections.deque([0])
    while queue:
        idx = queue.popleft()
        for at in range(beginnings[idx], beginnings[idx] + es * field(idx, 'edge_count'), es):
            if et[e[at + eoffset['type']]] == 'weak': continue
            target = e[at + eoffset['to_node']]
            if target not in parents:
                parents[target] = (idx, at)
                queue.append(target)
    native_paths = collections.Counter()
    for idx in detached:
        current = idx
        chain_names = set()
        while parents.get(current) is not None:
            current = parents[current][0]
            chain_names.add(name(current))
        group = ('nativeUndoStack' if 'blink::UndoStack' in chain_names else
                 'nativeTypingCommand' if 'blink::TypingCommand' in chain_names else 'other')
        native_paths[group] += 1
    examples = []
    # Cover distinct names deterministically; keep all detached ids for cross-snapshot checks.
    chosen = set()
    for idx in detached:
        if name(idx) in chosen: continue
        chosen.add(name(idx))
        chain = []
        current = idx
        while parents.get(current) is not None:
            previous, at = parents[current]
            chain.append({'fromId': field(previous, 'id'), 'fromType': kind(previous), 'fromName': name(previous), 'edgeType': et[e[at + eoffset['type']]], 'edge': edge_name(at), 'toId': field(current, 'id'), 'toType': kind(current), 'toName': name(current)})
            current = previous
        examples.append({'id': field(idx, 'id'), 'name': name(idx), 'selfBytes': field(idx, 'self_size'), 'reachableIgnoringWeakEdges': idx in parents, 'pathFromRoot': list(reversed(chain))})
    detached_ids = {field(idx, 'id') for idx in detached}
    all_detached.append(detached_ids)
    results.append({
        'label': artifact['label'], 'sha256': artifact['sha256'], 'nodeFields': nf, 'edgeFields': ef,
        'nodes': len(n) // ns, 'edges': len(e) // es,
        'detachedNodes': len(detached), 'detachedSelfBytes': sum(field(i, 'self_size') for i in detached),
        'detachedShortestPathGroups': dict(native_paths),
        'detachedKinds': dict(kinds), 'detachedNames': [{'name': key, 'count': value, 'selfBytes': self_bytes[key]} for key, value in counts.most_common()],
        'detachedReachableWithoutWeakEdges': sum(i in parents for i in detached),
        'representativePaths': examples,
        'sameDetachedIdsAsFirstSnapshot': len(detached_ids & all_detached[0]),
    })
    print(artifact['label'], 'nodes', len(n) // ns, 'detached', len(detached), 'bytes', sum(field(i, 'self_size') for i in detached), 'names', counts.most_common(6), flush=True)
result = {'schemaVersion': 1, 'workflowCompleted': bool(report.get('completed')), 'analysisScriptSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), 'retentionReportSha256': hashlib.sha256((root / 'retention.json').read_bytes()).hexdigest(), 'snapshots': results, 'scope': 'Post-collection local snapshots. Detachedness is V8 embedder state (0 unknown, 1 attached, 2 detached). One shortest non-weak graph path is shown for each detached node name; it is not a dominator, complete retained size, causal owner or proof of a leak. Compare with connected DOM, lifecycle, repeat checkpoints and harness roots.'}
(root / 'retention-analysis.json').write_text(json.dumps(result, indent=2) + '\n')

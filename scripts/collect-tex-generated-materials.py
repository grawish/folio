# SPDX-License-Identifier: GPL-2.0-or-later
# Generation rules adapted from TeX Live at 082081a375be008c2e049cd7cf1137314f888b18:
# updmap.pl: Copyright 2011-2021 Norbert Preining; original shell script
# (C) 2002 Thomas Esser, Perl variant by Fabrice Popineau, later adaptations
# by Reinhard Kotucha and Karl Berry.
# TLPOBJ.pm: Copyright 2007-2021 Norbert Preining.
# TLUtils.pm: Copyright 2007-2022 Norbert Preining, Reinhard Kotucha.
# Python audit implementation: Copyright 2026 Folio contributors.
# This standalone developer tool is GPL-2.0-or-later, not Folio's
# noncommercial application license. Full license: resources/tex-resource-notices/
# pgf.doc--gnu-public-license-2.txt. Distributed WITHOUT ANY WARRANTY.
"""Replay three generated TeX files from pinned original inputs, without TeX execution.

Python 3.11+ and curl for first collection; --offline uses verified cached inputs.
The original timestamp and installation path are explicit replay parameters.
"""
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import selectors
import shlex
import subprocess
import tarfile
import tempfile
import time
import zipfile

ROOT = Path(__file__).resolve().parent.parent
BUNDLE_URL = 'https://data1b.fullyjustified.net/tlextras-2022.0r0.tar'
MAX_INPUT = 32 * 1024 * 1024
MAX_INDEX = 16 * 1024 * 1024


def digest(data):return hashlib.sha256(data).hexdigest()


def safe_path(name):
    if not isinstance(name,str) or not name or name.startswith('/') or '\\' in name or ':' in name or any(ord(c)<32 for c in name):
        raise ValueError('Unsafe source path')
    if any(part in ['', '.', '..'] for part in name.split('/')):raise ValueError('Unsafe source path')
    return name


def verify(data, entry):
    if len(data)!=entry['bytes'] or digest(data)!=entry['sha256']:raise ValueError('Input differs from reviewed bytes')
    return data


def reject_links(path):
    if any(p.is_symlink() for p in [path,*path.parents]):raise ValueError('Linked source/output path')


def write(path,data):
    reject_links(path);path.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent,delete=False) as f:
        temporary=Path(f.name)
        try:f.write(data);f.flush();os.fsync(f.fileno())
        except BaseException:temporary.unlink(missing_ok=True);raise
    try:os.replace(temporary,path)
    finally:temporary.unlink(missing_ok=True)


def allowed_url(url, lock):
    commit=lock['upstream']['texliveGitHash'];builder=lock['builderCommit']
    if not re.fullmatch('[a-f0-9]{40}',commit) or not re.fullmatch('[a-f0-9]{40}',builder):raise ValueError('Invalid source commit')
    patterns=[r'https://git\.texlive\.info/texlive/plain/Master/[A-Za-z0-9_./+-]+\?id='+commit,
              r'https://raw\.githubusercontent\.com/tectonic-typesetting/tectonic-texlive-bundles/'+builder+r'/(LICENSE|bundles/tlextras/tlpackages\.txt|bundles/tlextras/tl-profile\.txt)']
    if url not in [BUNDLE_URL,BUNDLE_URL+'.index.gz'] and not any(re.fullmatch(p,url) for p in patterns):
        raise ValueError('Unreviewed source endpoint')
    if '/./' in url or '/../' in url:raise ValueError('Unsafe source URL')
    return url


def fetch(entry, lock):
    args=['curl','--globoff','--fail','--silent','--show-error','--max-time','45','--max-filesize',str(entry['bytes'])]
    status=200
    if 'offset' in entry:
        start=entry['offset']-512;end=entry['offset']+entry['contentBytes']-1
        if start<0 or entry['offset']%512 or end>=lock['upstream']['archiveBytes'] or entry['bytes']!=512+entry['contentBytes']:
            raise ValueError('Invalid source byte range')
        args+=['--range',f'{start}-{end}'];status=206
    trailer=f'\nFOLIO_HTTP_STATUS:{status}'.encode()
    args+=['--write-out','\nFOLIO_HTTP_STATUS:%{http_code}',allowed_url(entry['url'],lock)]
    # Read bounded pipes ourselves as well as using curl's size/time limits.
    child=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    streams=selectors.DefaultSelector();streams.register(child.stdout,selectors.EVENT_READ,'output');streams.register(child.stderr,selectors.EVENT_READ,'error')
    values={'output':bytearray(),'error':bytearray()};deadline=time.monotonic()+50
    try:
        while streams.get_map():
            if time.monotonic()>deadline:raise ValueError('Source download deadline exceeded')
            for key,_ in streams.select(.2):
                chunk=os.read(key.fileobj.fileno(),65536)
                if not chunk:streams.unregister(key.fileobj);continue
                values[key.data].extend(chunk)
                bound=entry['bytes']+len(trailer) if key.data=='output' else 16384
                if len(values[key.data])>bound:raise ValueError('Source download exceeds bounds')
        if child.wait(timeout=2)!=0:raise ValueError('Source download failed: '+values['error'].decode(errors='replace')[:500])
        data=bytes(values['output'])
        if not data.endswith(trailer):raise ValueError('Unexpected source HTTP status or redirect')
        return verify(data[:-len(trailer)],entry)
    finally:
        streams.close()
        if child.poll() is None:child.kill();child.wait()
        child.stdout.close();child.stderr.close()


def get_input(entry, lock, offline):
    if not isinstance(entry['bytes'],int) or not 0<entry['bytes']<=MAX_INPUT:raise ValueError('Invalid source size')
    allowed_url(entry['url'],lock);path=ROOT/'.cache/license-sources/tex-generated'/safe_path(entry['file']);reject_links(path)
    if path.exists():
        if not path.is_file() or path.stat().st_size!=entry['bytes']:raise ValueError('Source cache type/size differs')
        return verify(path.read_bytes(),entry)
    if offline:raise ValueError('Missing offline source: '+entry['file'])
    data=fetch(entry,lock);write(path,data);return data


def index_records(data, lock):
    verify(data,lock['index'])
    with gzip.GzipFile(fileobj=io.BytesIO(data)) as f:raw=f.read(MAX_INDEX+1)
    if len(raw)>MAX_INDEX or len(raw)!=lock['index']['uncompressedBytes']:raise ValueError('Index exceeds reviewed bounds')
    rows={};last_end=0
    for line in raw.decode().splitlines():
        name,offset,size=line.rsplit(' ',2);safe_path(name);offset=int(offset);size=int(size)
        if name in rows or len(rows)>=200000 or offset%512 or offset<last_end+512 or size<0 or offset+size>lock['upstream']['archiveBytes']:
            raise ValueError('Invalid or overlapping index entry')
        rows[name]=(offset,size);last_end=offset+size
    return rows


def member_content(data, entry, index):
    verify(data,entry)
    if index.get(entry['name'])!=(entry['offset'],entry['contentBytes']):raise ValueError('Member differs from bundle index')
    header=tarfile.TarInfo.frombuf(data[:512],encoding='utf-8',errors='strict')
    if not header.isfile() or header.name!=entry['name'] or header.size!=entry['contentBytes'] or len(data)!=512+header.size:
        raise ValueError('Invalid indexed tar member')
    content=data[512:]
    if digest(content)!=entry['contentSha256']:raise ValueError('Changed indexed member content')
    return content


def database_records(raw):
    if len(raw)>MAX_INPUT:raise ValueError('Package database too large')
    records={}
    for block in raw.decode().split('\n\n'):
        if not block.startswith('name '):continue
        name=block.split('\n',1)[0][5:]
        if name in records:raise ValueError('Duplicate package metadata')
        records[name]=block
    if not records:raise ValueError('Missing package metadata')
    return records


def package_selection(records, packages, profile):
    roots=[l.split('#',1)[0].strip() for l in packages.decode().splitlines()];roots=[r for r in roots if r]
    schemes=[l.split()[1] for l in profile.decode().splitlines() if l.startswith('selected_scheme ')]
    if len(schemes)!=1:raise ValueError('Missing bundle installation scheme')
    pending=roots+schemes;selected=set()
    while pending:
        name=pending.pop()
        if name in selected:continue
        if name not in records:raise ValueError('Unknown selected package: '+name)
        selected.add(name)
        pending.extend(l[7:].replace('.ARCH','.x86_64-linux') for l in records[name].splitlines() if l.startswith('depend '))
    return sorted(selected)


def configuration_bytes(records, selected, header, context):
    lines=[]
    for package in selected:
        maps={}
        for line in records[package].splitlines():
            match=re.fullmatch(r'execute add(Map|MixedMap|KanjiMap) (.*)',line)
            if match:maps[match[2]]=match[1]
        lines.extend(f'{kind} {name}\n' for name,kind in sorted(maps.items()))
    stamp=f"# Generated by {context['languageProgram']} on {context['mapLocaltime']}\n".encode()
    return stamp+header+''.join(lines).encode()


def configuration(raw):
    settings={};kinds={}
    for line in raw.splitlines():
        parts=line.split()
        if not parts or parts[0].startswith(b'#'):continue
        if len(parts)!=2:raise ValueError('Unexpected map configuration')
        if parts[0] in [b'Map',b'MixedMap',b'KanjiMap']:
            name=parts[1].decode()
            if name in kinds:raise ValueError('Duplicate map configuration')
            kinds[name]=parts[0].decode()
        else:settings[parts[0].decode()]=parts[1].decode()
    if settings.get('LW35')!='URWkb' or settings.get('pdftexDownloadBase14')!='true':raise ValueError('Unreviewed font transformation mode')
    def replace(name):return re.sub(r'@([^@]+)@',lambda m:settings[m[1]],name)
    expanded={replace(n):kind for n,kind in kinds.items()}
    if len(expanded)!=len(kinds) or 'ps2pk35.map' in expanded:raise ValueError('Colliding expanded map name')
    expanded['ps2pk35.map']='BaseMap';return expanded,settings


def normalized(lines):
    out=[];seen=set()
    for line in lines:
        line=re.sub(rb'\s+',b' ',line)
        if not line.strip():continue
        line=re.sub(rb'\s$',b'',line);line=re.sub(rb'\s*"\s*',b' " ',line)
        # In upstream's final /x expression, unescaped pattern spaces are
        # ignored. It leaves the spaces inside quoted PostScript code intact.
        if line not in seen:out.append(line);seen.add(line)
    return b'\n'.join(out)+b'\n'


def font_maps(kinds, contents, context):
    if set(kinds)!=set(contents):raise ValueError('Incomplete map source set')
    maps={};origins={}
    for name,data in contents.items():
        values={}
        for line in data.split(b'\n'):
            if not line.strip() or line.lstrip().startswith((b'#',b'%')):continue
            pair=line.split(None,1)
            if len(pair)!=2:raise ValueError('Malformed source map')
            values[pair[0]]=pair[1]
        maps[name]=values
        if name!='ps2pk35.map':
            for key in values:
                if key in origins:raise ValueError('Ambiguous cross-map font definition')
                origins[key]=name
    outputs={};prefix=context['installRoot']
    for filename,kind,groups in [('kanjix.map','dvipdfmx',['KanjiMap']),('pdftex.map','pdftex',['BaseMap','MixedMap','Map'])]:
        lines=[]
        for group in groups:
            for name in sorted(n for n,k in kinds.items() if k==group):
                lines.append(b'% '+name.encode());lines.extend(key+b' '+val for key,val in sorted(maps[name].items()))
        if filename=='pdftex.map':lines=[l for l in lines if not l.startswith(b'%|PaintType')]
        source_name='pdftex_dl14.map' if filename=='pdftex.map' else filename
        header=f"% {prefix}/fonts/map/{kind}/updmap/{source_name}:\n% maintained by updmap[-sys] (multi).\n% Don't change this file directly. Use updmap[-sys] instead.\n% See the updmap documentation.\n% A log of the run that created this file is available here:\n% {prefix}/web2c/updmap.log\n".encode()
        outputs[filename]=header+normalized(lines)
    return outputs


def language_bytes(records, selected, header, context):
    lines=[];packages=[]
    for package in selected:
        first=True
        for line in records[package].splitlines():
            if not line.startswith('execute AddHyphen '):continue
            values=shlex.split(line[len('execute AddHyphen '):]);fields={}
            for value in values:
                key,separator,val=value.partition('=')
                if not separator or key in fields or key not in ['name','file','lefthyphenmin','righthyphenmin','synonyms','comment','databases','file_patterns','file_exceptions','luaspecial']:raise ValueError('Malformed language directive')
                fields[key]=val
            if 'dat' not in fields.get('databases','dat,def').split(','):continue
            if first:lines.append('% from '+package+':\n');packages.append(package);first=False
            if fields.get('comment'):lines.append('% '+fields['comment']+'\n')
            lines.append(fields['name']+' '+fields['file']+'\n')
            lines.extend('='+v+'\n' for v in fields.get('synonyms','').split(',') if v)
    stamp=f"% Generated by {context['languageProgram']} on {context['languageLocaltime']}\n".encode()
    return stamp+header+''.join(lines).encode(),packages


def actual_bundle(lock):
    raw=(ROOT/'resources/bundle.lock.json').read_bytes()
    if digest(raw)!=lock['bundleLockSha256']:raise ValueError('Resource lock changed')
    expected=json.loads(raw);runtime=ROOT/'resources/runtime/mac-arm64'
    if (runtime/'bundle.lock.json').read_bytes()!=raw:raise ValueError('Prepared resource lock differs')
    data=(runtime/'bundle.zip').read_bytes();manifest=json.loads((runtime/'manifest.json').read_bytes())
    if digest(data)!=manifest['files']['bundle.zip']:raise ValueError('Runtime bundle differs')
    found={};expanded=0
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        for member in z.infolist():
            name=safe_path(member.filename);expanded+=member.file_size
            if name in found or member.is_dir() or (member.external_attr>>16)&0o170000==0o120000 or len(found)>=1024 or member.file_size>16*1024*1024 or expanded>128*1024*1024:
                raise ValueError('Unsafe or oversized runtime bundle')
            found[name]=z.read(member)
    marker=found.pop('SHA256SUM',None)
    if marker!=digest(json.dumps(expected['files'],separators=(',',':'),ensure_ascii=False).encode()).encode():raise ValueError('Bundle marker differs')
    if set(found)!=set(expected['files']) or any(digest(b)!=expected['files'][n] for n,b in found.items()):raise ValueError('Bundle resource differs')
    if expected['upstreamBundleDigest']!=lock['upstream']['identity']:raise ValueError('Upstream bundle identity differs')
    return found


def collect(offline):
    lock_bytes=(ROOT/'resources/tex-generated-sources.lock.json').read_bytes();lock=json.loads(lock_bytes)
    if lock['schemaVersion']!=1:raise ValueError('Unknown generated-source lock')
    bundle=actual_bundle(lock);direct=set()
    for kind,key in [('font','fontSourceLockSha256'),('resource','resourceSourceLockSha256')]:
        raw=(ROOT/f'resources/tex-{kind}-sources.lock.json').read_bytes()
        if digest(raw)!=lock[key]:raise ValueError('Distribution source lock changed')
        for source in json.loads(raw)['sources']:
            for match in source['matches']:
                name=match['bundle'];verify(bundle[name],match)
                if name in direct:raise ValueError('Duplicate distribution resource mapping')
                direct.add(name)
    retained={};index_data=get_input(lock['index'],lock,offline);index=index_records(index_data,lock);retained['sources/'+lock['index']['file']]=index_data
    members={}
    for entry in lock['members']:
        data=get_input(entry,lock,offline);content=member_content(data,entry,index)
        if entry['name'] in members:raise ValueError('Duplicate bundle provenance member')
        members[entry['name']]=content;retained['sources/'+entry['file']]=data
    for name,key in [('SHA256SUM','identity'),('GITHASH','texliveGitHash'),('SVNREV','texliveSvnRevision')]:
        if members[name].decode().strip()!=lock['upstream'][key]:raise ValueError('Bundle provenance changed')
    by_role={};maps={};seen=set()
    for entry in lock['inputs']:
        name=safe_path(entry['file'])
        if name.casefold() in seen:raise ValueError('Duplicate input filename')
        seen.add(name.casefold());data=get_input(entry,lock,offline);retained['sources/'+name]=data
        if entry['role']=='map':
            if entry['name'] in maps:raise ValueError('Duplicate source map')
            maps[entry['name']]=data
        else:by_role.setdefault(entry['role'],[]).append((entry,data))
    def single(role):
        rows=by_role[role]
        if len(rows)!=1:raise ValueError('Ambiguous replay input role')
        return rows[0][1]
    records=database_records(single('database'));selected=package_selection(records,single('bundle-packages'),single('bundle-profile'))
    for entry in lock['inputs']:
        if entry['role']=='map' and (entry['package'] not in selected or ' '+entry['sourcePath'].removeprefix('Master/') not in records[entry['package']].splitlines()):raise ValueError('Map source not bound to selected package record')
    config=configuration_bytes(records,selected,single('map-header'),lock['context'])
    if config!=members['updmap.cfg']:raise ValueError('Map configuration does not reproduce')
    kinds,settings=configuration(config);outputs=font_maps(kinds,maps,lock['context'])
    if single('language-base')!=members['language.us']:raise ValueError('Language base differs from bundle')
    outputs['language.dat'],languages=language_bytes(records,selected,single('language-base'),lock['context'])
    if set(outputs)!=set(lock['expectedOutputs']) or set(outputs)&direct or direct|set(outputs)!=set(bundle):raise ValueError('Incomplete or overlapping bundle source coverage')
    for name,data in outputs.items():
        verify(data,lock['expectedOutputs'][name])
        if data!=members[name] or data!=bundle[name]:raise ValueError('Generated file differs from runtime')
        retained['regenerated/'+name]=data
    retained['regenerated/updmap.cfg']=config
    license_entry=lock['replayLicense'];retained['licenses/GPL-2.0.txt']=verify((ROOT/safe_path(license_entry['file'])).read_bytes(),license_entry)
    out=ROOT/'artifacts/license-materials/tex-generated'
    for name,data in sorted(retained.items()):write(out/name,data)
    report={'schemaVersion':1,'releaseAuditComplete':False,'scope':lock['scope'],'lockSha256':digest(lock_bytes),'collectorSha256':digest(Path(__file__).read_bytes()),'upstream':lock['upstream'],'context':lock['context'],
            'summary':{'bundledResources':len(bundle),'directDistributionMatches':len(direct),'generatedResourceMatches':len(outputs),'unmappedResources':0,'sourceInputs':len(lock['inputs']),'sourceMapFiles':len(maps),'sourceMapPackages':len({r['package'] for r in lock['inputs'] if r['role']=='map'}),'selectedPackages':len(selected),'languagePackages':len(languages)},
            'selectedPackages':selected,'languagePackages':languages,'mapSettings':settings,'outputs':{n:{'bytes':len(b),'sha256':digest(b),'matchesRuntime':True} for n,b in outputs.items()},'configurationReplay':{'bytes':len(config),'sha256':digest(config),'matchesUpstream':True},
            'evidence':[{'path':n,'bytes':len(b),'sha256':digest(b)} for n,b in sorted(retained.items())],
            'limits':['The full 2.8 GB upstream bundle was not rehashed. Its SHA256SUM entry is a Tectonic bundle identity, not the raw tar archive digest; only selected members, headers, index and recorded identity were checked.',
                      'This is a reviewed Python replay of text-generation rules with recorded historical time/path inputs, not execution of the original Linux installation.',
                      'Exact file provenance does not resolve every map/font license or complete corresponding-source publication, compiler/native attribution, production signing or the final app SBOM.']}
    write(out/'inventory.json',(json.dumps(report,indent=2)+'\n').encode());return report


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--offline',action='store_true');args=parser.parse_args()
    output=ROOT/'artifacts/license-materials/tex-generated'
    try:report=collect(args.offline)
    except Exception as error:
        write(output/'incomplete-inventory.json',(json.dumps({'releaseAuditComplete':False,'error':str(error)},indent=2)+'\n').encode());raise
    (output/'incomplete-inventory.json').unlink(missing_ok=True)
    print(json.dumps(report['summary'],indent=2))

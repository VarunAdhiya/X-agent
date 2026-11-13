#!/usr/bin/env python3
"""Update A/B request expressions while preserving installed credentials/settings."""
import json, subprocess
from pathlib import Path
root=Path(__file__).resolve().parent.parent
base=['docker','compose','exec','-T','n8n']
for file in ['01-topic-discovery.json','02-tweet-generation.json']:
    desired=json.loads((root/'workflows'/file).read_text())
    ident=desired['id']; temporary='/tmp/manual-batches-'+ident+'.json'
    subprocess.run(base+['n8n','export:workflow','--id='+ident,'--output='+temporary],cwd=root,check=True)
    existing=json.loads(subprocess.check_output(base+['cat',temporary],cwd=root))[0]
    for node in existing['nodes']:
        other=next((n for n in desired['nodes'] if n['id']==node['id']),None)
        if other and node['name'] in ['Discover and research','Generate validated batch','Setup notes']:
            node['parameters']=other['parameters']
    subprocess.run(base+['sh','-c','umask 077; cat > "$1"','sh',temporary],input=json.dumps([existing]).encode(),cwd=root,check=True)
    subprocess.run(base+['n8n','import:workflow','--input='+temporary],cwd=root,check=True)
    subprocess.run(base+['n8n','publish:workflow','--id='+ident],cwd=root,check=True)
    subprocess.run(base+['rm','-f',temporary],cwd=root,check=True)

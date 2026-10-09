// Trusted code runs only in CubeSandbox, never in the Worker. Parameters are base64 JSON.
export const remoteScript = String.raw`
import os,sys,json,base64,hashlib,tempfile,subprocess,signal,uuid
p=json.loads(base64.b64decode(sys.argv[1])); op=p['op']; a=p['args']; limit=262144
root='/workspace'
def path(value,write=False):
 if not isinstance(value,str) or '\x00' in value: raise Exception('INVALID_PATH')
 v=value if value.startswith('/') else root+'/'+value
 v=os.path.realpath(v)
 roots=[root] if write or a.get('_workspaceOnly',False) else [root,'/skills']
 if not any(v==r or v.startswith(r+'/') for r in roots): raise Exception('PATH_DENIED')
 return v
def parent(v):
 roots=[root,'/skills']; r=next((r for r in roots if v==r or v.startswith(r+'/')),None)
 if r is None or v==r: raise Exception('INVALID_FILE_PATH')
 parts=os.path.relpath(v,r).split('/')
 fd=os.open(r,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:
  for d in parts[:-1]:
   nextfd=os.open(d,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd); os.close(fd); fd=nextfd
  return fd,parts[-1]
 except:
  os.close(fd); raise
def read(v):
 fd,name=parent(v)
 try:
  ffd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
  with os.fdopen(ffd,'rb') as f:
   if not __import__('stat').S_ISREG(os.fstat(f.fileno()).st_mode): raise Exception('NOT_REGULAR_FILE')
   b=f.read(limit+1)
 finally: os.close(fd)
 if len(b)>limit: raise Exception('FILE_TOO_LARGE')
 return b.decode('utf8')
def write(v,content):
 b=content.encode('utf8')
 if len(b)>limit: raise Exception('FILE_TOO_LARGE')
 fd,name=parent(v); tmp='.harness-'+uuid.uuid4().hex
 try:
  outfd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd)
  with os.fdopen(outfd,'wb') as f: f.write(b); f.flush(); os.fsync(f.fileno())
  os.replace(tmp,name,src_dir_fd=fd,dst_dir_fd=fd); os.fsync(fd)
 finally:
  try: os.unlink(tmp,dir_fd=fd)
  except FileNotFoundError: pass
  os.close(fd)
if op=='read':
 v=path(a['path']); text=read(v); result={'text':text,'sha256':hashlib.sha256(text.encode()).hexdigest()}
elif op in ['write','edit']:
 v=path(a['path'],True)
 if op=='edit':
  old=read(v)
  if hashlib.sha256(old.encode()).hexdigest()!=a['expectedHash']: raise Exception('EDIT_CONFLICT')
  if not a['oldText'] or old.count(a['oldText'])!=1: raise Exception('EDIT_NOT_UNIQUE')
  text=old.replace(a['oldText'],a['newText'],1)
 else: text=a['content']
 write(v,text); result={'sha256':hashlib.sha256(text.encode()).hexdigest()}
elif op=='ls':
 v=path(a.get('path','/workspace'));
 with os.scandir(v) as it: result={'entries':sorted([e.name for _,e in zip(range(1000),it)])}
elif op in ['find','grep']:
 v=path(a.get('path','/workspace')); matches=[]; scanned=0; bytes_scanned=0
 for d,dirs,files in os.walk(v,followlinks=False):
  dirs[:]=[x for x in dirs if not os.path.islink(os.path.join(d,x)) and x not in ['.git','node_modules']]
  if os.path.relpath(d,v).count(os.sep)>8: dirs[:]=[]; continue
  for f in files:
   scanned+=1
   if scanned>10000: break
   if os.path.islink(os.path.join(d,f)): continue
   try: q=path(os.path.join(d,f))
   except Exception: continue
   if op=='find': matches.append(q)
   elif not os.path.islink(os.path.join(d,f)):
    try:
     text=read(q); bytes_scanned+=len(text)
     if bytes_scanned>16777216: break
     for n,line in enumerate(text.splitlines()):
      if a['pattern'] in line: matches.append({'path':q,'line':n+1,'text':line[:1000]})
      if len(matches)>=500: break
    except (UnicodeError,Exception): pass
   if len(matches)>=500: break
  if scanned>10000 or bytes_scanned>16777216 or len(matches)>=500: break
 result={'matches':matches,'truncated':scanned>10000 or bytes_scanned>16777216 or len(matches)>=500}
elif op=='bash':
 seconds=min(int(a.get('timeoutSeconds',60)),120)
 with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
  proc=subprocess.Popen(['/bin/bash','--noprofile','--norc','-c',a['command']],cwd=root,stdout=out,stderr=err,start_new_session=True,env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':'/tmp','LANG':'C.UTF-8'})
  timed=False
  try: proc.wait(timeout=seconds)
  except subprocess.TimeoutExpired:
   timed=True; os.killpg(proc.pid,signal.SIGKILL); proc.wait()
  try: os.killpg(proc.pid,signal.SIGKILL)
  except ProcessLookupError: pass
  out.seek(0); err.seek(0); stdout=out.read(limit+1); stderr=err.read(limit+1)
  result={'stdout':stdout[:limit].decode('utf8',errors='replace'),'stderr':stderr[:limit].decode('utf8',errors='replace'),'exitCode':proc.returncode,'timedOut':timed,'truncated':len(stdout)>limit or len(stderr)>limit}
else: raise Exception('UNKNOWN_TOOL')
print(json.dumps(result))
`;

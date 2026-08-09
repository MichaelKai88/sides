/* Loads the real built app into a stubbed DOM, then drives the two things
   that actually failed in use: the speech engine and the advance decision. */
const fs = require('fs'), vm = require('vm');

/* ---------- minimal DOM ---------- */
const mkEl = () => {
  const el = {
    style: new Proxy({}, { get:(t,k)=> k==='removeProperty'||k==='setProperty' ? ()=>{} : t[k],
                           set:(t,k,v)=>{ t[k]=v; return true; } }),
    classList:{ _s:new Set(), add(...a){a.forEach(x=>this._s.add(x))}, remove(...a){a.forEach(x=>this._s.delete(x))},
                toggle(x,on){ on?this._s.add(x):this._s.delete(x) }, contains(x){return this._s.has(x)} },
    dataset:{}, children:[], value:'', textContent:'', innerHTML:'', rows:1,
    offsetTop:0, offsetHeight:20, scrollHeight:20, isConnected:true, offsetParent:{},
    selectionStart:0, files:[],
    addEventListener(){}, removeEventListener(){}, setAttribute(k,v){ this['_'+k]=v },
    getAttribute(k){ return this['_'+k] }, appendChild(c){ this.children.push(c); return c },
    append(...c){ this.children.push(...c) }, scrollIntoView(){}, focus(){}, blur(){}, click(){},
    querySelector:()=>mkEl(), querySelectorAll:()=>[], remove(){}, closest:()=>null,
  };
  return el;
};
const doc = {
  querySelector: () => mkEl(),
  querySelectorAll: () => [],
  createElement: () => mkEl(),
  addEventListener(){}, head:mkEl(), body:mkEl(), visibilityState:'visible',
};

/* ---------- controllable speech engine ---------- */
let MODE = 'ok';
let FETCHES = [];
const speechSynthesis = {
  paused:false, speaking:false, pending:false,
  getVoices: () => ([{ voiceURI:'v1', name:'Test', lang:'en-US' }]),
  cancel(){ this.speaking=false; },
  pause(){ this.paused=true; }, resume(){ this.paused=false; },
  speak(u){
    if(MODE==='throw')       throw new Error('engine refused');
    if(MODE==='never_starts')return;                                  // accepted, silently does nothing
    if(MODE==='error')       return setTimeout(()=>u.onerror&&u.onerror({}), 20);
    if(MODE==='never_ends')  return setTimeout(()=>u.onstart&&u.onstart({}), 20);   // starts, never finishes
    if(MODE==='flaky')       { MODE='ok'; return; }                   // first call dies, retry succeeds
    setTimeout(()=>{ u.onstart&&u.onstart({}); setTimeout(()=>u.onend&&u.onend({}), 30); }, 20);
  }
};
function SpeechSynthesisUtterance(t){ this.text=t; this.onstart=this.onend=this.onerror=null; }

const sandbox = {
  document: doc, console, setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: ()=>0, cancelAnimationFrame: ()=>{},
  performance, speechSynthesis, SpeechSynthesisUtterance,
  navigator:{ mediaDevices:{ enumerateDevices:async()=>[], getUserMedia:async()=>{throw new Error('no mic')} } },
  Math, JSON, Date, Promise, Error, Set, Map, Proxy, Float32Array, prompt:()=>null,
  /* counted, so a test can assert that nothing reached the network at all */
  fetch: async(...a)=>{ FETCHES.push(String(a[0])); return { ok:false, status:500 }; },
  indexedDB:{ open:()=>({ }) },
  Blob:function(){}, URL:{ createObjectURL:()=>'blob:x', revokeObjectURL:()=>{} },
  Audio: function(){ return { play:()=>Promise.reject(new Error('no audio')), pause(){},
                              duration:NaN, volume:1, muted:false }; },
  AudioContext:function(){}, alert:()=>{},
};
sandbox.addEventListener = ()=>{};
sandbox.removeEventListener = ()=>{};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

const html = fs.readFileSync('./index.html','utf8');
const js   = html.slice(html.indexOf('<script>')+8, html.lastIndexOf('</script>'));
vm.createContext(sandbox);
new vm.Script(js + '\n;globalThis.__T={Reader,advanceDecision,newCueState,S,P,segsFromText,mergedView,Clip,AudioCache,clipKey,'
                 + 'Sync,stateBlob,applyState,newSyncCode,tidyCode,ensureClip,EL};')
  .runInContext(sandbox);
const T = sandbox.__T;

/* ---------- tests ---------- */
let pass=0, fail=0;
const ok  = (n,c)=>{ c?(pass++,console.log('  PASS  '+n)):(fail++,console.log('  FAIL  '+n)); };

(async ()=>{
console.log('\nREADER — must always resolve, whatever the engine does');
for(const mode of ['ok','throw','never_starts','error','never_ends','flaky']){
  MODE = mode;
  const t0 = Date.now();
  const r = await Promise.race([
    T.Reader.say('This is a test line of dialogue.', 'v1'),
    new Promise(r=>setTimeout(()=>r('HUNG'), 25000)),
  ]);
  ok(`${mode.padEnd(13)} resolves in ${String(Date.now()-t0).padStart(5)}ms -> ${r==='HUNG'?'HUNG':'ok='+r.ok}`,
     r !== 'HUNG');
}

console.log('\nCLIP PLAYBACK — must resolve even when audio is unavailable');
{
  const t0=Date.now();
  T.Clip.el = { play:()=>Promise.reject(new Error('blocked')), pause(){}, duration:NaN, volume:1 };
  const r = await Promise.race([ T.Clip.play(new ArrayBuffer(8), 0.8),
                                 new Promise(r=>setTimeout(()=>r('HUNG'), 24000)) ]);
  ok(`blocked playback resolves in ${Date.now()-t0}ms`, r !== 'HUNG');
}
{
  const r = await Promise.race([ T.Clip.play(null, 0.8),
                                 new Promise(r=>setTimeout(()=>r('HUNG'), 5000)) ]);
  ok('missing clip resolves rather than hanging', r !== 'HUNG' && r.ok === false);
}
ok('clip keys are stable for identical text', T.clipKey('v1','Hello there.') === T.clipKey('v1','Hello there.'));
ok('clip keys differ by voice',               T.clipKey('v1','Hello there.') !== T.clipKey('v2','Hello there.'));
ok('clip keys differ by line',                T.clipKey('v1','Hello there.') !== T.clipKey('v1','Hello then.'));

console.log('\nADVANCE — must never leave a line with no way out');
const S_ = T.S; S_.set.silence = 1600;
const st = (o) => Object.assign({ t0:0, words:10, expected:4500, spoke:false, spokeAt:0, lastLoud:0, quietSince:0 }, o);
const D  = (s,now) => T.advanceDecision(s, now, S_.set.silence);

ok('silent line never auto-advances',        D(st({}), 60000) === null);
ok('holds during a 1.2s mid-line beat',      D(st({spoke:true,spokeAt:1000,lastLoud:3000,quietSince:3000}), 4200) === null);
ok('advances after a full line + pause',     D(st({spoke:true,spokeAt:1000,lastLoud:6000,quietSince:6000}), 7800) === 'spoken');
ok('no advance inside the 2.2s floor',       D(st({spoke:true,spokeAt:100,lastLoud:900,quietSince:900}), 2100) === null);
ok('3s of silence overrides a bad estimate', D(st({expected:99000,spoke:true,spokeAt:500,lastLoud:2000,quietSince:2000}), 5200) === 'silence');
ok('short delivery still escapes',           D(st({spoke:true,spokeAt:500,lastLoud:2000,quietSince:2000}), 8000) !== null);

// the exact shape that hung: a speech split in two, the second half never spoken
S_.segs = T.segsFromText('MARA\nOne line here.\n\nMARA\nAnd the rest of it.\n\nDANIEL\nReply.').segs;
S_.cast = { MARA:{role:'me',voice:''}, DANIEL:{role:'reader',voice:'v1'} };
S_.set.dirs = true;
const view  = T.mergedView();
const maras = view.filter(s=>s.speaker==='MARA' && s.kind==='line').length;
ok(`split speech becomes one cue (${maras} MARA block${maras===1?'':'s'})`, maras === 1);
ok('other speakers stay separate', view.filter(s=>s.speaker==='DANIEL').length === 1);
ok('cue count matches speakers', view.filter(s=>s.kind==='line').length === 2);


console.log('\nFUZZ — 4000 random deliveries, none may strand');
let stranded = 0, worst = 0, advanced = 0;
for(let i=0;i<4000;i++){
  const words = 3 + Math.floor(Math.random()*40);
  const s = { t0:0, words, expected: Math.max(1200,(words/2.2)*1000),
              spoke:false, spokeAt:0, lastLoud:0, quietSince:0 };
  const startAt = Math.random()*6000;                 // beat before beginning
  const pace    = 1.1 + Math.random()*2.6;            // their real speed
  const speakMs = (words/pace)*1000;
  const gapAt   = startAt + speakMs*Math.random();    // one mid-line pause
  const gapLen  = Math.random() < 0.55 ? Math.random()*3000 : 0;
  let out = null;
  for(let t=0; t<=180000; t+=50){
    const inGap  = gapLen && t>=gapAt && t<gapAt+gapLen;
    const talking = t>=startAt && t<=startAt+speakMs+gapLen && !inGap;
    if(talking){ if(!s.spoke){ s.spoke=true; s.spokeAt=t; } s.lastLoud=t; s.quietSince=0; }
    else if(s.spoke && !s.quietSince) s.quietSince=t;
    const d = T.advanceDecision(s, t, 1600);
    if(d){ out = t; break; }
  }
  if(out === null) stranded++;
  else { advanced++; worst = Math.max(worst, out - (startAt+speakMs+gapLen)); }
}
ok(`no delivery stranded (${advanced} advanced, ${stranded} stranded)`, stranded === 0);
ok(`worst wait after finishing: ${(worst/1000).toFixed(1)}s`, worst < 6000);

console.log('\nSTATE — one serialisation, shared by storage and sync');
{
  const blob = T.stateBlob();
  ok('blob carries the script',   Array.isArray(blob.segs) && blob.segs.length > 0);
  ok('blob carries the cast',     !!blob.cast && Object.keys(blob.cast).length > 0);
  ok('blob carries the key field', !!blob.set && 'elKey' in blob.set);
  T.S.name = 'ROUNDTRIP';
  const snap = T.stateBlob();
  T.S.name = 'wiped';
  T.applyState(snap);
  ok('applyState restores what stateBlob captured', T.S.name === 'ROUNDTRIP');
}

console.log('\nSYNC — never blocks a take, never throws, never loses local work');
{
  ok('off until switched on',        T.Sync.on === false && T.Sync.ready() === false);
  ok('a new code is 20 characters',  T.newSyncCode().replace(/-/g,'').length === 20);
  ok('two codes differ',             T.newSyncCode() !== T.newSyncCode());
  ok('sloppy typing is tolerated',   T.tidyCode('  ABcd-EF gh ') === 'abcd-efgh');

  FETCHES = [];
  await T.Sync.pull(); await T.Sync.push();
  ok('silent while sync is off', FETCHES.length === 0);

  // design rule 1: the take is fully local
  T.Sync.on = true; T.Sync.code = 'abcde-fghij-klmno-pqrst';
  T.P.on = true;
  FETCHES = [];
  const during = [ await T.Sync.pull(), await T.Sync.push(),
                   await T.Sync.getClip('k1'), await T.Sync.putClip('k1', new ArrayBuffer(4)) ];
  ok('NO network during a take', FETCHES.length === 0);
  ok('every call still resolves during a take', during.every(v => v === false || v === null));

  // take over, network broken
  T.P.on = false;
  T.Sync.mark({ marker:'unsent' });
  ok('an edit marks work as unsent', T.Sync.dirty === true);
  FETCHES = [];
  const t0 = Date.now();
  const pushed = await T.Sync.push();
  ok(`push fails soft when offline in ${Date.now()-t0}ms`, pushed === false);
  ok('it did try exactly once', FETCHES.length === 1 && /rpc\/sync_push$/.test(FETCHES[0]));
  ok('unsent work stays marked, not dropped', T.Sync.dirty === true);
  ok('a failed pull resolves false',  (await T.Sync.pull()) === false);
  ok('an unreachable clip reads null', (await T.Sync.getClip('nope')) === null);
  ok('a failed upload reads false',    (await T.Sync.putClip('nope', new ArrayBuffer(4))) === false);
  ok('the clip path is namespaced by the code', T.Sync.clipPath('abc') === 'abcde-fghij-klmno-pqrst/abc.mp3');

  /* Storage reports a duplicate as HTTP 400 with a 409 in the body - the real
     shape, captured from the live project, not what the docs imply */
  const realFetch = sandbox.fetch;
  sandbox.fetch = async()=>({ ok:false, status:400,
    json: async()=>({ statusCode:'409', error:'Duplicate', message:'The resource already exists', code:'KeyAlreadyExists' }) });
  ok('a clip already in the bucket counts as uploaded',
     (await T.Sync.putClip('dupe', new ArrayBuffer(4))) === true);
  sandbox.fetch = async()=>({ ok:false, status:400, json: async()=>({ error:'Payload too large' }) });
  ok('a genuinely rejected upload still reads false',
     (await T.Sync.putClip('big', new ArrayBuffer(4))) === false);
  sandbox.fetch = realFetch;
}

console.log('\nCLIP RESOLUTION — the order that decides whether a line is paid for twice');
{
  const realCacheGet = T.AudioCache.get, realCachePut = T.AudioCache.put;
  const realRemoteGet = T.Sync.getClip, realRemotePut = T.Sync.putClip, realSynth = T.EL.synth;
  let local = null, remote = null, calls = [];
  T.AudioCache.get = async ()  => { calls.push('local');  return local; };
  T.AudioCache.put = async (k,b)=>{ calls.push('cache');  local = b; };
  T.Sync.getClip   = async ()  => { calls.push('remote'); return remote; };
  T.Sync.putClip   = async ()  => { calls.push('upload'); return true; };
  T.EL.synth       = async ()  => { calls.push('PAID');   return new ArrayBuffer(16); };
  T.Sync.on = true; T.Sync.code = 'abcde-fghij-klmno-pqrst'; T.P.on = false;

  calls = []; local = new ArrayBuffer(8); remote = null;
  await T.ensureClip('v1','A line already on this device.');
  ok('cached locally: nothing else is touched', calls.join(',') === 'local');

  calls = []; local = null; remote = new ArrayBuffer(8);
  await T.ensureClip('v1','A line the other device already made.');
  ok('in the bucket: downloaded, NOT regenerated', calls.join(',') === 'local,remote,cache');
  ok('...and ElevenLabs was never called', calls.indexOf('PAID') === -1);

  calls = []; local = null; remote = null;
  await T.ensureClip('v1','A line nobody has made yet.');
  ok('nowhere yet: generated once, then shared', calls.join(',') === 'local,remote,PAID,cache,upload');

  // a broken bucket must not stop a take being prepared
  calls = []; local = null; remote = null;
  T.Sync.getClip = async ()=>{ calls.push('remote'); return null; };
  T.Sync.putClip = async ()=>{ calls.push('upload'); throw new Error('bucket down'); };
  let threw = false;
  try{ await T.ensureClip('v1','A line while storage is broken.'); }catch(e){ threw = true; }
  ok('a failing upload does not break preparation', threw === false && calls.indexOf('cache') !== -1);

  T.AudioCache.get = realCacheGet; T.AudioCache.put = realCachePut;
  T.Sync.getClip = realRemoteGet;  T.Sync.putClip = realRemotePut; T.EL.synth = realSynth;
}

console.log('\nENSURECLIP — the offline path must surface, not hang');
{
  T.Sync.on = false;
  const t0 = Date.now();
  const r = await Promise.race([
    T.ensureClip('v1','A line to be spoken aloud.').then(()=>'resolved').catch(e=>'threw'),
    new Promise(r=>setTimeout(()=>r('HUNG'), 15000)),
  ]);
  ok(`resolves with no cache and no network in ${Date.now()-t0}ms -> ${r}`, r !== 'HUNG');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})();


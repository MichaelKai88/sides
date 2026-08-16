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
                 + 'Sync,stateBlob,applyState,newSyncCode,tidyCode,ensureClip,EL,'
                 + 'OA,OA_VOICES,usesClips,engineModel,castDir,englishVoices,hashKey,EL_MODEL,pickVoice,'
                 + 'cueLoopAction,finish,stripMarkdown,nameOf,advanceInto,cuesOf,markCue,gotoRows,gotoMatch,relTime};')
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

console.log('\nPASTED SCRIPTS — markdown sources must not become the cast list');
{
  const who = txt => {
    const segs = T.segsFromText(txt).segs.filter(s=>s.kind==='line');
    return { n: segs.length, who: [...new Set(segs.map(s=>s.speaker))], text: segs.map(s=>s.text) };
  };

  const plain = who(`MARA\nYou told them I signed off on it.\n\nDANIEL\nI told them the kitchen signed off on it.`);
  ok('a plain screenplay paste still parses', plain.n === 2 && plain.who.join() === 'MARA,DANIEL');

  /* the total failure: Notion gives every paragraph its own block, so the cue
     and its dialogue arrived separated by a blank line and the whole script
     came out as stage direction with no cast at all */
  const spaced = who(`MARA\n\nYou told them I signed off on it.\n\nDANIEL\n\nI told them the kitchen signed off on it.`);
  ok('THE BUG: a cue separated from its line by a blank still pairs',
     spaced.n === 2 && spaced.who.join() === 'MARA,DANIEL');

  const bold = who(`**MARA**\nYou told them I signed off on it.\n\n**DANIEL**\nI told them the kitchen signed off on it.`);
  ok('a bold cue is MARA, not **MARA', bold.who.join() === 'MARA,DANIEL');

  const mixed = who(`**MARA**\nOne.\n\nMARA\nTwo.`);
  ok('bold and plain are the same character, not two', mixed.who.length === 1 && mixed.who[0] === 'MARA');

  const ital = who(`MARA\nThe kitchen is *me*, Daniel.`);
  ok('emphasis never reaches the voice', ital.text[0].indexOf('*') === -1 && /is me,/.test(ital.text[0]));

  ok('headings are dropped',  T.stripMarkdown('# Scene 4') === 'Scene 4');
  ok('bullets are dropped',   T.stripMarkdown('- he does not look up') === 'he does not look up');
  ok('numbering is dropped',  T.stripMarkdown('1. he does not look up') === 'he does not look up');
  ok('quotes are dropped',    T.stripMarkdown('> a remembered line') === 'a remembered line');
  ok('links keep their text', T.stripMarkdown('see [the note](https://x.y)') === 'see the note');
  ok('code marks are dropped',T.stripMarkdown('`beat`') === 'beat');

  // it must not damage ordinary screenplay punctuation
  ok('a lone asterisk survives',   T.stripMarkdown('MARA *') === 'MARA *');
  ok('a dash in dialogue survives',T.stripMarkdown('No - I never said that.') === 'No - I never said that.');
  ok('an em dash survives',        T.stripMarkdown('INT. KITCHEN — LATE') === 'INT. KITCHEN — LATE');
  ok('nothing is reordered',       T.stripMarkdown('a\nb\nc') === 'a\nb\nc');

  // a trailing lone cue with nothing after it must not swallow anything
  const dangling = who(`MARA\nOne.\n\nDANIEL`);
  ok('a dangling cue at the end is harmless', dangling.n === 1 && dangling.who[0] === 'MARA');

  /* "NAME: dialogue" on one line - the shape Michael's real Notion script uses.
     The prefix must read as a name; sentence-case labels used to be uppercased
     into characters, so "Stage direction:" turned up in the cast asking for a
     voice. Drawn from the actual page, not invented. */
  const inline = who(`**MICHAEL:** Hi, Daniel. Good to meet you.\n**CLIENT:** Yes, I can hear you.\n**Stage direction:** Michael shares the ChatGPT screen.\n**Reusable teaching move:** Confirm the outcome in the client's language.\n**MICHAEL:** What have you tried so far?`);
  ok('an inline NAME: is a speaker',        inline.who.indexOf('MICHAEL') !== -1 && inline.who.indexOf('CLIENT') !== -1);
  ok('THE BUG: "Stage direction:" is not a character', inline.who.indexOf('STAGE DIRECTION') === -1);
  ok('nor is "Reusable teaching move:"',    inline.who.indexOf('REUSABLE TEACHING MOVE') === -1);
  ok('the cast is exactly the two speakers', inline.who.length === 2);

  /* Title Case is deliberately NOT a cue. Accepting it is exactly what let
     "Prompt:" and "Learn:" into the cast, because upper case is the only
     signal that survives a clipboard when markdown markers do not. Screenplay
     cues are upper case by convention; revisit only with a real script that
     needs Title Case. */
  const titled = who(`Michael: Hi, Daniel.\nDaniel: Good to meet you.`);
  ok('title-case is not a cue (upper case is the signal)', titled.who.length === 0);

  const bulletLabel = who(`**MICHAEL:** One.\n- **Write** something: an email, invitation, or first draft.`);
  ok('a bulleted label is not a character', bulletLabel.who.indexOf('WRITE SOMETHING') === -1);

  // a bare label line was being swallowed into the previous speech and read aloud
  const bareLabel = T.segsFromText(`**MICHAEL:** One.\n**Prompt to enter:**\n> Plan a trip to Santa Fe.`);
  const mLine = bareLabel.segs.find(s=>s.kind==='line' && s.speaker==='MICHAEL');
  ok('a bare label does not join the speech', /Prompt to enter/.test(mLine.text) === false);
  ok('a bare label becomes a direction',
     bareLabel.segs.some(s=>s.kind==='dir' && /Prompt to enter/.test(s.text)));

  // but a bare NAME: on its own line is still a cue, not a label
  const bareCue = who(`MICHAEL:\nHi, Daniel.\n\nCLIENT:\nGood to meet you.`);
  ok('a bare "NAME:" line is still a cue', bareCue.who.join() === 'MICHAEL,CLIENT');

  /* (V.O.) and (CONT'D) are in practically every real set of sides, and the
     inline pattern did not allow parentheses at all - the line was lost */
  const vo = who(`**MICHAEL (V.O.):** Hello there.\n**CLIENT:** Hi.`);
  ok('THE BUG: (V.O.) no longer loses the line', vo.who.join() === 'MICHAEL,CLIENT');
  const contd = who(`**MICHAEL (CONT'D):** Still talking.\n**CLIENT:** Hi.`);
  ok('(CONT\'D) no longer loses the line',       contd.who.join() === 'MICHAEL,CLIENT');
  const same = who(`MICHAEL: One.\nCLIENT: Two.\nMICHAEL (CONT'D): Three.`);
  ok('a continued cue is the same character, not a second one',
     same.who.length === 2 && same.who.join() === 'MICHAEL,CLIENT');
  const voBare = who(`MICHAEL (V.O.):\nHello there.\n\nCLIENT:\nHi.`);
  ok('a bare "NAME (V.O.):" line is a cue too', voBare.who.join() === 'MICHAEL,CLIENT');

  /* Reported from the real Cast screen: PROMPT and LEARN turned up as
     characters. A single capitalised word is indistinguishable from a name, so
     the discriminator has to be structural - quoted material is not dialogue,
     and a list item is not a speech. */
  const promptLabel = who(`**MICHAEL:** One.\n**Prompt:**\n> Compare a Taos day trip with a slower day in Santa Fe.\n**CLIENT:** Two.`);
  ok('THE BUG: "Prompt:" above a quote is not a character', promptLabel.who.indexOf('PROMPT') === -1);
  ok('and the real speakers survive it', promptLabel.who.join() === 'MICHAEL,CLIENT');

  const learnLabel = who(`**MICHAEL:** You can use AI to:\n- **Learn:** ask for an explanation at your level.\n- **Write** something: an email or a first draft.\n**CLIENT:** Two.`);
  ok('THE BUG: a bulleted "Learn:" is not a character', learnLabel.who.indexOf('LEARN') === -1);
  ok('nor is any other bulleted label',  learnLabel.who.join() === 'MICHAEL,CLIENT');

  // but a genuine cue above genuine dialogue is untouched
  const realCue = who(`MARA:\nYou told them I signed off on it.\n\nDANIEL:\nI told them the kitchen did.`);
  ok('a real cue above real dialogue still works', realCue.who.join() === 'MARA,DANIEL');

  /* Reported twice from a real Cast screen. The first fix keyed off markdown
     markers; they do not survive Michael's clipboard, so it never fired. Case
     does survive, and it is what these rely on - no markers anywhere below. */
  const naked = who(`MICHAEL: One.\nPrompt:\nCompare a Taos day trip with a slower day in Santa Fe.\nCLIENT: Two.`);
  ok('THE BUG: "Prompt:" with NO markdown is not a character', naked.who.indexOf('PROMPT') === -1);
  ok('and the real speakers survive it',  naked.who.join() === 'MICHAEL,CLIENT');

  const nakedLearn = who(`MICHAEL: You can use AI to:\nLearn: ask for an explanation at your level.\nWrite something: an email or a first draft.\nCLIENT: Two.`);
  ok('THE BUG: unbulleted "Learn:" is not a character', nakedLearn.who.indexOf('LEARN') === -1);
  ok('nor "Write something:"',            nakedLearn.who.indexOf('WRITE SOMETHING') === -1);
  ok('the cast is still just the two',    nakedLearn.who.join() === 'MICHAEL,CLIENT');

  const nakedStage = who(`MICHAEL: One.\nStage direction: Michael shares the screen.\nReusable teaching move: Confirm the outcome.\nCLIENT: Two.`);
  ok('unmarked prose labels are not characters', nakedStage.who.join() === 'MICHAEL,CLIENT');

  // a real bullet glyph, which is what a rich editor may actually paste
  const glyph = who(`MICHAEL: One.\n• LEARN: ask for an explanation.\nCLIENT: Two.`);
  ok('a bullet GLYPH is treated as a list too', glyph.who.indexOf('LEARN') === -1);
}

console.log('\nSTOPPING — reported from a real take: pressing Done spoke the line again');
{
  /* Clip.stop() paused the audio and revoked its url, but the play in flight
     could not tell a deliberate stop from a failure. Reader.say read that as
     "playback failed" and fell back to the system voice - so Done, Hold and
     Next each made the reader answer back in the Windows voice. */
  T.Clip.el = { play:()=>new Promise(()=>{}), pause(){}, duration:NaN, volume:1 };  // never settles

  const inFlight = T.Clip.play(new ArrayBuffer(8), 0.8);
  T.Clip.stop();
  const r = await Promise.race([ inFlight, new Promise(r=>setTimeout(()=>r('HUNG'), 4000)) ]);
  ok('a stopped clip settles at once, not on the 20s ceiling', r !== 'HUNG');
  ok('a stopped clip reports itself aborted', r !== 'HUNG' && r.aborted === true);
  ok('an aborted clip is not reported as ok',  r !== 'HUNG' && r.ok === false);

  // a new line supersedes the old one, and the old one must settle as aborted too
  const first = T.Clip.play(new ArrayBuffer(8), 0.8);
  T.Clip.play(new ArrayBuffer(8), 0.8);
  const f = await Promise.race([ first, new Promise(r=>setTimeout(()=>r('HUNG'), 4000)) ]);
  ok('a superseded line settles rather than dangling', f !== 'HUNG' && f.aborted === true);

  /* the fallback itself: an aborted clip must NOT reach the speech engine */
  const realPlay = T.Clip.play, realCacheGet = T.AudioCache.get;
  let spoke = 0;
  const realSpeech = T.Reader.sayWithSpeech;
  T.Reader.sayWithSpeech = async ()=>{ spoke++; return { ok:true }; };
  T.AudioCache.get = async ()=>new ArrayBuffer(8);
  T.S.set.engine = 'openai';

  T.Clip.play = async ()=>({ ok:false, aborted:true, expect:0 });
  await T.Reader.say('A line we were told to abandon.', 'nova', '');
  ok('THE BUG: stopping must not make the reader speak again', spoke === 0);

  T.Clip.play = async ()=>({ ok:false, aborted:false, expect:0 });
  await T.Reader.say('A line whose audio genuinely failed.', 'nova', '');
  ok('a genuine playback failure still falls back', spoke === 1);

  T.Clip.play = realPlay; T.AudioCache.get = realCacheGet;
  T.Reader.sayWithSpeech = realSpeech; T.S.set.engine = 'elevenlabs';
}

console.log('\nRESUME AND GO TO — a saved position must survive an edit, or not be offered');
{
  const view = [
    { id:1, kind:'dir',  speaker:null, text:'INT. KITCHEN — LATE' },
    { id:2, kind:'line', speaker:'MARA',   text:'You told them I signed off on it.' },
    { id:3, kind:'line', speaker:'DANIEL', text:'I told them the kitchen signed off on it.' },
    { id:4, kind:'dir',  speaker:null, text:'0:42 — the insurance letter' },
    { id:5, kind:'line', speaker:'MARA',   text:'The kitchen is me, Daniel.' },
  ];
  const cues = T.cuesOf(view);
  ok('cues are the spoken lines only', cues.join() === '1,2,4');

  ok('a saved position resolves to its cue', T.markCue(view, cues, { id:5 }) === 2);
  ok('the first line resolves to cue 0',     T.markCue(view, cues, { id:2 }) === 0);

  /* the reason it stores an id and not a line number: delete the direction and
     "line 4" is a different line, but the id still finds the same speech */
  const edited = view.filter(s => s.id !== 4);
  ok('it survives a deleted direction', T.markCue(edited, T.cuesOf(edited), { id:5 }) === 2);

  ok('a deleted line offers no resume',  T.markCue(view, cues, { id:99 }) === -1);
  ok('no mark offers no resume',         T.markCue(view, cues, null) === -1);
  ok('a direction is never a resume point', T.markCue(view, cues, { id:1 }) === -1);

  // the Go to list: headings kept as sections, lines carry their cue number
  T.S.segs = [
    { id:1, kind:'dir',  speaker:null,     text:'INT. KITCHEN — LATE', out:false },
    { id:2, kind:'line', speaker:'MARA',   text:'You told them I signed off on it.', out:false },
    { id:3, kind:'line', speaker:'DANIEL', text:'I told them the kitchen signed off.', out:false },
  ];
  T.S.set.dirs = true;
  const rows = T.gotoRows();
  ok('every line and heading is listed',  rows.length === 3);
  ok('the heading is a section, not a cue', rows[0].kind === 'sec' && rows[0].cue === -1);
  ok('lines carry their cue number',      rows[1].cue === 0 && rows[2].cue === 1);
  ok('lines carry their speaker',         rows[1].who === 'MARA');

  ok('search matches the dialogue', T.gotoMatch({ who:'MARA', text:'the insurance letter' }, 'insurance'));
  ok('search matches the speaker',  T.gotoMatch({ who:'DANIEL', text:'nothing' }, 'daniel'));
  ok('search is case-insensitive',  T.gotoMatch({ who:'MARA', text:'Santa Fe' }, 'santa fe'));
  ok('search excludes what it should', !T.gotoMatch({ who:'MARA', text:'Santa Fe' }, 'insurance'));
  ok('an empty search shows everything', T.gotoMatch({ who:'', text:'anything' }, ''));

  ok('a fresh mark reads as recent', T.relTime(Date.now() - 5000) === 'a moment ago');
  ok('an hours-old mark says hours', /hours ago/.test(T.relTime(Date.now() - 5*3600*1000)));
  ok('a day-old mark says yesterday', T.relTime(Date.now() - 26*3600*1000) === 'yesterday');
}

console.log('\nINTERRUPTING A LINE — a superseded advance must not wake up and drive the script');
{
  /* Observed in a browser: pressing Next while the reader spoke landed on the
     right cue, then seconds later the script advanced on its own to a cue two
     further on and spoke it. The abandoned advanceInto was parked on an await
     inside Reader.say; when it settled it cleared the busy lock under the new
     line and carried on from wherever the script had moved to. */
  const P_ = T.P, S_ = T.S;
  const realSay = T.Reader.say;
  let says = 0, release = null;
  T.Reader.say = () => {
    says++;
    if(says === 1) return new Promise(res=>{ release = ()=>res({ ok:true, expect:0 }); });
    return Promise.resolve({ ok:true, expect:0 });
  };
  P_.on = true; P_.paused = false; P_.busy = false; P_.done = false; P_.mode = 'tap';
  P_.view = [{speaker:'A',kind:'line',text:'one'},{speaker:'A',kind:'line',text:'two'},{speaker:'A',kind:'line',text:'three'}];
  P_.cues = [0,1,2];
  S_.cast = { A:{ role:'reader', voice:'v1' } };

  T.advanceInto(0);
  await new Promise(r=>setTimeout(r, 420));          // past the 260ms lead-in
  ok('the first line is speaking and holds the lock', says === 1 && P_.busy === true);

  T.advanceInto(2);                                   // a jump supersedes it
  await new Promise(r=>setTimeout(r, 420));
  const landed = P_.idx;
  if(release) release();                              // the abandoned line finally settles
  await new Promise(r=>setTimeout(r, 700));

  ok('the jump lands where it was asked to',   landed === 2);
  ok('THE BUG: the abandoned line does not move the script', P_.idx === 2);
  ok('and it never speaks again',              says === 2);

  T.Reader.say = realSay;
  P_.on = false; P_.busy = false; P_.done = false;
}

console.log('\nEND OF SCENE — reported from a real take: the last reader line repeated forever');
{
  const A = T.cueLoopAction;
  const P_ = (o) => Object.assign({ on:true, paused:false, busy:false, done:false }, o);

  ok('mid-scene, a reader cue is spoken',   A(P_({}), 'reader') === 'speak');
  ok('mid-scene, my own cue listens',       A(P_({}), 'me')     === 'listen');
  ok('nothing is driven while speaking',    A(P_({busy:true}),   'reader') === 'wait');
  ok('nothing is driven while held',        A(P_({paused:true}), 'reader') === 'wait');
  ok('nothing is driven once exited',       A(P_({on:false}),    'reader') === 'stop');

  /* the exact shape of the failure: finish() released the busy lock, so the very
     next frame spoke the final reader cue again, and again, and again */
  ok('THE BUG: a finished scene must not re-speak the last reader line',
     A(P_({ done:true }), 'reader') === 'wait');
  ok('a finished scene does not re-listen either',
     A(P_({ done:true }), 'me') === 'wait');
  ok('finished still wins after the busy lock clears',
     A(P_({ done:true, busy:false }), 'reader') === 'wait');

  // and the real finish() must actually set that flag
  const realP = T.P;
  const wasOn = realP.on, wasIdx = realP.idx;
  realP.on = true; realP.busy = true; realP.done = false;
  T.finish();
  ok('finish() records that the scene ended', realP.done === true);
  ok('finish() still releases the busy lock', realP.busy === false);
  ok('a finished scene stops the loop dead',  A(realP, 'reader') === 'wait');

  // pressing Next or Restart must re-open it, or the scene could never be replayed
  realP.done = true;
  ok('the flag is what blocks it', A(realP,'reader') === 'wait');
  realP.done = false;
  ok('clearing it lets the scene run again', A(realP,'reader') === 'speak');
  realP.on = wasOn; realP.idx = wasIdx; realP.busy = false; realP.done = false;
}

console.log('\nENGINES — a third engine must not orphan paid-for audio');
{
  const line = 'Hello there.';
  /* the exact string the one-engine build hashed - if this ever changes, every
     clip already generated and every object in the bucket is orphaned */
  ok('an ElevenLabs key is byte-identical to the old scheme',
     T.clipKey('v1', line) === T.hashKey(`${T.EL_MODEL}|v1|${line}`));
  ok('passing the ElevenLabs model explicitly changes nothing',
     T.clipKey('v1', line) === T.clipKey('v1', line, T.EL_MODEL));
  ok('an empty direction changes nothing',
     T.clipKey('v1', line) === T.clipKey('v1', line, T.EL_MODEL, ''));

  ok('a different model is a different clip',
     T.clipKey('v1', line, 'gpt-4o-mini-tts') !== T.clipKey('v1', line));
  ok('a direction is a different clip',
     T.clipKey('nova', line, 'gpt-4o-mini-tts', 'clipped') !== T.clipKey('nova', line, 'gpt-4o-mini-tts'));
  ok('changing the direction regenerates',
     T.clipKey('nova', line, 'gpt-4o-mini-tts', 'clipped') !== T.clipKey('nova', line, 'gpt-4o-mini-tts', 'warm'));
  ok('the same direction reuses',
     T.clipKey('nova', line, 'gpt-4o-mini-tts', 'clipped') === T.clipKey('nova', line, 'gpt-4o-mini-tts', 'clipped'));

  T.S.set.engine = 'system';
  ok('system engine does not use clips', T.usesClips() === false);
  T.S.set.engine = 'elevenlabs';
  ok('elevenlabs uses clips',            T.usesClips() === true && T.engineModel() === T.EL_MODEL);
  T.S.set.engine = 'openai';
  ok('openai uses clips',                T.usesClips() === true);
  ok('openai reports its own model',     T.engineModel() === 'gpt-4o-mini-tts');
  ok('openai offers 13 fixed voices',    T.englishVoices().length === 13 && T.OA_VOICES.length === 13);
  ok('every openai voice has an id',     T.englishVoices().every(v=>!!v.voiceURI && !!v.name));

  T.S.cast = { MARA:{ role:'reader', voice:'nova', dir:'clipped and impatient' } };
  ok('a direction reaches the clip key', T.castDir('MARA') === 'clipped and impatient');
  T.S.set.oaModel = 'tts-1';
  ok('tts-1 ignores directions (it has no instructions field)', T.castDir('MARA') === '');
  T.S.set.oaModel = 'gpt-4o-mini-tts';
  ok('an unknown speaker has no direction', T.castDir('NOBODY') === '');

  /* found in the browser, not here: switching engines left a system voice id in
     the cast while the dropdown showed the first option as selected */
  const oaList = T.OA.voices();
  ok('a stale system voice is replaced when the engine changes',
     T.pickVoice('Microsoft David - English (United States)', oaList) === 'marin');
  ok('a valid voice is left alone',      T.pickVoice('nova', oaList) === 'nova');
  ok('an empty cast slot gets a voice',  T.pickVoice('', oaList) === 'marin');
  ok('no voices means no change',        T.pickVoice('whatever', []) === 'whatever');

  // a line beyond the request cap must refuse, not truncate: a silently shortened
  // line would be discovered mid-take
  let refused = false;
  try{ await T.OA.synth('sk-x','nova','x'.repeat(4200)); }catch(e){ refused = /too long/.test(e.message); }
  ok('an over-long line is refused, not truncated', refused === true);
  T.S.set.engine = 'elevenlabs'; T.S.set.oaModel = 'gpt-4o-mini-tts';
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


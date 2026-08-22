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
  performance, speechSynthesis, SpeechSynthesisUtterance, innerHeight:900, innerWidth:1400,
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
                 + 'cueLoopAction,finish,stripMarkdown,nameOf,advanceInto,cuesOf,markCue,gotoRows,gotoMatch,relTime,'
                 + 'pageCount,pageMove,step,insertAfterId,moveById,'
                 + 'voiceOf,setVoiceOf,voicesReady,migrateCast,engineOfVoice,engineOfCast,copyCast,renderCast,syncCast,'
                 + 'findCachedVoice,candidateTexts,recoveryCandidates,readerText,History,save,Store};')
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
S_.cast = { MARA:{role:'me',voices:{}}, DANIEL:{role:'reader',voices:{system:'v1',openai:'nova',elevenlabs:'v1'}} };
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

console.log('\nWHAT IS GENERATED MUST BE WHAT IS PLAYED');
{
  /* Reported: "I pressed Hold and the voice switched to the free voice."
     Nothing to do with Hold. prepareReader generated clips from S.segs while
     the take looked them up from the MERGED view, so every joined speech
     missed its clip and fell through to the system voice. */
  T.S.set.engine = 'openai'; T.S.set.oaModel = 'gpt-4o-mini-tts';
  T.S.segs = T.segsFromText('MARA\nOne line here.\n\nMARA\nAnd the rest of it.\n\nDANIEL\nReply.').segs;
  T.S.cast = { MARA:{role:'reader',voice:'nova',dir:''}, DANIEL:{role:'me',voice:''} };
  T.S.set.dirs = true;

  const view   = T.mergedView();
  const merged = view.filter(s=>s.kind==='line' && s.speaker==='MARA');
  ok('the two MARA speeches merge into one block', merged.length === 1);

  // what the take asks for
  const asked = T.clipKey('nova', merged[0].text, T.engineModel(), '');
  // what the OLD prepareReader made, per raw segment
  const madeOld = T.S.segs.filter(s=>s.kind==='line' && s.speaker==='MARA')
                          .map(s=>T.clipKey('nova', s.text, T.engineModel(), ''));
  ok('THE BUG: per-segment clips never match the merged lookup',
     madeOld.indexOf(asked) === -1);

  // what prepareReader makes now, from the same view the prompter reads
  const madeNow = T.mergedView().filter(s=>s.kind==='line' && T.S.cast[s.speaker]?.role==='reader')
                                .map(s=>T.clipKey('nova', s.text, T.engineModel(), ''));
  ok('generating from the view matches what is played', madeNow.indexOf(asked) !== -1);
  ok('one merged speech means one clip, not two',       madeNow.length === 1);

  T.S.set.engine = 'elevenlabs';
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
  S_.cast = { A:{ role:'reader', voices:{system:'v1',openai:'nova',elevenlabs:'v1'} } };

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

console.log('\nA SPEECH TALLER THAN THE SCREEN — reported from a TAI session script');
{
  /* Seen on the iPad and again on Windows: a teaching block ran past the top
     and the bottom of the screen at once and neither end could be reached.
     centerOn put the middle of the speech on the focus mark, and step() only
     ever moved between cues - there was no way to move inside one. */
  ok('a speech that fits is one screen',        T.pageCount(400, 700, 630) === 1);
  ok('one exactly the height of the band fits', T.pageCount(700, 700, 630) === 1);
  ok('a pixel taller is two screens',           T.pageCount(701, 700, 630) === 2);
  ok('THE BUG: a two-screen speech is not one', T.pageCount(1300, 700, 630) === 2);
  ok('it rounds up, so no tail is lost',        T.pageCount(1331, 700, 630) === 3);
  ok('a very tall speech keeps counting',       T.pageCount(3220, 700, 630) === 5);
  /* the last screen must reach the foot of the speech, or the fix loses the
     very text it was written to recover */
  {
    const h = 3220, band = 700, step = 630;
    const last = (T.pageCount(h, band, step) - 1) * step;
    ok('the last screen reaches the end of the speech', last + band >= h);
  }

  ok('paging forward stays inside the speech',  T.pageMove(0, 3, 1) === 1);
  ok('and again',                               T.pageMove(1, 3, 1) === 2);
  ok('the last screen hands over to the cue',   T.pageMove(2, 3, 1) === null);
  ok('paging back stays inside the speech',     T.pageMove(2, 3, -1) === 1);
  ok('the first screen hands back to the cue',  T.pageMove(0, 3, -1) === null);
  ok('a speech that fits never pages',          T.pageMove(0, 1, 1) === null);
  ok('...in either direction',                  T.pageMove(0, 1, -1) === null);
}

console.log('\nPAGING IN A TAKE — the tap must read the rest of the line before leaving it');
{
  const P_ = T.P, S_ = T.S;
  const tall = { offsetTop:0, offsetHeight:2400, classList:{ _s:new Set(),
      add(...a){a.forEach(x=>this._s.add(x))}, remove(...a){a.forEach(x=>this._s.delete(x))},
      toggle(x,on){ on?this._s.add(x):this._s.delete(x) }, contains(x){return this._s.has(x)} } };
  const short = { ...tall, offsetHeight:120, classList:{ ...tall.classList, _s:new Set() } };

  S_.set.font = 52;                       // band 700, step ~630 -> the tall line is 4 screens
  S_.cast = { A:{ role:'me', voices:{} } };
  P_.on = true; P_.paused = false; P_.busy = false; P_.done = false; P_.mode = 'tap';
  P_.view = [{speaker:'A',kind:'line',text:'a long teaching block'},
             {speaker:'A',kind:'line',text:'the next thing said'}];
  P_.cues = [0,1];

  // the long speech first
  P_.els = [tall, short];
  P_.idx = 0; P_.sub = 0;
  const pages = T.pageCount(2400, 700, 700 - 52*1.34);
  ok(`the long speech is ${pages} screens`, pages === 4);

  T.step(1);
  ok('THE BUG: the first tap turns the page, it does not leave the line',
     P_.idx === 0 && P_.sub === 1);
  T.step(1); T.step(1);
  ok('it walks to the foot of the speech', P_.idx === 0 && P_.sub === pages-1);
  T.step(1);
  ok('only then does it move on',          P_.idx === 1);
  T.step(-1);
  ok('stepping back lands on the foot of the speech before, not its top',
     P_.idx === 0 && P_.sub === pages-1);

  // a speech that fits must behave exactly as it always did
  P_.els = [short, short];
  P_.idx = 0; P_.sub = 0;
  T.step(1);
  ok('a normal line still advances on the first tap', P_.idx === 1 && P_.sub === 0);
  P_.idx = 1; P_.sub = 0;
  T.step(-1);
  ok('and still steps back on the first tap',         P_.idx === 0);

  P_.on = false; P_.els = []; P_.sub = 0;
}

console.log('\nEDITING — a line must be placeable where it is needed, not only at the end');
{
  const ids = a => a.map(s=>s.id).join('');
  const base = () => ([{id:1,out:false},{id:2,out:false},{id:3,out:false},{id:4,out:false}]);

  const ins = T.insertAfterId(base(), 2, {id:9,out:false});
  ok('a new line lands directly below the one it was added from', ids(ins) === '12934');
  ok('and nothing else is disturbed',                             ins.length === 5);

  ok('an id that is not there appends rather than throwing the line away',
     ids(T.insertAfterId(base(), 77, {id:9,out:false})) === '12349');

  ok('down swaps with the line below',  ids(T.moveById(base(), 2,  1)) === '1324');
  ok('up swaps with the line above',    ids(T.moveById(base(), 3, -1)) === '1324');
  ok('two presses walk it two places',  ids(T.moveById(T.moveById(base(), 4, -1), 4, -1)) === '1423');

  ok('up at the top does nothing at all',      ids(T.moveById(base(), 1, -1)) === '1234');
  ok('down at the bottom does nothing at all', ids(T.moveById(base(), 4,  1)) === '1234');
  ok('an unknown id does nothing at all',      ids(T.moveById(base(), 77, 1)) === '1234');

  /* THE BUG this guards: trimmed lines are hidden unless "Show them" is on. A
     move of one array index can swap a line with something off screen, and the
     press then looks like it did nothing at all. It must land past the next
     VISIBLE line. */
  const trimmed = [{id:1,out:false},{id:2,out:false},{id:3,out:true},{id:4,out:false}];
  const shown = s => !s.out;
  ok('THE BUG: moving down steps over a trimmed line and visibly moves',
     ids(T.moveById(trimmed, 2, 1, shown)) === '1342');
  ok('moving up steps over it the other way',
     ids(T.moveById(trimmed, 4, -1, shown)) === '1423');
  ok('with the trimmed lines shown, the same press moves one place only',
     ids(T.moveById(trimmed, 2, 1, ()=>true)) === '1324');
  ok('a run of trimmed lines below pins the last visible line where it is',
     ids(T.moveById([{id:1,out:false},{id:2,out:false},{id:3,out:true}], 2, 1, shown)) === '123');

  /* nothing may ever be lost, whatever the press */
  let keep = base(), every = true;
  [[1,-1],[4,1],[2,1],[3,-1],[77,1],[1,1]].forEach(([id,d])=>{
    keep = T.moveById(keep, id, d, shown);
    if(keep.length !== 4 || new Set(keep.map(s=>s.id)).size !== 4) every = false;
  });
  ok('no sequence of moves ever loses or duplicates a line', every);
}

console.log('\nENGINES — one script on ElevenLabs and another on OpenAI must not fight');
{
  const S_ = T.S;
  const OA_LIST = T.OA.voices();

  /* THE BUG Michael reported: a character had ONE voice field shared by all
     three engines, and renderCast revalidated it against whichever engine was
     live. Setting up an ElevenLabs voice for one script therefore overwrote the
     OpenAI voice on every other script - and, because the library kept the cast
     by reference, inside the saved copies too. */
  S_.set.engine = 'openai'; S_.set.oaModel = 'gpt-4o-mini-tts';
  S_.segs = T.segsFromText('MICHAEL\nTell me.\n\nCLIENT\nI froze.').segs;
  S_.cast = { MICHAEL:{role:'me',voices:{}}, CLIENT:{role:'reader',voices:{}} };
  T.setVoiceOf('CLIENT', 'onyx');
  ok('the OpenAI voice is set',            T.voiceOf('CLIENT') === 'onyx');

  // switch to ElevenLabs with the key NOT checked - the realistic state
  S_.elVoices = [];
  S_.set.engine = 'elevenlabs';
  ok('ElevenLabs voices are not ready yet', T.voicesReady() === false);
  ok('so englishVoices falls back to the DEVICE list, not ElevenLabs',
     T.englishVoices().every(v => !/^[A-Za-z0-9]{20}$/.test(v.voiceURI)));
  T.renderCast();
  ok('THE BUG: the OpenAI voice survives the switch', T.voiceOf('CLIENT','openai') === 'onyx');
  ok('and ElevenLabs was not handed a device voice',  T.voiceOf('CLIENT','elevenlabs') === '');

  // now the key checks out and a real ElevenLabs voice is chosen
  S_.elVoices = [{voiceURI:'21m00Tcm4TlvDq8ikWAM',name:'Rachel',lang:'en'},
                 {voiceURI:'AZnzlk1XvdvUeBnXmlld',name:'Domi',  lang:'en'}];
  ok('now they are ready',                 T.voicesReady() === true);
  T.setVoiceOf('CLIENT', 'AZnzlk1XvdvUeBnXmlld');
  T.renderCast();
  ok('the ElevenLabs voice sticks',        T.voiceOf('CLIENT') === 'AZnzlk1XvdvUeBnXmlld');

  // ...and going back to OpenAI returns the ORIGINAL choice, so the clip that
  // was already paid for is still the one that gets looked up
  S_.set.engine = 'openai';
  T.renderCast();
  ok('switching back restores the paid-for OpenAI voice', T.voiceOf('CLIENT') === 'onyx');
  ok('which means the clip key is unchanged, so nothing is re-billed',
     T.clipKey('onyx', 'I froze.', T.engineModel(), '') ===
     T.clipKey(T.voiceOf('CLIENT'), 'I froze.', T.engineModel(), ''));

  S_.set.engine = 'elevenlabs';
  T.renderCast();
  ok('and forward again restores the ElevenLabs one', T.voiceOf('CLIENT') === 'AZnzlk1XvdvUeBnXmlld');

  /* the library kept `cast: S.cast` by reference, so a saved script was not a
     snapshot at all - editing the live cast rewrote every script that shared it */
  const live = { CLIENT:{role:'reader',voices:{openai:'onyx'}} };
  const snap = T.copyCast(live);
  live.CLIENT.voices.openai = 'sage';
  ok('THE BUG: a saved cast is a copy, not the live object',
     snap.CLIENT.voices.openai === 'onyx' && snap.CLIENT !== live.CLIENT);

  /* filing a legacy single voice into the slot it belonged to */
  const old = { A:{voice:'nova'}, B:{voice:'21m00Tcm4TlvDq8ikWAM'},
                C:{voice:'Microsoft David - English (United States)'}, D:{voice:''} };
  T.migrateCast(old);
  ok('an OpenAI id is filed under OpenAI',       old.A.voices.openai === 'nova');
  ok('a 20-character id is filed under ElevenLabs',
     old.B.voices.elevenlabs === '21m00Tcm4TlvDq8ikWAM');
  ok('a voiceURI is filed under the device',
     old.C.voices.system === 'Microsoft David - English (United States)');
  ok('an empty voice files nowhere',             Object.keys(old.D.voices).length === 0);
  ok('migrating twice changes nothing',
     (T.migrateCast(old), old.A.voices.openai === 'nova' && !old.A.voices.system));

  ok('a script’s engine can be inferred from the voices it kept',
     T.engineOfCast({ A:{voices:{openai:'nova'}}, B:{voices:{openai:'sage'}} }) === 'openai');
  ok('and is null when there is nothing to go on', T.engineOfCast({ A:{voices:{}} }) === null);

  S_.elVoices = [];
}

console.log('\nRECOVERY — the engine on the script is exactly what cannot be trusted');
{
  const S_ = T.S;

  /* Reported by Michael on r17: he pressed "Find the voices I've already paid
     for" and nothing happened. His TAI script had been saved by an older build
     AFTER that build overwrote the OpenAI voice with a Windows one, so the only
     voice left in it was a device voice. r17 inferred "this is a device script"
     from that device voice - believing the corruption - and recovery, which
     only ever searched the CURRENT engine, had nothing to search. */
  ok('THE BUG: a device voice is not evidence of a device script',
     T.engineOfCast({ CLIENT:{ voices:{ system:'Microsoft David - English (United States)' } } }) === null);
  ok('a paid voice still is',
     T.engineOfCast({ CLIENT:{ voices:{ system:'Microsoft David', openai:'onyx' } } }) === 'openai');

  S_.segs = T.segsFromText('MICHAEL\nTell me what happened.\n\nCLIENT\nI froze. Completely.').segs;
  S_.cast = { MICHAEL:{role:'me',voices:{}},
              CLIENT:{role:'reader',voices:{system:'Microsoft David - English (United States)'},dir:''} };
  S_.set.engine = 'system';                 // what r17 left him looking at
  S_.set.oaModel = 'gpt-4o-mini-tts';
  S_.elVoices = [];

  const text = T.candidateTexts('CLIENT')[0];
  ok('the character has a line to match on', !!text);

  // the clip he already paid for, made under OpenAI
  const paid = T.clipKey('onyx', text, 'gpt-4o-mini-tts', '');
  const have = new Set([paid]);

  const hit = T.findCachedVoice('CLIENT', have);
  ok('THE BUG: recovery finds OpenAI audio while the engine reads Device',
     !!hit && hit.engine === 'openai' && hit.voice === 'onyx');
  ok('and reports the model it was made with', hit && hit.model === 'gpt-4o-mini-tts');

  // a clip made with the OTHER OpenAI model must still be found
  const have2 = new Set([T.clipKey('sage', text, 'tts-1', '')]);
  const hit2 = T.findCachedVoice('CLIENT', have2);
  ok('a tts-1 clip is found and names tts-1',
     !!hit2 && hit2.voice === 'sage' && hit2.model === 'tts-1');

  // a clip made when a Direction was set must still be found
  S_.cast.CLIENT.dir = 'clipped and impatient';
  const have3 = new Set([T.clipKey('coral', text, 'gpt-4o-mini-tts', 'clipped and impatient')]);
  const hit3 = T.findCachedVoice('CLIENT', have3);
  ok('a clip made with a direction is found and carries it',
     !!hit3 && hit3.voice === 'coral' && hit3.dir === 'clipped and impatient');
  S_.cast.CLIENT.dir = '';

  // ElevenLabs, once its voices are loaded
  S_.elVoices = [{voiceURI:'21m00Tcm4TlvDq8ikWAM',name:'Rachel',lang:'en'}];
  const have4 = new Set([T.clipKey('21m00Tcm4TlvDq8ikWAM', text, T.EL_MODEL, '')]);
  const hit4 = T.findCachedVoice('CLIENT', have4);
  ok('an ElevenLabs clip is found too',
     !!hit4 && hit4.engine === 'elevenlabs' && hit4.voice === '21m00Tcm4TlvDq8ikWAM');
  S_.elVoices = [];

  ok('an empty cache finds nothing',      T.findCachedVoice('CLIENT', new Set()) === null);
  ok('an unrelated clip finds nothing',
     T.findCachedVoice('CLIENT', new Set([T.clipKey('onyx','Some other line entirely.','gpt-4o-mini-tts','')])) === null);

  /* the search must cover every engine, not just whichever is live - this is
     the property that r17 lacked */
  const engines = new Set(T.recoveryCandidates('CLIENT').map(c=>c.engine));
  ok('the search covers OpenAI whatever the live engine is', engines.has('openai'));
  ok('it covers both OpenAI models',
     new Set(T.recoveryCandidates('CLIENT').filter(c=>c.engine==='openai').map(c=>c.model)).size === 2);
  ok('every one of the 13 OpenAI voices is tried',
     new Set(T.recoveryCandidates('CLIENT').filter(c=>c.engine==='openai').map(c=>c.voice)).size === 13);
}

console.log('\nSYNC — opening the app must never overwrite newer work elsewhere');
{
  const S_ = T.S, Sync = T.Sync;

  /* Michael lost a day of work on a script that existed only in the working
     slot. Every copy - this device, the other device and the server - came back
     as a coherent snapshot from a week earlier.

     Cause: Sync.boot() fires pull() WITHOUT awaiting it, and boot() then calls
     refresh() -> save() -> Sync.mark(), which sets dirty. When the in-flight
     pull landed it saw dirty, concluded "this device is ahead", and pushed the
     stale local state over the newer server one - never applying what was
     there. Whichever device was opened LAST won, however old its data was. */

  const realRpc = Sync.rpc;
  let pushed = null;

  const base = { cast:{}, set:{...S_.set}, scripts:[], paste:'', mark:null };
  const stale = { ...base, segs:[{id:1,kind:'line',speaker:'MARA',text:'week old'}], name:'stale' };
  const fresh = { ...base, segs:[{id:9,kind:'line',speaker:'MARA',text:'todays work'}], name:'BOOKSTORE' };

  Sync.rpc = async (fn, body) => {
    if(fn === 'sync_push'){ pushed = body.p_blob; return { ok:true, data:'ts-push' }; }
    return { ok:true, data:[{ updated_at:'ts-server', blob:fresh }] };
  };

  Sync.code = 'test-code'; Sync.on = true; Sync.lastTs = null;
  Sync.dirty = false; Sync.hold = false; Sync.busy = false;
  T.applyState(stale);

  // exactly what boot() now does: hold pushes, pull un-awaited, quiet write-back
  Sync.hold = true;
  const inFlight = Sync.pull();
  Sync.mark(T.stateBlob(), true);            // boot's own save, marked quiet
  ok('THE BUG: booting does not mark the device dirty', Sync.dirty === false);
  await inFlight;
  Sync.hold = false;

  ok('so the pull applies the newer state instead of pushing over it',
     S_.name === 'BOOKSTORE' && pushed === null);
  ok('the server version it saw is remembered', Sync.lastTs === 'ts-server');

  // a REAL edit after boot must still mark dirty
  Sync.mark(T.stateBlob(), false);
  ok('a genuine edit still marks the device dirty', Sync.dirty === true);
  clearTimeout(Sync.timer);

  /* and the whole point: what was about to be replaced is kept */
  ok('the state the pull replaced was snapshotted first',
     (await T.History.list()).some(r => r.name === 'stale'));

  /* The case `quiet` actually exists for. If the pull FAILS - the device is
     offline, or the network is slow enough that hold has already lapsed - then
     boot's own write-back is the only thing that marks this device dirty, and
     the next time it reaches the network it pushes week-old data over whatever
     the server has. That is the exact path that destroyed the script. */
  Sync.rpc = async () => ({ ok:false, status:0 });      // offline
  Sync.lastTs = null; Sync.dirty = false; Sync.hold = false; pushed = null;
  T.applyState(stale);
  const failed = Sync.pull();
  Sync.mark(T.stateBlob(), true);                       // boot's write-back, offline
  await failed;
  ok('THE BUG: a failed pull plus boot\'s own save must not arm a stale push',
     Sync.dirty === false);

  Sync.rpc = realRpc; Sync.on = false; Sync.code = ''; Sync.dirty = false; Sync.lastTs = null;
}

console.log('\nHISTORY — nothing may replace the working script without keeping it');
{
  const S_ = T.S;

  S_.segs = T.segsFromText('MARA\nOne line.\n\nDANIEL\nAnother line.').segs;
  S_.cast = { MARA:{role:'me',voices:{}}, DANIEL:{role:'reader',voices:{}} };
  S_.name = 'Bookstore on Grace Street';
  const spoken = S_.segs.filter(x=>x.kind==='line').length;
  ok('the fixture really has two spoken lines', spoken === 2);

  const rec = await T.History.take('replaced by your other device');
  ok('a snapshot records the script it saved', !!rec && rec.name === 'Bookstore on Grace Street');
  ok('and how much was in it',                 rec.lines === 2);

  // something replaces the working script
  S_.segs = T.segsFromText('CLAIRE\nSomething else entirely.').segs;
  S_.name = 'Other';
  /* deliberately NOT snapshotted here - restoring must be what keeps it, or
     restoring the wrong version becomes a second way to lose work */
  const all = await T.History.list();
  ok('the snapshot survives the replacement',
     all.some(r => r.name === 'Bookstore on Grace Street'));

  const idx = all.findIndex(r => r.name === 'Bookstore on Grace Street');
  const back = await T.History.restore(idx);
  ok('restoring brings the script back', !!back && S_.name === 'Bookstore on Grace Street');
  ok('and it has its lines again',       S_.segs.filter(x=>x.kind==='line').length === 2);

  ok('restoring also keeps what it replaced, so it is never a one-way door',
     (await T.History.list()).some(r => r.name === 'Other'));

  S_.segs = [];
  ok('an empty script is not worth snapshotting', (await T.History.take('x')) === null);
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


(()=>{'use strict';
const $=id=>document.getElementById(id);
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const settings={
 v8:{cyl:4,shape:'sawtooth',cut:1700,top:6900},
 v10:{cyl:5,shape:'triangle',cut:2750,top:8300},
 v12:{cyl:6,shape:'sawtooth',cut:2300,top:8000},
 lambo10:{cyl:5,shape:'sawtooth',cut:3500,top:8500},
 lambo12:{cyl:6,shape:'sawtooth',cut:3100,top:8500},
 porscheev:{cyl:2,shape:'sine',cut:3800,top:7000}
};
let ctx=null,master=null,filter=null,warmShelf=null,saturator=null,compressor=null,analyser=null,osc=[],harmonics=[],noiseNode=null,noiseGain=null,noiseBand=null;
let pulseSource=null,pulseGain=null;const pulseBuffers=new Map();
let engine='porscheev',playing=false,desiredPlaying=false,starting=false,vol=.60,actualRpm=880,targetRpm=880,demoUntil=0,studioThrottle=0,watch=null;
let audioRequest=0;
let state={speed:0,accel:0,quality:'Đang tìm GPS',accuracy:null,lastFixTime:0,prev:null,samples:[],lastGear:1};
let lastPhase='';
// V23 remote telemetry is speed/accel only, never GPS coordinates.
let remote={speed:0,accel:0,accuracy:null,lastFixTime:0,quality:'Chưa kết nối iPhone'};
let selectedSensor='none';
window.__vf7ReceiveRemoteGPS=(data)=>{
 if(!data || !Number.isFinite(data.speed) || !Number.isFinite(data.accel) || !Number.isFinite(data.accuracy))return;
 if(data.speed<0||data.speed>240||Math.abs(data.accel)>6||data.accuracy<0||data.accuracy>100)return;
 remote={speed:data.speed,accel:data.accel,accuracy:data.accuracy,lastFixTime:Date.now(),quality:'GPS iPhone qua Render'};
};
// V22: GPS is a low-rate SENSOR, not the audio sample clock.
// A persistent native WebAudio graph keeps making sound between callbacks.
const drive={speed:0,accel:0,throttle:0,brake:0,phase:'IDLE',gpsFresh:false,gpsAge:Infinity,
  gear:1,lastUpdate:performance.now(),lastRender:0,lastRaf:performance.now(),lastGpsInterval:0,
  maxRafGap:0,interruptions:0};

const audioState=$('audioState'), audioDetail=$('audioDetail');
function status(message,kind='info'){
 $('status').textContent=message;
 if(audioDetail){audioDetail.textContent=(kind==='warn'||kind==='error')?message:'';audioDetail.hidden=!(kind==='warn'||kind==='error');}
 if(audioState){audioState.dataset.kind=kind;}
}
function paintAudio(){
 const cstate=ctx?ctx.state:'not-created';
 let label='● CHƯA BẬT',kind='off';
 if(starting){label='◌ ĐANG KẾT NỐI';kind='wait';}
 else if(cstate==='running'&&playing){label='● ÂM THANH ĐANG CHẠY';kind='on';}
 else if((cstate==='suspended'||cstate==='interrupted')&&desiredPlaying){label='● BỊ TẠM DỪNG';kind='warn';}
 else if(cstate==='running'){label='● ÂM THANH SẴN SÀNG';kind='ready';}
 else if(cstate==='closed'){label='● ĐÃ ĐÓNG';kind='warn';}
 if(audioState){audioState.textContent=label;audioState.dataset.kind=kind;}
 const s=$('webAudioState');if(s)s.textContent=cstate.toUpperCase();
 $('start').textContent=desiredPlaying?'■ TẮT PÔ':'▶ BẬT PÔ';
 $('start').classList.toggle('off',desiredPlaying);
}
function ensureContext(){
 const AC=window.AudioContext||window.webkitAudioContext;
 if(!AC)throw Error('Trình duyệt không hỗ trợ Web Audio.');
 if(!ctx||ctx.state==='closed'){
  ctx=new AC({latencyHint:'interactive'});
  master=ctx.createGain();master.gain.value=0;
  // Gentle pre-EQ and mild tube-like saturation rather than bright raw sawtooth.
  filter=ctx.createBiquadFilter();filter.type='lowpass';filter.frequency.value=800;filter.Q.value=.57;
  warmShelf=ctx.createBiquadFilter();warmShelf.type='lowshelf';warmShelf.frequency.value=220;warmShelf.gain.value=2.5;
  saturator=ctx.createWaveShaper();const curve=new Float32Array(2048);
  for(let i=0;i<curve.length;i++){const x=2*i/(curve.length-1)-1;curve[i]=Math.tanh(1.2*x)/Math.tanh(1.2);}
  saturator.curve=curve;saturator.oversample='2x';
  compressor=ctx.createDynamicsCompressor();compressor.threshold.value=-16;compressor.knee.value=14;compressor.ratio.value=2.6;compressor.attack.value=.015;compressor.release.value=.22;
  analyser=ctx.createAnalyser();analyser.fftSize=256;
  saturator.connect(warmShelf);warmShelf.connect(filter);filter.connect(master);master.connect(compressor);compressor.connect(analyser);analyser.connect(ctx.destination);
  ctx.onstatechange=()=>{paintAudio();if(ctx.state==='interrupted'||ctx.state==='suspended'){drive.interruptions++;
    status('Web Audio '+ctx.state+'. Chạm BẬT PÔ hoặc TEST LOA khi trình duyệt ở tiền cảnh để kích hoạt lại.','warn');
   }};
 }
 // Crucial: resume() is called directly in the user's tap handler (not after await).
 const promise=ctx.resume();
 if(promise&&typeof promise.catch==='function')promise.catch(e=>status('Trình duyệt từ chối phát âm thanh: '+e.message,'warn'));
 return ctx;
}
// A short ORIGINAL multi-cylinder exhaust pulse train. Generated in-browser; no commercial car recordings.
// Each pulse has its own tiny timing/level variation to avoid a continuous synthesizer buzz.
function enginePulseBuffer(profile){
 const key=profile+'@'+ctx.sampleRate;if(pulseBuffers.has(key))return pulseBuffers.get(key);
 const cyl={v8:8,v10:10,v12:12,lambo10:10,lambo12:12}[profile]||8;
 const baseRpm=900,cycles=8,sec=cycles*120/baseRpm,sampleRate=ctx.sampleRate;
 const size=Math.round(sec*sampleRate),events=cycles*cyl,b=ctx.createBuffer(1,size,sampleRate),pcm=b.getChannelData(0);
 let seed=10391+cyl*71+profile.length*109;
 const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
 const kernelSize=Math.round(sampleRate*.032),eventSpacing=size/events;
 const resonance=cyl===8?145:cyl===10?185:215;
 const ringDecay=cyl===8?105:cyl===10?128:144;
 const seedBase=random()*Math.PI*2;
 for(let event=0;event<events;event++){
  const micro=(random()-.5)*eventSpacing*.09;
  const begin=Math.floor(event*eventSpacing+micro+size)%size;
  const level=.87+random()*.20+(event%4===0?.05:0);
  let phase=seedBase+(event%3)*.13;
  for(let k=0;k<kernelSize;k++){
   const t=k/sampleRate;
   // Low exhaust pressure body, rounded attack with decaying midrange resonance.
   const envelope=(1-Math.exp(-t*1200))*Math.exp(-t*ringDecay);
   const body=Math.sin(2*Math.PI*resonance*t+phase)*.76;
   const overtone=Math.sin(2*Math.PI*resonance*1.73*t+.52)*.22;
   const breath=(random()*2-1)*Math.exp(-t*420)*.075;
   pcm[(begin+k)%size]+=level*envelope*(body+overtone+breath);
  }
 }
 let peak=0,mean=0;for(let i=0;i<size;i++){mean+=pcm[i];peak=Math.max(peak,Math.abs(pcm[i]));}
 mean/=size;let centeredPeak=0;
 for(let i=0;i<size;i++)centeredPeak=Math.max(centeredPeak,Math.abs(pcm[i]-mean));
 const scale=.82/Math.max(.01,centeredPeak);
 for(let i=0;i<size;i++)pcm[i]=(pcm[i]-mean)*scale;
 pulseBuffers.set(key,b);return b;
}
function changePulseVoice(nextProfile){
 if(!ctx||nextProfile==='porscheev'){
  if(pulseGain){pulseGain.gain.setTargetAtTime(0,ctx.currentTime,.06);}
  return;
 }
 const oldSource=pulseSource,oldGain=pulseGain;
 const node=ctx.createBufferSource(),gain=ctx.createGain();node.buffer=enginePulseBuffer(nextProfile);node.loop=true;
 gain.gain.value=0;node.connect(gain);gain.connect(saturator);node.start();
 pulseSource=node;pulseGain=gain;
 if(oldGain&&oldSource){
  oldGain.gain.setTargetAtTime(0,ctx.currentTime,.055);
  try{oldSource.stop(ctx.currentTime+.32)}catch(e){}
  oldSource.onended=()=>{try{oldSource.disconnect();oldGain.disconnect()}catch(e){}};
 }
}
function clearVoices(){
 for(const o of osc){try{o.stop()}catch(e){}try{o.disconnect()}catch(e){}}
 if(noiseNode){try{noiseNode.stop()}catch(e){}try{noiseNode.disconnect()}catch(e){}}
 if(pulseSource){try{pulseSource.stop()}catch(e){}try{pulseSource.disconnect()}catch(e){}}
 if(pulseGain){try{pulseGain.disconnect()}catch(e){}}
 osc=[];harmonics=[];noiseNode=null;noiseGain=null;noiseBand=null;pulseSource=null;pulseGain=null;
}
function createVoices(){
 if(!ctx)return;
 clearVoices();
 for(let i=0;i<4;i++){
  const o=ctx.createOscillator(),g=ctx.createGain();
  o.type=i===2?'triangle':'sine';o.frequency.value=[70,140,215,320][i];
  g.gain.value=0;o.connect(g);g.connect(saturator);o.start();osc.push(o);harmonics.push(g);
 }
 const len=Math.round(ctx.sampleRate*.33),buffer=ctx.createBuffer(1,len,ctx.sampleRate),data=buffer.getChannelData(0);
 for(let i=0;i<len;i++)data[i]=(Math.random()*2-1)*.45;
 noiseNode=ctx.createBufferSource();noiseNode.buffer=buffer;noiseNode.loop=true;
 noiseBand=ctx.createBiquadFilter();noiseBand.type='bandpass';noiseBand.frequency.value=260;noiseBand.Q.value=.75;
 noiseGain=ctx.createGain();noiseGain.gain.value=0;
 noiseNode.connect(noiseBand);noiseBand.connect(noiseGain);noiseGain.connect(saturator);noiseNode.start();
 if(engine!=='porscheev')changePulseVoice(engine);
}
// Nonlinear pedal curve. 10% -> just above idle, 30% -> moderate revs, 100% -> redline.
function pedalResponse(pedal){
 const p=clamp(pedal/100,0,1);
 return p<=.30?.18*Math.pow(p/.30,1.62):.18+.82*Math.pow((p-.30)/.70,1.2);
}
function updateVoice(now,th,speed,acc,gpsFresh){
 if(!ctx||!playing||ctx.state!=='running')return;
 const t=ctx.currentTime,p=settings[engine],ev=engine==='porscheev',drive=clamp(th/100,0,1);
 if(ev){
  const pitch=125+510*Math.pow(drive,.82)+Math.min(speed,140)*1.2;
  const freq=[pitch,pitch*1.5,pitch*2,pitch*2.75],amps=[.28,.16,.09,.045];
  osc.forEach((o,i)=>{o.type='sine';o.frequency.setTargetAtTime(freq[i],t,.085);harmonics[i].gain.setTargetAtTime(amps[i]*(.80+.32*drive),t,.14)});
  filter.frequency.setTargetAtTime(2400+drive*3600,t,.12);
  warmShelf.gain.setTargetAtTime(0,t,.2);
  noiseBand.frequency.setTargetAtTime(540+drive*2100,t,.12);
  noiseGain.gain.setTargetAtTime(.010+drive*.040,t,.15);
  if(pulseGain)pulseGain.gain.setTargetAtTime(0,t,.075);
  master.gain.setTargetAtTime(vol*(.46+.16*drive),t,.11);
 }else{
  const cyl=engine.startsWith('lambo10')||engine==='v10'?10:engine==='lambo12'||engine==='v12'?12:8;
  const firing=Math.max(44,actualRpm*cyl/120);
  const idleBlend=1-Math.pow(drive,.55);
  // Subtle irregular combustion at idle; becomes steadier as throttle rises.
  const wobble=(Math.sin(now*.0084)*.006+Math.sin(now*.0137+.7)*.0035)*idleBlend;
  const multipliers=[1,2,3,4];
  const gains=engine.startsWith('lambo')?[.175,.082,.035,.014]:[.19,.078,.029,.012];
  const opening=pedalResponse(th);
  osc.forEach((o,i)=>{
   o.type=i===2?'triangle':'sine';
   o.frequency.setTargetAtTime(Math.min(4400,firing*multipliers[i]*(1+wobble)),t,.09);
   const presence=i<2?1:.10+.90*Math.pow(drive,1.35);
   harmonics[i].gain.setTargetAtTime(gains[i]*(.94+.32*opening)*presence,t,.13);
  });
  if(pulseSource){
   pulseSource.playbackRate.setTargetAtTime(clamp(actualRpm/900*(1+wobble),.65,10),t,.10);
   pulseGain.gain.setTargetAtTime(.27+.11*opening,t,.17);
  }
  // Critical change: strong lowpass in 0-30% pedal range; no piercing sawtooth at idle.
  filter.frequency.setTargetAtTime(Math.min(6300,620+5400*Math.pow(opening,1.60)+actualRpm*.08),t,.15);
  filter.Q.setTargetAtTime(.55+.12*opening,t,.17);
  warmShelf.gain.setTargetAtTime(2.8-1.2*drive,t,.18);
  noiseBand.frequency.setTargetAtTime(260+drive*900,t,.16);
  noiseGain.gain.setTargetAtTime(.0025+Math.pow(drive,1.65)*.023,t,.18);
  master.gain.setTargetAtTime(vol*(.48+.16*opening),t,.14);
 }
}
function startAudio(){
 try{
  if(desiredPlaying)return;
  desiredPlaying=true;
  const id=++audioRequest;
  const context=ensureContext();
  if(!playing){createVoices();playing=true;}
  starting=context.state!=='running';
  paintAudio();
  status(starting?'Đang mở Web Audio…':'Đã bật tiếng động cơ. Không cần GPS để nghe idle.','info');
  if(context.state==='running'){starting=false;paintAudio();}
  else{
   // Do not rely on an unresolved resume() promise on WebKit.
   setTimeout(()=>{
    if(id!==audioRequest||!desiredPlaying||!ctx)return;
    starting=false;paintAudio();
    if(ctx.state==='running'){status('Web Audio RUNNING. Nếu vẫn không nghe hãy thử TEST LOA và kiểm tra nguồn Media/CarPlay.','on');}
    else status('Âm thanh bị chặn ('+ctx.state+'). Chạm TEST LOA hoặc BẬT PÔ lần nữa ở tiền cảnh.','warn');
   },1700);
  }
 }catch(e){desiredPlaying=false;playing=false;starting=false;paintAudio();status('Không mở được âm thanh: '+e.message,'warn')}
}
function stopAudio(){
 ++audioRequest;desiredPlaying=false;playing=false;starting=false;
 if(ctx&&master){const t=ctx.currentTime;master.gain.cancelScheduledValues(t);master.gain.setTargetAtTime(0,t,.025)}
 // Each next start creates fresh voices; retain AudioContext for iPhone/Safari.
 setTimeout(()=>{if(!desiredPlaying)clearVoices()},180);
 paintAudio();status('Đã tắt tiếng pô. Có thể bật lại hoặc thử TEST LOA.','off');
}
async function testSpeaker(){
 try{
  const c=ensureContext();
  // Test output independently of the engine voices. One shared AudioContext.
  const o=c.createOscillator(),g=c.createGain();
  o.type='sine';o.frequency.setValueAtTime(740,c.currentTime);
  g.gain.setValueAtTime(.0001,c.currentTime);
  g.gain.exponentialRampToValueAtTime(.18,c.currentTime+.04);
  g.gain.setValueAtTime(.18,c.currentTime+.42);
  g.gain.exponentialRampToValueAtTime(.0001,c.currentTime+.7);
  o.connect(g);g.connect(c.destination);o.start();o.stop(c.currentTime+.74);
  o.onended=()=>{try{o.disconnect();g.disconnect()}catch(e){}};
  paintAudio();
  status('Đã gửi tiếng BÍP thử loa. Web Audio: '+c.state+'. Nếu không nghe, kiểm tra đường phát CarPlay/APTV.','info');
  setTimeout(()=>{if(ctx&&ctx.state!=='running')status('Không nghe và AudioContext='+ctx.state+'. Trình duyệt có thể đang chặn âm thanh.','warn')},900);
 }catch(e){status('TEST LOA lỗi: '+e.message,'warn')}
}
function distance(a,b){const r=Math.PI/180,dl=(b.lon-a.lon)*r,dp=(b.lat-a.lat)*r,x=Math.sin(dp/2)**2+Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin(dl/2)**2;return 12742000*Math.asin(Math.min(1,Math.sqrt(x)))}
function gpsFix(pos){
 const c=pos.coords,t=pos.timestamp||Date.now(),accuracy=Number(c.accuracy);
 if(!Number.isFinite(accuracy)||accuracy>65){state.quality='GPS yếu: bỏ mẫu >65m';return;}
 if(state.prev&&t<=state.prev.t)return;
 const point={lat:c.latitude,lon:c.longitude,t,acc:accuracy};const dt=state.prev?(t-state.prev.t)/1000:0;
 let mps=c.speed==null?NaN:Number(c.speed);
 if(!Number.isFinite(mps)||mps<0){
  if(state.prev&&dt>=.8&&dt<=8&&accuracy<=30&&state.prev.acc<=30){const d=distance(state.prev,point);mps=d<Math.max(5,(accuracy+state.prev.acc)*.35)?0:d/dt;}else mps=NaN;
 }
 if(Number.isFinite(mps)&&mps>=0&&mps<=65){
  const kph=mps*3.6;
  if(state.samples.length&&dt>0&&dt<7&&Math.abs(kph-state.speed)>Math.max(14,dt*16)){state.quality='GPS nhiễu: bỏ mẫu';state.prev=point;return;}
  state.samples.push({t,v:mps});state.samples=state.samples.filter(x=>t-x.t<=4500).slice(-8);
  const alpha=state.lastFixTime?clamp(dt/(1.8+dt),.17,.72):1;
  state.speed=state.lastFixTime?state.speed+(kph-state.speed)*alpha:kph;
  if(state.speed<2.5)state.speed=0;
  const pts=state.samples,meanT=pts.reduce((a,x)=>a+x.t,0)/pts.length,meanV=pts.reduce((a,x)=>a+x.v,0)/pts.length;
  let num=0,den=0;for(const x of pts){const d=(x.t-meanT)/1000;num+=d*(x.v-meanV);den+=d*d;}
  const rawAcc=den>.65?clamp(num/den,-4,4):0;
  state.accel=state.accel*.6+(Math.abs(rawAcc)<.25?0:rawAcc)*.4;
  if(Math.abs(state.accel)<.18)state.accel=0;
  if(state.lastFixTime)drive.lastGpsInterval=Date.now()-state.lastFixTime;
  state.lastFixTime=Date.now();state.accuracy=accuracy;state.quality=accuracy<15?'GPS tốt':'GPS trung bình';
 }else state.quality='Chưa có tốc độ GPS đáng tin cậy';
 state.prev=point;
}
function setGPS(on){
 if(watch!==null){try{navigator.geolocation.clearWatch(watch)}catch(e){}watch=null}
 state={speed:0,accel:0,quality:on?'Đang tìm tín hiệu GPS':'GPS đã tắt',accuracy:null,lastFixTime:0,prev:null,samples:[],lastGear:1};
 if(!on)return;
 if(!navigator.geolocation){state.quality='Trình duyệt không hỗ trợ GPS';return;}
 if(!window.isSecureContext){state.quality='Cần HTTPS để dùng GPS';return;}
 try{watch=navigator.geolocation.watchPosition(gpsFix,e=>{
   state.quality=e.message.includes('permissions policy')?'GPS bị chặn bởi Permissions Policy':'GPS lỗi: '+e.message;
  },{enableHighAccuracy:true,maximumAge:0,timeout:15000});}
 catch(e){state.quality='GPS không khả dụng: '+e.message;}
}
// 40 ms CONTROL loop: never start/stop voice nodes because a GPS fix arrives late.
function updateDrive(){
 const mono=performance.now(),dt=clamp((mono-drive.lastUpdate)/1000,.008,.25);drive.lastUpdate=mono;
 const now=Date.now();
 const localAge=state.lastFixTime?(now-state.lastFixTime)/1000:Infinity;
 const phoneAge=remote.lastFixTime?(now-remote.lastFixTime)/1000:Infinity;
 // Prefer native APTV GPS when it has a recent credible fix; otherwise use phone GPS.
 selectedSensor=localAge<5.5?'aptv':phoneAge<5.5?'iphone':'none';
 const data=selectedSensor==='aptv'?state:selectedSensor==='iphone'?remote:state;
 const age=data.lastFixTime?(now-data.lastFixTime)/1000:Infinity;
 const demo=now<demoUntil,percent=demo?clamp(1-(demoUntil-now)/8500,0,1):0;
 const valid=selectedSensor!=='none' && age<10; drive.gpsAge=age; drive.gpsFresh=valid;
 let sensorSpeed=0,sensorAccel=0;
 if(valid){
   // Predict at most 1.15 s from the most recent GPS fix. Acceleration confidence fades
   // when readings grow old, then eases back to idle instead of abruptly muting.
   const confidence=clamp((10-age)/3,0,1);
   const accelWeight=Math.exp(-Math.max(0,age-.8)/2.1);
   sensorAccel=clamp(data.accel*accelWeight*confidence,-3.5,3.5);
   const ahead=clamp(age,0,1.15);
   sensorSpeed=Math.max(0,(data.speed+sensorAccel*3.6*ahead)*confidence);
 }
 if(demo){sensorSpeed=90*percent;sensorAccel=percent<.75?2.0:-1.2;}
 const thRaw=demo?clamp(30+65*Math.sin(Math.PI*percent),0,100):valid?
    clamp(sensorAccel>.23?13+sensorAccel*28:sensorSpeed>4?9+Math.min(sensorSpeed,135)*.13:0,0,100):studioThrottle;
 const brakeRaw=(valid||demo)&&sensorAccel<-.42?clamp((-sensorAccel-.28)*30,0,100):0;
 // Ease throttle changes between sparse GPS updates. Avoid stepping every 1-2 s.
 const thTau=thRaw>drive.throttle?.30:.52;
 drive.throttle+=(thRaw-drive.throttle)*(1-Math.exp(-dt/thTau));
 drive.brake+=(brakeRaw-drive.brake)*(1-Math.exp(-dt/.40));
 drive.speed+=(sensorSpeed-drive.speed)*(1-Math.exp(-dt/.48));
 drive.accel+=(sensorAccel-drive.accel)*(1-Math.exp(-dt/.42));
 if(drive.speed<.4)drive.speed=0;
 const speed=drive.speed,acc=drive.accel,th=drive.throttle,br=drive.brake;
 const ideal=clamp(Math.floor(speed/30)+1,1,6);let gear=state.lastGear;
 if(ideal>gear&&speed>gear*30+4)gear++;else if(ideal<gear&&speed<(gear-1)*30-5)gear--;
 state.lastGear=clamp(gear,1,6);drive.gear=state.lastGear;
 const p=settings[engine],ev=engine==='porscheev',idle=ev?950:880;
 let next=ev?950+th/100*5200:idle+pedalResponse(th)*(p.top-idle)-(br/100)*750-(drive.gear-1)*145;
 if(valid&&speed>4&&Math.abs(acc)<.15)next=Math.max(next,ev?1200+speed*16:1050+speed*13);
 targetRpm=clamp(next,ev?850:800,p.top);
 const seconds=targetRpm>actualRpm?(th<30?.43:.30):.57;
 actualRpm+=(targetRpm-actualRpm)*(1-Math.exp(-dt/seconds));
 drive.phase=demo?'DEMO ÂM THANH':!valid?(studioThrottle>0?'STUDIO • GA THỬ':'IDLE • KHÔNG CẦN GPS'):
 speed<3?'DỪNG XE':acc>.35?'TĂNG TỐC (ƯỚC TÍNH)':acc<-.42?'GIẢM TỐC (ƯỚC TÍNH)':'CHẠY ĐỀU';
 // Native OscillatorNode and BufferSourceNode live on the browser audio render thread,
 // continuing at the last safe parameter values when the UI timer gets delayed.
 updateVoice(now,th,speed,acc,valid);
}
// UI frame rate reduced to ~12fps to reduce WebView/main-thread load.
function renderHUD(timestamp){
 const gap=timestamp-drive.lastRaf;drive.lastRaf=timestamp;
 if(gap>drive.maxRafGap)drive.maxRafGap=gap;
 if(timestamp-drive.lastRender>=80){
  drive.lastRender=timestamp;
  const now=Date.now(),p=settings[engine],fresh=drive.gpsFresh;
  $('rpm').textContent=Math.round(actualRpm).toLocaleString('en-US');
  const arc=$('rpmArc'),rpmNorm=clamp(actualRpm/p.top,0,1);
  if(arc){
    arc.setAttribute('stroke-dasharray',`${(rpmNorm*100).toFixed(2)} 100`);
    const power=Math.min(10,Math.floor(rpmNorm*11));
    if(renderHUD.lastGlowPower!==power){
      renderHUD.lastGlowPower=power;const g=power/10;
      arc.style.setProperty('filter',`drop-shadow(0 0 ${(2.5+8*g).toFixed(1)}px rgba(41,182,246,${(.12+.40*g).toFixed(2)})) drop-shadow(0 0 ${(4+11*g).toFixed(1)}px rgba(1,87,155,${(.06+.25*g).toFixed(2)})) brightness(${(1+.30*g).toFixed(2)})`,'important');
    }
    if(renderHUD.arcInit!==true){renderHUD.arcInit=true;renderHUD.arcLength=arc.getTotalLength();}
    const pt=arc.getPointAtLength(renderHUD.arcLength*rpmNorm),halo=$('rpmTipHalo'),tip=$('rpmTip');
    if(halo&&tip){
      halo.setAttribute('cx',pt.x.toFixed(1));halo.setAttribute('cy',pt.y.toFixed(1));
      tip.setAttribute('cx',pt.x.toFixed(1));tip.setAttribute('cy',pt.y.toFixed(1));
      const alpha=clamp((rpmNorm-.10)*1.4,0,.82);
      halo.setAttribute('opacity',(alpha*.22).toFixed(2));tip.setAttribute('opacity',alpha.toFixed(2));
    }
  }
  $('rpmState').textContent=drive.phase;
  $('speed').textContent=Math.round(drive.speed);
  $('gear').textContent=engine==='porscheev'?'EV':drive.gear;
  $('throttleN').textContent=Math.round(drive.throttle)+'%*';
  const thSrc=$('throttleSource');if(thSrc)thSrc.textContent=now<demoUntil?'Demo simulated':fresh?'GPS estimated':'Studio manual';
  const source=selectedSensor==='aptv'?state:selectedSensor==='iphone'?remote:state;
  $('gpsAge').textContent=source.lastFixTime?((now-source.lastFixTime)/1000).toFixed(1):'--';
  $('gpsLiveSpeed').textContent=fresh?Math.round(drive.speed):'--';
  $('gpsLiveAccel').textContent=fresh?drive.accel.toFixed(2):'--';
  $('gpsPhase').textContent=drive.phase;
  $('gpsAccuracy').textContent=source.accuracy===null?'--':Math.round(source.accuracy);
  $('gpsQuality').textContent=fresh?(selectedSensor==='iphone'?'● GPS IPHONE':'● GPS APTV'):state.lastFixTime||remote.lastFixTime?'GPS gián đoạn · âm thanh vẫn chạy':state.quality;
  if(analyser&&ctx&&ctx.state==='running'&&playing){
    const arr=new Uint8Array(analyser.fftSize);analyser.getByteTimeDomainData(arr);
    let sum=0;for(let i=0;i<arr.length;i++){const d=(arr[i]-128)/128;sum+=d*d;}
    const rms=Math.sqrt(sum/arr.length),m=$('signalMeter');if(m)m.style.width=Math.min(100,Math.round(rms*440))+'%';
  }else{const m=$('signalMeter');if(m)m.style.width='0%';}
  const diag=$('streamDiag');if(diag){
    const gps=Number.isFinite(drive.gpsAge)?drive.gpsAge.toFixed(1)+'s':'--';
    const interval=drive.lastGpsInterval?Math.round(drive.lastGpsInterval)+'ms':'--';
    diag.textContent='Web Audio: '+(ctx?.state||'chưa bật')+' · GPS age: '+gps+' · GPS interval: '+interval+' · UI gap tối đa: '+Math.round(drive.maxRafGap)+'ms · Audio interruptions: '+drive.interruptions+' (không xác nhận được đầu ra loa)';
  }
 }
 requestAnimationFrame(renderHUD);
}
// These are intentionally separate from GPS callbacks and from the HUD render loop.
setInterval(updateDrive,40);
$('start').addEventListener('click',()=>{if(desiredPlaying)stopAudio();else startAudio();});
$('testTone').addEventListener('click',testSpeaker);
$('demoSound').addEventListener('click',()=>{
 demoUntil=Date.now()+8500;
 if(!desiredPlaying)startAudio();
 status('Đang mô phỏng tăng tốc trong 8,5 giây, không dùng GPS. Hãy thử khi xe đang đỗ.','on');
});
$('retryGPS').addEventListener('click',()=>{setGPS(true);status('Đang thử kết nối lại GPS. Âm thanh vẫn chạy độc lập.','info')});
$('fullscreen').addEventListener('click',async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else if(document.documentElement.requestFullscreen)await document.documentElement.requestFullscreen();else status('APTV không hỗ trợ Fullscreen API.','warn')}catch(e){status('Không bật được toàn màn hình: '+e.message,'warn')}});
$('volume').addEventListener('input',e=>{vol=Number(e.target.value)/100;$('volumeVal').textContent=e.target.value+'%';});
const slider=$('studioThrottle');if(slider)slider.addEventListener('input',e=>{studioThrottle=+e.target.value;$('studioVal').textContent=studioThrottle+'%';});
document.querySelectorAll('[data-engine]').forEach(b=>b.addEventListener('click',()=>{
 engine=b.dataset.engine;
 if(playing&&ctx&&ctx.state!=='closed')changePulseVoice(engine);
 document.querySelectorAll('[data-engine]').forEach(x=>x.classList.toggle('active',x===b));
 $('profile').textContent=b.firstChild?.textContent.trim()||engine;
}));
$('supportGeo').textContent=navigator.geolocation?'YES':'NO';
$('supportAudio').textContent=(window.AudioContext||window.webkitAudioContext)?'YES':'NO';
function recoverForeground(){
 if(!document.hidden&&desiredPlaying&&ctx&&(ctx.state==='suspended'||ctx.state==='interrupted')){
   try{const pending=ctx.resume();if(pending&&pending.catch)pending.catch(()=>{});}catch(e){}
 }
 paintAudio();
}
document.addEventListener('visibilitychange',()=>{
 if(document.hidden&&desiredPlaying)status('APTV/WebView xuống nền; iOS có thể tạm ngắt âm thanh.','warn');
 else recoverForeground();
});
window.addEventListener('pageshow',recoverForeground);
document.querySelectorAll('[data-engine]').forEach(b=>b.classList.toggle('active',b.dataset.engine===engine));
$('profile').textContent='Porsche EV';
paintAudio();status('','off');
setGPS(true);
// Developer diagnostics: reports browser synthesis only, not whether the car's speakers emit sound.
window.__vf7AudioDebug=()=>({audioContext:ctx?.state??'not-created',playing,desiredPlaying,profile:engine,rpm:Math.round(actualRpm),volume:vol,studioThrottle,pedalCurve:pedalResponse(studioThrottle),pulseActive:!!pulseSource,lowpassHz:Math.round(filter?.frequency.value||0),gpsFresh:drive.gpsFresh,gpsSource:selectedSensor});
updateDrive();requestAnimationFrame(renderHUD);
})();

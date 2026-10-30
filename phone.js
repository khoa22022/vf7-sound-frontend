(()=>{'use strict';
const $=id=>document.getElementById(id);
const backend=(window.VF7_CONFIG?.BACKEND_URL||'').trim().replace(/\/$/,'');
let ws=null,connected=false,watch=null,previous=null,lastSpeed=0,lastAccel=0,seq=0;
const message=t=>$('status').textContent=t;
function stopGPS(){if(watch!==null){navigator.geolocation.clearWatch(watch);watch=null;}$('start').disabled=!connected;$('stop').disabled=!ws;}
function teardown(){stopGPS();if(ws){const w=ws;ws=null;w.close();}connected=false;$('join').disabled=false;$('start').disabled=true;$('stop').disabled=true;}
function dist(a,b){const r=Math.PI/180,dp=(b.lat-a.lat)*r,dl=(b.lon-a.lon)*r;return 12742000*Math.asin(Math.min(1,Math.sqrt(Math.sin(dp/2)**2+Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin(dl/2)**2)));}
$('join').onclick=()=>{
 if(!backend){message('Chưa cấu hình BACKEND_URL trong config.js');return;}
 const code=$('code').value.trim().toUpperCase().replace(/\s+/g,'');if(!/^[A-HJ-NP-Z2-9]{8}$/.test(code)){message('Nhập đúng mã ghép nối 8 ký tự');return;}
 try{
   ws=new WebSocket(backend.replace(/^https:/,'wss:').replace(/^http:/,'ws:')+'/ws');const thisWs=ws;
   $('join').disabled=true;message('Đang kết nối tới Render…');
   thisWs.onopen=()=>thisWs.send(JSON.stringify({type:'phone.join',code}));
   thisWs.onmessage=e=>{let m;try{m=JSON.parse(e.data);}catch{return;}
     if(m.type==='phone.joined'){connected=true;$('start').disabled=false;$('stop').disabled=false;message('Đã ghép nối. Nhấn BẬT GPS VÀ GỬI.');}
     if(m.type==='error'){message(m.message);teardown();}
     if(m.type==='session.closed'){message('Phiên ghép nối đã hết hạn.');teardown();}
   };
   thisWs.onerror=()=>message('Không kết nối được backend Render');
   thisWs.onclose=()=>{if(thisWs!==ws)return;teardown();message('Đã mất kết nối. Hãy ghép nối lại.');};
 }catch(e){message(e.message);teardown();}
};
$('start').onclick=()=>{
 if(!connected||!navigator.geolocation){message('Không có GPS hoặc chưa ghép nối');return;}
 if(!window.isSecureContext){message('Cần mở bằng HTTPS');return;}
 stopGPS();previous=null;lastSpeed=0;lastAccel=0;seq=0;
 watch=navigator.geolocation.watchPosition(pos=>{
   const c=pos.coords,time=pos.timestamp||Date.now(),accuracy=Number(c.accuracy);
   if(!Number.isFinite(accuracy)||accuracy>65){message('GPS yếu, đợi tín hiệu chính xác hơn');return;}
   let speedMps=c.speed==null?NaN:Number(c.speed);
   const point={lat:c.latitude,lon:c.longitude,t:time,acc:accuracy};
   const dt=previous?(time-previous.t)/1000:0;
   if(!Number.isFinite(speedMps)||speedMps<0){
     if(previous&&dt>.6&&dt<8&&accuracy<=25&&previous.acc<=25){const d=dist(previous,point);speedMps=d<Math.max(4,(accuracy+previous.acc)*.3)?0:d/dt;}
     else speedMps=NaN;
   }
   previous=point;
   if(!Number.isFinite(speedMps)||speedMps<0||speedMps>66)return;
   const speed=speedMps*3.6;
   if(dt>0&&dt<7 && Math.abs(speed-lastSpeed)>Math.max(18,dt*18))return;
   const accel=dt>.5&&dt<8?Math.max(-6,Math.min(6,((speed-lastSpeed)/3.6)/dt)):0;
   lastAccel=lastAccel*.55+accel*.45;lastSpeed=speed;
   $('speed').textContent=Math.round(speed);$('accel').textContent=lastAccel.toFixed(2);$('accuracy').textContent=Math.round(accuracy);
   if(ws?.readyState===WebSocket.OPEN){ws.send(JSON.stringify({type:'gps',speed,accel:lastAccel,accuracy,seq:++seq}));message('● Đang gửi GPS đến màn hình APTV');}
 },e=>message('GPS lỗi: '+e.message),{enableHighAccuracy:true,maximumAge:0,timeout:15000});
 $('start').disabled=true;$('stop').disabled=false;message('Đang xin quyền GPS. Hãy chọn Cho phép vị trí chính xác.');
};
$('stop').onclick=()=>{teardown();message('Đã dừng gửi GPS và ngắt ghép nối');};
window.addEventListener('pagehide',stopGPS);
})();

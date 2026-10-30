(()=>{'use strict';
const btn=document.getElementById('bridgeCreate'),codeEl=document.getElementById('bridgeCode'),status=document.getElementById('bridgeStatus');
if(!btn||!codeEl||!status)return;
let ws=null,active=false;
const backend=(window.VF7_CONFIG?.BACKEND_URL||'').trim().replace(/\/$/,'');
const setStatus=t=>status.textContent=t;
const socketUrl=backend.replace(/^https:/,'wss:').replace(/^http:/,'ws:')+'/ws';
btn.addEventListener('click',()=>{
 if(!backend){setStatus('Cần cấu hình Render trong config.js');return;}
 if(ws){ws.close();ws=null;active=false;btn.textContent='TẠO MÃ GHÉP NỐI';codeEl.textContent='--------';setStatus('Đã ngắt');return;}
 try{
   setStatus('Đang kết nối…');ws=new WebSocket(socketUrl);
   const current=ws;
   current.onopen=()=>{current.send(JSON.stringify({type:'host.create'}));};
   current.onmessage=e=>{
     if(current!==ws)return;
     let m;try{m=JSON.parse(e.data);}catch{return;}
     if(m.type==='host.created'){active=true;codeEl.textContent=m.code;btn.textContent='NGẮT GHÉP NỐI';setStatus('Chờ iPhone · mã 15 phút');}
     else if(m.type==='phone.online')setStatus('● iPhone đã ghép nối');
     else if(m.type==='phone.offline')setStatus('iPhone ngắt kết nối');
     else if(m.type==='gps'){window.__vf7ReceiveRemoteGPS?.(m);setStatus('● Đang nhận GPS iPhone');}
     else if(m.type==='error')setStatus(m.message);
   };
   current.onclose=()=>{if(current!==ws)return;ws=null;active=false;codeEl.textContent='--------';btn.textContent='TẠO MÃ GHÉP NỐI';setStatus('Mất kết nối Render');};
   current.onerror=()=>setStatus('Không kết nối được Render');
 }catch(e){setStatus('Lỗi: '+e.message);ws=null;}
});
})();

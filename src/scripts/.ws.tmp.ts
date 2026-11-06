import './quiet.js';
import WebSocket from 'ws';
function probe(url: string, label: string) {
  return new Promise<void>((res) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => { console.log(`${label}: TIMEOUT`); ws.terminate(); res(); }, 12000);
    ws.on('open', () => { clearTimeout(t); console.log(`${label}: OPEN`); ws.close(); res(); });
    ws.on('unexpected-response', (_q, r) => { clearTimeout(t); console.log(`${label}: HTTP ${r.statusCode}`); res(); });
    ws.on('error', (e) => { clearTimeout(t); console.log(`${label}: ${String(e).split('\n')[0]}`); res(); });
  });
}
await probe('ws://localhost:3000/twilio?callId=bogus', 'local ');
await probe('wss://eshanlocaltunnel.billionagi.com/twilio?callId=bogus', 'tunnel');

//
// -----------------------------------------------------------------
// 🚀 VLESS Proxy Worker - Professionally Enhanced & Refactored 🚀
// -----------------------------------------------------------------
// This version includes:
//   - D1 Database for persistent user management.
//   - KV Caching for high-performance user authentication.
//   - A secure, built-in Admin Panel to manage users.
//   - A server-side API endpoint for fast, reliable network info.
//   - Modern, stream-based WebSocket and TCP handling.
//   - Clean, robust, and error-handled code structure.
//

import { connect } from 'cloudflare:sockets';

// --- CONFIGURATION ---
const Config = {
  // This is a fallback proxy. It's recommended to set the PROXYIP
  // environment variable in your Worker's settings for production.
  proxyIPs: ['nima.nscl.ir:443'],
  
  // Scamalytics API configuration (public key by default)
  scamalytics: {
    username: 'revilseptember',
    apiKey: 'b2fc368184deb3d8ac914bd776b8215fe899dd8fef69fbaba77511acfbdeca0d',
    baseUrl: 'https://api12.scamalytics.com/v3/',
  },

  /**
   * @param {{ PROXYIP: string; SCAMALYTICS_USERNAME: any; SCAMALYTICS_API_KEY: any; SCAMALYTICS_BASEURL: any; }} env
   */
  fromEnv(env) {
    const selectedProxyIP = env.PROXYIP || this.proxyIPs[Math.floor(Math.random() * this.proxyIPs.length)];
    const [proxyHost, proxyPort = '443'] = selectedProxyIP.split(':');
    return {
      proxyAddress: selectedProxyIP,
      proxyIP: proxyHost,
      proxyPort: parseInt(proxyPort, 10),
      scamalytics: {
        username: env.SCAMALYTICS_USERNAME || this.scamalytics.username,
        apiKey: env.SCAMALYTICS_API_KEY || this.scamalytics.apiKey,
        baseUrl: env.SCAMALYTICS_BASEURL || this.scamalytics.baseUrl,
      },
    };
  },
};

const CONST = {
  WS_READY_STATE_OPEN: 1,
  WS_READY_STATE_CLOSING: 2,
};

// --- MAIN FETCH HANDLER ---
export default {
  /**
   * @param {Request} request
   * @param {{DB: D1Database, KV: KVNamespace, ADMIN_KEY: string, PROXYIP: string}} env
   * @param {ExecutionContext} ctx
   */
  async fetch(request, env, ctx) {
    try {
      if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
        return handleWebSocket(request, env, ctx);
      }

      const url = new URL(request.url);
      const cfg = Config.fromEnv(env);

      if (url.pathname === '/api/network-info') {
        return handleNetworkInfo(request, cfg);
      }

      // Check for required bindings for all HTTP routes
      if (!env.DB || !env.KV) {
        return new Response('Service Unavailable: D1 Database or KV Namespace binding is not configured.', { status: 503 });
      }
      if (!env.ADMIN_KEY) {
        console.error('CRITICAL SECURITY WARNING: ADMIN_KEY secret is not set in environment variables.');
      }
      
      if (url.pathname.startsWith('/admin')) {
        return handleAdminRoutes(request, env);
      }
      
      const pathParts = url.pathname.slice(1).split('/');
      let userID;

      if ((pathParts[0] === 'xray' || pathParts[0] === 'sb') && pathParts.length > 1) {
        userID = pathParts[1];
        if (await isValidUser(userID, env, ctx)) {
          return handleIpSubscription(pathParts[0], userID, url.hostname);
        }
      } else if (pathParts.length === 1 && isValidUUID(pathParts[0])) {
        userID = pathParts[0];
      }
      
      if (userID && await isValidUser(userID, env, ctx)) {
        return handleConfigPage(userID, url.hostname, cfg.proxyAddress);
      }
      
      return new Response('Not Found. The requested URL or user ID is invalid.', { status: 404 });
    } catch (err) {
      console.error('Unhandled Exception in Fetch Handler:', err);
      return new Response('Internal Server Error', { status: 500 });
    }
  },
};

// --- SERVER-SIDE API FOR NETWORK INFO ---
async function handleNetworkInfo(request, config) {
    const clientIp = request.headers.get('CF-Connecting-IP');
    const proxyHost = config.proxyIP;

    const getIpDetails = async (ip) => {
        if (!ip) return null;
        try {
            const response = await fetch(`https://ipinfo.io/${ip}/json`);
            if (!response.ok) throw new Error(`ipinfo.io status: ${response.status}`);
            const data = await response.json();
            return {
                ip: data.ip,
                city: data.city,
                country: data.country, // Country code
                isp: data.org,
            };
        } catch (error) {
            console.error(`Failed to fetch details for IP ${ip}:`, error);
            return { ip }; // Return at least the IP on failure
        }
    };

    const getScamalyticsDetails = async (ip) => {
        if (!ip || !config.scamalytics.apiKey || !config.scamalytics.username) return null;
        try {
            const url = `${config.scamalytics.baseUrl}${config.scamalytics.username}/?key=${config.scamalytics.apiKey}&ip=${ip}`;
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Scamalytics status: ${response.status}`);
            const data = await response.json();
            return (data.status === 'ok') ? { score: data.score, risk: data.risk } : null;
        } catch (error) {
            console.error(`Failed to fetch Scamalytics for IP ${ip}:`, error);
            return null;
        }
    };
    
    const [clientDetails, proxyDetails, scamalyticsData] = await Promise.all([
        getIpDetails(clientIp),
        getIpDetails(proxyHost),
        getScamalyticsDetails(clientIp)
    ]);
    
    const responseData = {
        client: { ...clientDetails, risk: scamalyticsData },
        proxy: { host: config.proxyAddress, ...proxyDetails }
    };
    
    return new Response(JSON.stringify(responseData), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
}

// --- WEBSOCKET & VLESS PROXY LOGIC ---
async function handleWebSocket(request, env, ctx) {
  const webSocketPair = new WebSocketPair();
  const [client, webSocket] = Object.values(webSocketPair);
  webSocket.accept();

  const log = (info, event) => console.log(`[WS] ${info}`, event || '');
  const earlyDataHeader = request.headers.get('Sec-WebSocket-Protocol') || '';
  const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, log);
  
  let remoteSocketWrapper = { value: null };
  let isHeaderProcessed = false;

  readableWebSocketStream.pipeTo(new WritableStream({
    async write(chunk) {
      if (isHeaderProcessed && remoteSocketWrapper.value) {
        const writer = remoteSocketWrapper.value.writable.getWriter();
        try {
          await writer.write(chunk);
        } finally {
          writer.releaseLock();
        }
        return;
      }

      const { hasError, message, addressRemote, portRemote, rawDataIndex, ProtocolVersion, isUDP } = await processVlessHeader(chunk, env, ctx);

      if (hasError) {
        log(`VLESS Header Error: ${message}`);
        safeCloseWebSocket(webSocket, 1003, message);
        throw new Error(message);
      }
      if (isUDP) {
        const err = 'UDP proxying is not supported.';
        log(err);
        safeCloseWebSocket(webSocket, 1003, err);
        throw new Error(err);
      }
      
      const initialClientData = chunk.slice(rawDataIndex);
      const vlessResponseHeader = new Uint8Array([ProtocolVersion[0], 0]);
      
      const remoteSocket = await handleTCPOutbound({ addressRemote, portRemote, vlessResponseHeader, initialClientData, webSocket, log });

      if (!remoteSocket) {
        throw new Error('Failed to establish remote connection.');
      }
      
      remoteSocketWrapper.value = remoteSocket;
      isHeaderProcessed = true;

      // Pipe remote socket back to the WebSocket
      await remoteSocket.readable.pipeTo(new WritableStream({
          write(data) {
            if (webSocket.readyState === CONST.WS_READY_STATE_OPEN) {
              webSocket.send(data);
            }
          },
        }))
        .catch(err => log('Error piping remote to WebSocket:', err));
    },
    close: () => log('Client WebSocket stream closed.'),
    abort: (err) => log('Client WebSocket stream aborted:', err),
  }))
  .catch(err => {
    log('WebSocket pipeline failed:', err);
    if (remoteSocketWrapper.value) {
      remoteSocketWrapper.value.close();
    }
    safeCloseWebSocket(webSocket);
  });

  return new Response(null, { status: 101, webSocket: client });
}

async function handleTCPOutbound({ addressRemote, portRemote, vlessResponseHeader, initialClientData, webSocket, log }) {
  try {
    const remoteLog = (msg, ev) => console.log(`[${addressRemote}:${portRemote}] ${msg}`, ev || '');
    remoteLog('Connecting to destination...');
    const remoteSocket = await connect({ hostname: addressRemote, port: portRemote });
    remoteLog('Connection successful.');

    if (webSocket.readyState === CONST.WS_READY_STATE_OPEN) {
      webSocket.send(vlessResponseHeader);
    }

    const writer = remoteSocket.writable.getWriter();
    await writer.write(initialClientData);
    writer.releaseLock();

    return remoteSocket;
  } catch (error) {
    log(`Connection to ${addressRemote}:${portRemote} failed`, error);
    safeCloseWebSocket(webSocket, 1011, `Proxy connection failed`);
    return null;
  }
}

async function processVlessHeader(vlessBuffer, env, ctx) {
  if (vlessBuffer.byteLength < 24) return { hasError: true, message: 'Invalid VLESS header: too short' };
  
  const dataView = new DataView(vlessBuffer);
  const version = dataView.getUint8(0);
  const uuid = stringify(new Uint8Array(vlessBuffer.slice(1, 17)));

  if (!await isValidUser(uuid, env, ctx)) return { hasError: true, message: 'Invalid user' };

  const optLength = dataView.getUint8(17);
  const command = dataView.getUint8(18 + optLength);
  const portIndex = 18 + optLength + 1;
  const portRemote = dataView.getUint16(portIndex);
  const addressType = dataView.getUint8(portIndex + 2);

  let addressRemote, rawDataIndex;
  try {
    switch (addressType) {
      case 1: // IPv4
        addressRemote = new Uint8Array(vlessBuffer.slice(portIndex + 3, portIndex + 7)).join('.');
        rawDataIndex = portIndex + 7;
        break;
      case 2: // Domain
        const addressLength = dataView.getUint8(portIndex + 3);
        addressRemote = new TextDecoder().decode(vlessBuffer.slice(portIndex + 4, portIndex + 4 + addressLength));
        rawDataIndex = portIndex + 4 + addressLength;
        break;
      case 3: // IPv6
        const ipv6Bytes = new Uint8Array(vlessBuffer.slice(portIndex + 3, portIndex + 19));
        addressRemote = Array.from({ length: 8 }, (_, i) => ipv6Bytes.slice(i * 2, i * 2 + 2).reduce((acc, val) => (acc << 8) + val, 0).toString(16)).join(':');
        rawDataIndex = portIndex + 19;
        break;
      default:
        return { hasError: true, message: `Invalid addressType: ${addressType}` };
    }
  } catch (err) {
    return { hasError: true, message: `Failed to parse address: ${err.message}` };
  }

  return {
    hasError: false, addressRemote, portRemote, rawDataIndex,
    ProtocolVersion: new Uint8Array([version]), isUDP: command === 2,
  };
}


// --- USER AUTHENTICATION & UTILITIES ---
const isValidUUID = (uuid) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid);

async function isValidUser(userID, env, ctx) {
    if (!isValidUUID(userID)) return false;

    const cacheKey = `user:${userID}`;
    const cachedStatus = await env.KV.get(cacheKey);
    if (cachedStatus === 'valid') return true;
    if (cachedStatus === 'invalid') return false;

    try {
        const now = Math.floor(Date.now() / 1000);
        const stmt = env.DB.prepare('SELECT expiration_timestamp, status FROM users WHERE id = ?');
        const user = await stmt.bind(userID).first();
        
        if (!user || user.expiration_timestamp < now || user.status !== 'active') {
            await env.KV.put(cacheKey, 'invalid', { expirationTtl: 3600 }); // Cache invalid status for 1 hour
            return false;
        }

        // Defer non-critical DB write
        ctx.waitUntil(env.DB.prepare('UPDATE users SET last_accessed = ? WHERE id = ?').bind(now, userID).run());
        
        // Cache valid status until the user's expiration time
        await env.KV.put(cacheKey, 'valid', { expiration: user.expiration_timestamp });
        return true;
    } catch (e) {
        console.error('D1 query failed in isValidUser:', e);
        // Fail open or closed? For security, fail closed.
        return false;
    }
}

function makeReadableWebSocketStream(webSocket, earlyDataHeader, log) {
  let readableStreamCancel = false;
  return new ReadableStream({
    start(controller) {
      webSocket.addEventListener('message', (event) => {
        if (readableStreamCancel) return;
        controller.enqueue(event.data);
      });
      webSocket.addEventListener('close', () => {
        if (readableStreamCancel) return;
        controller.close();
      });
      webSocket.addEventListener('error', (err) => {
        if (readableStreamCancel) return;
        log('WebSocket error', err);
        controller.error(err);
      });
      const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
      if (error) {
        controller.error(error);
      } else if (earlyData) {
        controller.enqueue(earlyData);
      }
    },
    pull() {},
    cancel(reason) {
      log(`ReadableStream cancelled`, reason);
      readableStreamCancel = true;
      safeCloseWebSocket(webSocket);
    },
  });
}

function safeCloseWebSocket(socket, code, reason) {
  try {
    if (socket.readyState === CONST.WS_READY_STATE_OPEN || socket.readyState === CONST.WS_READY_STATE_CLOSING) {
      socket.close(code, reason);
    }
  } catch (error) { console.error('safeCloseWebSocket error:', error); }
}

const byteToHex = Array.from({ length: 256 }, (_, i) => (i + 0x100).toString(16).slice(1));
function stringify(arr) {
  const uuid = (
    byteToHex[arr[0]]+byteToHex[arr[1]]+byteToHex[arr[2]]+byteToHex[arr[3]]+'-'+
    byteToHex[arr[4]]+byteToHex[arr[5]]+'-'+
    byteToHex[arr[6]]+byteToHex[arr[7]]+'-'+
    byteToHex[arr[8]]+byteToHex[arr[9]]+'-'+
    byteToHex[arr[10]]+byteToHex[arr[11]]+byteToHex[arr[12]]+byteToHex[arr[13]]+byteToHex[arr[14]]+byteToHex[arr[15]]
  ).toLowerCase();
  if (!isValidUUID(uuid)) throw new TypeError('Stringified UUID is invalid');
  return uuid;
}

function base64ToArrayBuffer(base64Str) {
    if (!base64Str) return { earlyData: null, error: null };
    try {
        const binaryStr = atob(base64Str.replace(/-/g, '+').replace(/_/g, '/'));
        const buffer = new ArrayBuffer(binaryStr.length);
        const view = new Uint8Array(buffer);
        for (let i = 0; i < binaryStr.length; i++) view[i] = binaryStr.charCodeAt(i);
        return { earlyData: buffer, error: null };
    } catch (error) { return { earlyData: null, error }; }
}

// --- SUBSCRIPTION & CONFIG LINK GENERATION ---
function generateRandomPath(length = 12, query = '') {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return `/${result}${query ? `?${query}` : ''}`;
}

const CORE_PRESETS = {
  xray: {
    tls: { path: () => generateRandomPath(12, 'ed=2048'), security: 'tls', fp: 'chrome', alpn: 'http/1.1', extra: {} },
    tcp: { path: () => generateRandomPath(12, 'ed=2048'), security: 'none', fp: 'chrome', extra: {} },
  },
  sb: {
    tls: { path: () => generateRandomPath(18), security: 'tls', fp: 'firefox', alpn: 'h3', extra: {ed: 2560} },
    tcp: { path: () => generateRandomPath(18), security: 'none', fp: 'firefox', extra: {ed: 2560} },
  },
};

function makeName(tag, proto) { return `${tag}-${proto.toUpperCase()}`; }

function createVlessLink({ userID, address, port, host, path, security, sni, fp, alpn, extra = {}, name }) {
  const params = new URLSearchParams({ type: 'ws', host, path });
  if (security) params.set('security', security);
  if (sni) params.set('sni', sni);
  if (fp) params.set('fp', fp);
  if (alpn) params.set('alpn', alpn);
  for (const [k, v] of Object.entries(extra)) params.set(k, v);
  return `vless://${userID}@${address}:${port}?${params.toString()}#${encodeURIComponent(name)}`;
}

function buildLink({ core, proto, userID, hostName, address, port, tag }) {
  const p = CORE_PRESETS[core][proto];
  return createVlessLink({
    userID, address, port, host: hostName, path: p.path(), security: p.security,
    sni: p.security === 'tls' ? hostName : undefined, fp: p.fp, alpn: p.alpn, extra: p.extra, name: makeName(tag, proto),
  });
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function handleIpSubscription(core, userID, hostName) {
  const mainDomains = [
    hostName, 'creativecommons.org', 'www.speedtest.net',
    'sky.rethinkdns.com', 'cf.090227.xyz', 'cdnjs.com', 'zula.ir',
    'cfip.1323123.xyz', 'go.inmobi.com', 'singapore.com', 'www.visa.com',
  ];
  const httpsPorts = [443, 8443, 2053, 2083, 2087, 2096];
  const httpPorts = [80, 8080, 8880, 2052, 2082, 2086, 2095];
  let links = [];
  const isPagesDeployment = hostName.endsWith('.pages.dev');

  mainDomains.forEach((domain, i) => {
    links.push(buildLink({ core, proto: 'tls', userID, hostName, address: domain, port: pick(httpsPorts), tag: `D${i + 1}` }));
    if (!isPagesDeployment) {
      links.push(buildLink({ core, proto: 'tcp', userID, hostName, address: domain, port: pick(httpPorts), tag: `D${i + 1}` }));
    }
  });

  try {
    const r = await fetch('https://raw.githubusercontent.com/NiREvil/vless/main/sub/Cloudflare-IPs.json');
    if (r.ok) {
      const { ipv4 = [], ipv6 = [] } = await r.json();
      const ips = [...ipv4, ...ipv6].slice(0, 20).map(x => x.ip);
      ips.forEach((ip, i) => {
        const formattedAddress = ip.includes(':') ? `[${ip}]` : ip;
        links.push(buildLink({ core, proto: 'tls', userID, hostName, address: formattedAddress, port: pick(httpsPorts), tag: `IP${i + 1}` }));
        if (!isPagesDeployment) {
          links.push(buildLink({ core, proto: 'tcp', userID, hostName, address: formattedAddress, port: pick(httpPorts), tag: `IP${i + 1}` }));
        }
      });
    }
  } catch (e) { console.error('Failed to fetch IP list:', e); }

  return new Response(btoa(links.join('\n')), { headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
}

// --- ADMIN PANEL API & UI ---
async function handleAdminRoutes(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace('/admin', '');

  if (request.method === 'GET' && (path === '/login' || path === '' || path === '/')) {
    return new Response(getAdminLoginHTML(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  if (request.method === 'GET' && path === '/dashboard') {
    return new Response(getAdminDashboardHTML(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  // API calls require authorization
  const authKey = request.headers.get('Authorization');
  if (authKey !== env.ADMIN_KEY) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    if (request.method === 'POST' && path === '/api/users') {
      const body = await request.json();
      const { id, expiration_date, expiration_time, notes = '' } = body;
      if (!id || !expiration_date || !expiration_time || !isValidUUID(id)) {
        return Response.json({ error: 'Missing or invalid parameters' }, { status: 400 });
      }
      const expirationTimestamp = Math.floor(new Date(`${expiration_date}T${expiration_time}:00Z`).getTime() / 1000);
      const now = Math.floor(Date.now() / 1000);

      await env.DB.prepare(
        'INSERT INTO users (id, expiration_timestamp, created_at, last_accessed, status, notes, admin_key) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(id, expirationTimestamp, now, now, 'active', notes || null, authKey).run();
      await env.KV.delete(`user:${id}`); // Invalidate cache
      return Response.json({ success: true });
    }

    if (request.method === 'GET' && path === '/api/users') {
      const { results } = await env.DB.prepare('SELECT id, expiration_timestamp, created_at, last_accessed, status, notes FROM users ORDER BY created_at DESC').all();
      return Response.json(results);
    }

    if (request.method === 'DELETE' && path.startsWith('/api/users/')) {
      const id = path.substring('/api/users/'.length);
      if (!isValidUUID(id)) return Response.json({ error: 'Invalid UUID format' }, { status: 400 });
      await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
      await env.KV.delete(`user:${id}`); // Invalidate cache
      return Response.json({ success: true });
    }
  } catch (e) {
    console.error('Admin API Error:', e);
    return Response.json({ error: `An internal server error occurred: ${e.message}` }, { status: 500 });
  }

  return new Response('Admin endpoint not found', { status: 404 });
}


// --- HTML PAGE GENERATION ---
function handleConfigPage(userID, hostName, proxyAddress) {
  const html = generateBeautifulConfigPage(userID, hostName, proxyAddress);
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function generateBeautifulConfigPage(userID, hostName, proxyAddress) {
  const dream = buildLink({ core: 'xray', proto: 'tls', userID, hostName, address: hostName, port: 443, tag: `${hostName}-Xray` });
  const freedom = buildLink({ core: 'sb', proto: 'tls', userID, hostName, address: hostName, port: 443, tag: `${hostName}-Singbox` });
  const configs = { dream, freedom };
  const subXrayUrl = `https://${hostName}/xray/${userID}`;
  const subSbUrl = `https://${hostName}/sb/${userID}`;
  const clientUrls = {
    clashMeta: `clash://install-config?url=${encodeURIComponent(`https://sub.bonds.dev/sub/clash-meta?url=${subSbUrl}&udp=true`)}`,
    hiddify: `hiddify://install-config?url=${encodeURIComponent(subXrayUrl)}`,
    v2rayng: `v2rayng://install-config?url=${encodeURIComponent(subXrayUrl)}`,
    exclave: `sn://subscription?url=${encodeURIComponent(subSbUrl)}`,
  };
  return `
  <!doctype html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>VLESS Proxy Configuration</title><link rel="icon" href="https://raw.githubusercontent.com/NiREvil/zizifn/main/assets/favicon.png" type="image/png"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@300..700&display=swap" rel="stylesheet"><style>${getPageCSS()}</style></head><body data-proxy-ip="${proxyAddress}">${getPageHTML(configs, clientUrls)}<script>${getPageScript()}</script></body></html>`;
}

function getAdminLoginHTML() {
  return `<!DOCTYPE html><html><head><title>Admin Login</title><style>body,html{height:100%;margin:0;font-family:sans-serif;background:#1a1a1a;color:white;display:flex;align-items:center;justify-content:center;} .login-box{background:#2a2a2a;padding:2rem;border-radius:8px;text-align:center;box-shadow:0 0 15px rgba(0,0,0,0.5);} h2{margin-top:0;} input{width:100%;padding:10px;margin-top:1rem;box-sizing:border-box;background:#333;border:1px solid #444;border-radius:5px;color:white;} button{width:100%;padding:10px;margin-top:1rem;background:#007bff;border:none;border-radius:5px;color:white;cursor:pointer;font-size:1rem;} .error{color:#ff5252;margin-top:1rem;height:1em;}</style></head><body><div class="login-box"><h2>Admin Login</h2><input type="password" id="admin-key" placeholder="Enter Admin Key"><button onclick="login()">Login</button><p id="error-message" class="error"></p></div><script>
    async function login(){const key=document.getElementById('admin-key').value.trim();const err=document.getElementById('error-message');err.textContent='';if(!key)return err.textContent='Key cannot be empty.';try{const res=await fetch('/admin/api/users',{headers:{'Authorization':key}});if(res.ok){localStorage.setItem('admin_key',key);window.location.href='/admin/dashboard';}else if(res.status===401){err.textContent='Invalid Key. Access Denied.';}else{err.textContent='An unknown error occurred.';}}catch(e){err.textContent='Failed to connect to the server.';}}
    document.getElementById('admin-key').addEventListener('keyup',e=>{if(e.key==='Enter')login();});
  </script></body></html>`;
}

function getAdminDashboardHTML() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Admin Dashboard</title><style>body,html{margin:0;font-family:sans-serif;background:#1a1a1a;color:#f0f0f0;} .dashboard{max-width:1000px;margin:2rem auto;padding:2rem;background:#2a2a2a;border-radius:15px;} h1,h2{text-align:center;color:#00aaff;} .create-section{background:#333;padding:1.5rem;border-radius:10px;margin-bottom:2rem;display:grid;grid-template-columns:1fr auto 1fr 1fr 1fr auto;gap:10px;align-items:center;} input,button{padding:10px;border:none;border-radius:5px;background:#444;color:#fff;} button{background:#007bff;cursor:pointer;} table{width:100%;border-collapse:collapse;margin-top:1rem;} th,td{padding:12px 15px;text-align:left;border-bottom:1px solid #444;word-break:break-all;} th{background:#333;} .expired{color:#ff5252;}.notes{max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}</style></head><body><div class="dashboard"><h1>Admin Dashboard</h1><div class="create-section"><input type="text" id="new-id" placeholder="User ID (UUID)"><button onclick="generateUUID()">Generate</button><input type="date" id="exp-date"><input type="time" id="exp-time"><input type="text" id="notes" placeholder="Notes (Optional)"><button onclick="createUser()">Create User</button></div><div class="user-list"><h2>User List</h2><table id="user-table"><thead><tr><th>ID</th><th>Expiry</th><th>Created</th><th>Status</th><th>Notes</th><th>Actions</th></tr></thead><tbody><tr><td colspan="6" style="text-align:center;">Loading...</td></tr></tbody></table></div></div><script>
    const adminKey = localStorage.getItem('admin_key'); if(!adminKey)window.location.href='/admin/login';
    const apiHeaders={'Content-Type':'application/json','Authorization':adminKey};
    async function apiFetch(endpoint,options={}){const res=await fetch('/admin/api'+endpoint,{...options,headers:apiHeaders});if(res.status===401){alert('Unauthorized!');window.location.href='/admin/login';}return res;}
    function generateUUID(){document.getElementById('new-id').value=crypto.randomUUID();}
    async function createUser(){const id=document.getElementById('new-id').value;const date=document.getElementById('exp-date').value;const time=document.getElementById('exp-time').value;const notes=document.getElementById('notes').value;if(!id||!date||!time)return alert('Please fill all required fields.');const res=await apiFetch('/users',{method:'POST',body:JSON.stringify({id,expiration_date:date,expiration_time:time,notes})});if(res.ok){alert('User created successfully!');loadUsers();generateUUID();document.getElementById('notes').value='';}else{const err=await res.json();alert('Error: '+(err.error||'Unknown error'));}}
    async function loadUsers(){const res=await apiFetch('/users');const users=await res.json();const tbody=document.getElementById('user-table').querySelector('tbody');tbody.innerHTML='';const now=Date.now()/1000;users.forEach(u=>{const expiry=new Date(u.expiration_timestamp*1000).toLocaleString();const created=new Date(u.created_at*1000).toLocaleDateString();const isExpired=u.expiration_timestamp<now;const statusClass=isExpired||u.status!=='active'?'expired':'';const statusText=isExpired?'Expired':u.status;tbody.innerHTML+=\`<tr><td>\${u.id}</td><td class="\${statusClass}">\${expiry}</td><td>\${created}</td><td class="\${statusClass}">\${statusText}</td><td class="notes" title="\${u.notes||''}">\${u.notes||''}</td><td><button onclick="deleteUser('\${u.id}')">Delete</button></td></tr>\`;});}
    async function deleteUser(id){if(!confirm('Are you sure you want to delete this user?'))return;const res=await apiFetch(\`/users/\${id}\`,{method:'DELETE'});if(res.ok){alert('User deleted!');loadUsers();}else{alert('Error deleting user.');}}
    window.onload=()=>{generateUUID();loadUsers();};
  </script></body></html>`;
}

function getPageCSS() {
  return `
      * { margin: 0; padding: 0; box-sizing: border-box; }
      @font-face {
	      font-family: "Aldine 401 BT Web";
	      src: url("https://pub-7a3b428c76aa411181a0f4dd7fa9064b.r2.dev/Aldine401_Mersedeh.woff2") format("woff2");
	      font-weight: 400; font-style: normal; font-display: swap;
	    }
	    @font-face {
	      font-family: "Styrene B LC";
	      src: url("https://pub-7a3b428c76aa411181a0f4dd7fa9064b.r2.dev/StyreneBLC-Regular.woff2") format("woff2");
	      font-weight: 400; font-style: normal; font-display: swap;
	    }
	    @font-face {
	      font-family: "Styrene B LC";
	      src: url("https://pub-7a3b428c76aa411181a0f4dd7fa9064b.r2.dev/StyreneBLC-Medium.woff2") format("woff2");
	      font-weight: 500; font-style: normal; font-display: swap;
	    }
      :root {
        --background-primary: #2a2421; --background-secondary: #35302c; --background-tertiary: #413b35;
        --border-color: #5a4f45; --border-color-hover: #766a5f; --text-primary: #e5dfd6; --text-secondary: #b3a89d;
        --text-accent: #ffffff; --accent-primary: #be9b7b; --accent-secondary: #d4b595; --accent-tertiary: #8d6e5c;
        --accent-primary-darker: #8a6f56; --button-text-primary: #2a2421; --button-text-secondary: var(--text-primary);
        --shadow-color: rgba(0, 0, 0, 0.35); --shadow-color-accent: rgba(190, 155, 123, 0.4);
        --border-radius: 8px; --transition-speed: 0.2s; --transition-speed-fast: 0.1s; --transition-speed-medium: 0.3s; --transition-speed-long: 0.6s;
        --status-success: #70b570; --status-error: #e05d44; --status-warning: #e0bc44; --status-info: #4f90c4;
        --serif: "Aldine 401 BT Web", "Times New Roman", Times, Georgia, ui-serif, serif;
	      --sans-serif: "Styrene B LC", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, "Noto Color Emoji", sans-serif;
	      --mono-serif: "Fira Code", Cantarell, "Courier Prime", monospace;
	    }
      body {
        font-family: var(--sans-serif); font-size: 16px; font-weight: 400; font-style: normal;
        background-color: var(--background-primary); color: var(--text-primary);
        padding: 3rem; line-height: 1.5; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
      }
      .container { max-width: 800px; margin: 20px auto; padding: 0 12px; border-radius: var(--border-radius); box-shadow: 0 6px 15px rgba(0, 0, 0, 0.2), 0 0 25px 8px var(--shadow-color-accent); transition: box-shadow var(--transition-speed-medium) ease; }
      .container:hover { box-shadow: 0 8px 20px rgba(0, 0, 0, 0.25), 0 0 35px 10px var(--shadow-color-accent); }
      .header { text-align: center; margin-bottom: 40px; padding-top: 30px; }
      .header h1 { font-family: var(--serif); font-weight: 400; font-size: 1.8rem; color: var(--text-accent); margin-bottom: 2px; }
      .header p { color: var(--text-secondary); font-size: 0.6rem; font-weight: 400; }
      .config-card { background: var(--background-secondary); border-radius: var(--border-radius); padding: 20px; margin-bottom: 24px; border: 1px solid var(--border-color); transition: border-color var(--transition-speed) ease, box-shadow var(--transition-speed) ease; }
      .config-card:hover { border-color: var(--border-color-hover); box-shadow: 0 4px 8px var(--shadow-color); }
      .config-title { font-family: var(--serif); font-size: 1.6rem; font-weight: 400; color: var(--accent-secondary); margin-bottom: 16px; padding-bottom: 13px; border-bottom: 1px solid var(--border-color); display: flex; align-items: center; justify-content: space-between; }
      .config-title .refresh-btn { position: relative; overflow: hidden; display: flex; align-items: center; gap: 4px; font-family: var(--serif); font-size: 12px; padding: 6px 12px; border-radius: 6px; color: var(--accent-secondary); background-color: var(--background-tertiary); border: 1px solid var(--border-color); cursor: pointer; transition: all var(--transition-speed) ease; }
      .config-title .refresh-btn::before { content: ''; position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: linear-gradient(120deg, transparent, rgba(255, 255, 255, 0.2), transparent); transform: translateX(-100%); transition: transform var(--transition-speed-long) ease; z-index: 1; }
      .config-title .refresh-btn:hover { letter-spacing: 0.5px; font-weight: 600; background-color: #4d453e; color: var(--accent-primary); border-color: var(--border-color-hover); transform: translateY(-2px); box-shadow: 0 4px 8px var(--shadow-color); }
      .config-title .refresh-btn:hover::before { transform: translateX(100%); }
      .refresh-icon { width: 12px; height: 12px; stroke: currentColor; }
      .config-content { position: relative; background: var(--background-tertiary); border-radius: var(--border-radius); padding: 16px; margin-bottom: 20px; border: 1px solid var(--border-color); }
      .config-content pre { overflow-x: auto; font-family: var(--mono-serif); font-size: 0.75rem; color: var(--text-primary); margin: 0; white-space: pre-wrap; word-break: break-all; }
      .button { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 8px 16px; border-radius: var(--border-radius); font-size: 15px; font-weight: 500; cursor: pointer; border: 1px solid var(--border-color); background-color: var(--background-tertiary); color: var(--button-text-secondary); transition: all var(--transition-speed) ease; text-decoration: none; }
      .copy-buttons { position: relative; display: flex; gap: 4px; overflow: hidden; align-self: center; font-family: var(--serif); font-size: 13px; padding: 6px 12px; border-radius: 6px; color: var(--accent-secondary); border: 1px solid var(--border-color); }
      .copy-buttons::before, .client-btn::before { content: ''; position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: linear-gradient(120deg, transparent, rgba(255, 255, 255, 0.2), transparent); transform: translateX(-100%); transition: transform var(--transition-speed-long) ease; z-index: -1; }
      .copy-buttons:hover::before, .client-btn:hover::before { transform: translateX(100%); }
      .copy-buttons:hover { background-color: #4d453e; letter-spacing: 0.5px; font-weight: 600; border-color: var(--border-color-hover); transform: translateY(-2px); box-shadow: 0 4px 8px var(--shadow-color); }
      .copy-icon { width: 12px; height: 12px; stroke: currentColor; }
      .client-buttons { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 12px; margin-top: 16px; }
      .client-btn { width: 100%; background-color: var(--accent-primary); color: var(--background-tertiary); border-radius: 6px; border-color: var(--accent-primary-darker); position: relative; overflow: hidden; transition: all 0.3s cubic-bezier(0.2, 0.8, 0.2, 1); box-shadow: 0 2px 5px rgba(0, 0, 0, 0.15); }
      .client-btn:hover { text-transform: uppercase; letter-spacing: 0.3px; transform: translateY(-3px); background-color: var(--accent-secondary); color: var(--button-text-primary); box-shadow: 0 5px 15px rgba(190, 155, 123, 0.5); border-color: var(--accent-secondary); }
	    .client-icon { width: 18px; height: 18px; border-radius: 6px; background-color: var(--background-secondary); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
	    .client-icon svg { width: 14px; height: 14px; fill: var(--accent-secondary); }
	    .button.copied { background-color: var(--accent-secondary) !important; color: var(--background-tertiary) !important; }
	    .footer { text-align: center; margin-top: 20px; padding-bottom: 40px; color: var(--text-secondary); font-size: 0.7rem; }
	    .ip-info-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 24px; }
	    .ip-info-section { background-color: var(--background-tertiary); border-radius: var(--border-radius); padding: 16px; border: 1px solid var(--border-color); display: flex; flex-direction: column; gap: 20px; }
	    .ip-info-header { display: flex; align-items: center; gap: 10px; border-bottom: 1px solid var(--border-color); padding-bottom: 10px; }
	    .ip-info-header svg { width: 20px; height: 20px; stroke: var(--accent-secondary); }
	    .ip-info-header h3 { font-family: var(--serif); font-size: 18px; font-weight: 400; color: var(--accent-secondary); margin: 0; }
	    .ip-info-content { display: flex; flex-direction: column; gap: 10px; }
	    .ip-info-item { display: flex; flex-direction: column; gap: 2px; }
	    .ip-info-item .label { font-size: 11px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px; }
	    .ip-info-item .value { font-size: 14px; color: var(--text-primary); word-break: break-all; line-height: 1.4; }
	    .badge { display: inline-flex; align-items: center; justify-content: center; padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px; }
	    .badge-yes { background-color: rgba(112, 181, 112, 0.15); color: var(--status-success); border: 1px solid rgba(112, 181, 112, 0.3); }
	    .badge-no { background-color: rgba(224, 93, 68, 0.15); color: var(--status-error); border: 1px solid rgba(224, 93, 68, 0.3); }
	    .badge-neutral { background-color: rgba(79, 144, 196, 0.15); color: var(--status-info); border: 1px solid rgba(79, 144, 196, 0.3); }
	    .badge-warning { background-color: rgba(224, 188, 68, 0.15); color: var(--status-warning); border: 1px solid rgba(224, 188, 68, 0.3); }
	    .skeleton { display: block; background: linear-gradient(90deg, var(--background-tertiary) 25%, var(--background-secondary) 50%, var(--background-tertiary) 75%); background-size: 200% 100%; animation: loading 1.5s infinite; border-radius: 4px; height: 16px; }
	    @keyframes loading { to { background-position: -200% 0; } }
	    .country-flag { display: inline-block; width: 18px; height: auto; max-height: 14px; margin-right: 6px; vertical-align: middle; border-radius: 2px; }
      @media (max-width: 768px) { body { padding: 20px; } .config-content pre { font-size: 0.6rem; } }
  `;
}

function getPageHTML(configs, clientUrls) {
  return `
    <div class="container">
      <div class="header"><h1>VLESS Proxy Configuration</h1><p>Copy the configuration or import directly into your client</p></div>
      <div class="config-card">
        <div class="config-title"><span>Network Information</span><button id="refresh-ip-info" class="refresh-btn" aria-label="Refresh IP information"><svg class="refresh-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" /></svg>Refresh</button></div>
        <div class="ip-info-grid">
          <div class="ip-info-section"><div class="ip-info-header"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2" /><line x1="12" y1="18" x2="12.01" y2="18" /></svg><h3>Proxy Server</h3></div><div class="ip-info-content"><div class="ip-info-item"><span class="label">Proxy Host</span><span class="value" id="proxy-host"><span class="skeleton" style="width: 150px"></span></span></div><div class="ip-info-item"><span class="label">IP Address</span><span class="value" id="proxy-ip"><span class="skeleton" style="width: 120px"></span></span></div><div class="ip-info-item"><span class="label">Location</span><span class="value" id="proxy-location"><span class="skeleton" style="width: 100px"></span></span></div><div class="ip-info-item"><span class="label">ISP Provider</span><span class="value" id="proxy-isp"><span class="skeleton" style="width: 140px"></span></span></div></div></div>
          <div class="ip-info-section"><div class="ip-info-header"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s-8-4.5-8-11.8A8 8 0 0 1 12 2a8 8 0 0 1 8 8.2c0 7.3-8 11.8-8 11.8z" /><circle cx="12" cy="10" r="3" /></svg><h3>Your Connection</h3></div><div class="ip-info-content"><div class="ip-info-item"><span class="label">Your IP</span><span class="value" id="client-ip"><span class="skeleton" style="width: 110px"></span></span></div><div class="ip-info-item"><span class="label">Location</span><span class="value" id="client-location"><span class="skeleton" style="width: 90px"></span></span></div><div class="ip-info-item"><span class="label">ISP Provider</span><span class="value" id="client-isp"><span class="skeleton" style="width: 130px"></span></span></div><div class="ip-info-item"><span class="label">Risk Score</span><span class="value" id="client-proxy"><span class="skeleton" style="width: 100px"></span></span></div></div></div>
        </div>
      </div>
      <div class="config-card"><div class="config-title"><span>Xray Core Clients</span><button class="button copy-buttons" onclick="copyToClipboard(this, '${configs.dream}')"><svg class="copy-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>Copy</button></div><div class="config-content"><pre>${configs.dream}</pre></div><div class="client-buttons"><a href="${clientUrls.hiddify}" class="button client-btn"><span class="client-icon"><svg viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" /></svg></span>Import to Hiddify</a><a href="${clientUrls.v2rayng}" class="button client-btn"><span class="client-icon"><svg viewBox="0 0 24 24"><path d="M12 2L4 5v6c0 5.5 3.5 10.7 8 12.3 4.5-1.6 8-6.8 8-12.3V5l-8-3z" /></svg></span>Import to V2rayNG</a></div></div>
      <div class="config-card"><div class="config-title"><span>Sing-Box Core Clients</span><button class="button copy-buttons" onclick="copyToClipboard(this, '${configs.freedom}')"><svg class="copy-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>Copy</button></div><div class="config-content"><pre>${configs.freedom}</pre></div><div class="client-buttons"><a href="${clientUrls.clashMeta}" class="button client-btn"><span class="client-icon"><svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" /></svg></span>Import to Clash Meta</a><a href="${clientUrls.exclave}" class="button client-btn"><span class="client-icon"><svg viewBox="0 0 24 24"><path d="M20,8h-3V6c0-1.1-0.9-2-2-2H9C7.9,4,7,4.9,7,6v2H4C2.9,8,2,8.9,2,10v9c0,1.1,0.9,2,2,2h16c1.1,0,2-0.9,2-2v-9 C22,8.9,21.1,8,20,8z M9,6h6v2H9V6z M20,19H4v-2h16V19z M20,15H4v-5h3v1c0,0.55,0.45,1,1,1h1.5c0.28,0,0.5-0.22,0.5-0.5v-0.5h4v0.5 c0,0.28,0.22,0.5,0.5,0.5H16c0.55,0,1-0.45,1-1v-1h3V15z" /></svg></span>Import to Exclave</a></div></div>
      <div class="footer"><p>© ${new Date().getFullYear()} REvil - All Rights Reserved</p></div>
    </div>
  `;
}

function getPageScript() {
  return `
      function copyToClipboard(button, text) {
        const originalHTML = button.innerHTML;
        navigator.clipboard.writeText(text).then(() => {
          button.innerHTML = \`<svg class="copy-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> Copied!\`;
          button.classList.add("copied");
          button.disabled = true;
          setTimeout(() => { button.innerHTML = originalHTML; button.classList.remove("copied"); button.disabled = false; }, 1200);
        }).catch(err => { console.error("Failed to copy text: ", err); });
      }

      function updateDisplay(data) {
        const na = 'N/A';
        const proxy = data.proxy || {};
        document.getElementById('proxy-host').textContent = proxy.host || na;
        document.getElementById('proxy-ip').textContent = proxy.ip || na;
        document.getElementById('proxy-isp').textContent = proxy.isp || na;
        const p_loc = [proxy.city, proxy.country].filter(Boolean).join(', ');
        const p_flag = proxy.country ? \`<img src="https://flagcdn.com/w20/\${proxy.country.toLowerCase()}.png" class="country-flag" alt="\${proxy.country}"> \` : '';
        document.getElementById('proxy-location').innerHTML = p_loc ? \`\${p_flag}\${p_loc}\` : na;

        const client = data.client || {};
        document.getElementById('client-ip').textContent = client.ip || na;
        document.getElementById('client-isp').textContent = client.isp || na;
        const c_loc = [client.city, client.country].filter(Boolean).join(', ');
        const c_flag = client.country ? \`<img src="https://flagcdn.com/w20/\${client.country.toLowerCase()}.png" class="country-flag" alt="\${client.country}"> \` : '';
        document.getElementById('client-location').innerHTML = c_loc ? \`\${c_flag}\${c_loc}\` : na;
        
        const risk = client.risk;
        let riskText = "Unknown", badgeClass = "badge-neutral";
        if (risk && risk.score !== undefined) {
            riskText = \`\${risk.score} - \${risk.risk.charAt(0).toUpperCase() + risk.risk.slice(1)}\`;
            const riskLevel = risk.risk.toLowerCase();
            if (riskLevel === "low") badgeClass = "badge-yes";
            else if (riskLevel === "medium") badgeClass = "badge-warning";
            else if (riskLevel === "high" || riskLevel === "very high") badgeClass = "badge-no";
        }
        document.getElementById('client-proxy').innerHTML = \`<span class="badge \${badgeClass}">\${riskText}</span>\`;
      }

      async function loadNetworkInfo() {
        try {
            const response = await fetch('/api/network-info');
            if (!response.ok) throw new Error(\`API request failed with status \${response.status}\`);
            const data = await response.json();
            updateDisplay(data);
        } catch (error) {
            console.error('Failed to load network info:', error);
            const errorData = { client: {}, proxy: { host: document.body.getAttribute('data-proxy-ip') || 'N/A' } };
            updateDisplay(errorData);
        }
      }

      document.getElementById('refresh-ip-info')?.addEventListener('click', function() {
        const button = this;
        const icon = button.querySelector('.refresh-icon');
        button.disabled = true;
        if (icon) icon.style.animation = 'spin 1s linear infinite';

        document.querySelectorAll('.ip-info-item .value').forEach(el => {
          el.innerHTML = \`<span class="skeleton" style="width: \${Math.random()*40+80}px;"></span>\`;
        });

        loadNetworkInfo().finally(() => setTimeout(() => {
          button.disabled = false; if (icon) icon.style.animation = '';
        }, 500));
      });

      const style = document.createElement('style');
      style.textContent = \`@keyframes spin { to { transform: rotate(360deg); } }\`;
      document.head.appendChild(style);

      document.addEventListener('DOMContentLoaded', loadNetworkInfo);
  `;
}

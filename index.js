// ----------------------------------------------------------------
// 🚀 VLESS Proxy Worker - Ultimate Smart Edition 🚀
// ----------------------------------------------------------------
// This script combines a VLESS proxy, an intelligent DoH handler,
// an admin panel, a network info API, and a server-side UI.
// It correctly handles TCP and UDP VLESS requests, fixing DNS resolution issues.
//

import { connect } from 'cloudflare:sockets';

// --- CONFIGURATION ---
// All settings are managed via Environment Variables in the Cloudflare dashboard.
const Config = {
  // Fallback/Relay server if PROXYIP is not set
  defaultProxyIPs: ['nima.nscl.ir:443'],

  // Default upstream DoH server if DOH_UPSTREAM_URL is not set
  defaultDoHUpstream: 'https://1.1.1.1/dns-query', // Using a standard DoH resolver

  // Scamalytics API default settings
  scamalytics: {
    username: 'revilseptember',
    apiKey: 'b2fc368184deb3d8ac914bd776b8215fe899dd8fef69fbaba77511acfbdeca0d',
    baseUrl: 'https://api12.scamalytics.com/v3/',
  },

  // This function reads settings from the environment variables (env)
  fromEnv(env) {
    const proxyIPs = env.PROXYIP ? env.PROXYIP.split(',').map(ip => ip.trim()) : this.defaultProxyIPs;
    const selectedProxyIP = proxyIPs[Math.floor(Math.random() * proxyIPs.length)];
    const [proxyHost, proxyPort = '443'] = selectedProxyIP.split(':');

    return {
      proxyAddress: selectedProxyIP,
      proxyIP: proxyHost,
      proxyPort: parseInt(proxyPort, 10),
      dohUpstreamUrl: env.DOH_UPSTREAM_URL || this.defaultDoHUpstream,
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
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const cfg = Config.fromEnv(env);

      // Route for WebSocket (VLESS) connections
      if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
        return handleWebSocket(request, env, ctx);
      }

      // Handle DNS-over-HTTPS requests
      if (url.pathname === '/dns-query' && (request.method === 'POST' || request.method === 'GET')) {
        return handleDnsQuery(request, cfg.dohUpstreamUrl);
      }

      // Route for the smart network info API
      if (url.pathname === '/api/network-info') {
        return handleNetworkInfo(request, cfg);
      }
      
      // Route for Scamalytics lookup from client-side
      if (url.pathname === '/scamalytics-lookup') {
        return handleScamalyticsLookup(request, cfg);
      }

      // Routes for Admin Panel, Subscriptions, etc.
      if (url.pathname.startsWith('/admin')) {
        if (!env.DB || !env.KV || !env.ADMIN_KEY) return new Response('Admin features are not configured on the server.', { status: 503 });
        return handleAdminRoutes(request, env);
      }

      const parts = url.pathname.slice(1).split('/');
      let userID;
      let core;

      if ((parts[0] === 'xray' || parts[0] === 'sb') && parts.length > 1) {
        core = parts[0];
        userID = parts[1];
      } else if (parts.length === 1 && isValidUUID(parts[0])) {
        userID = parts[0];
      }
      
      // If a UUID is found, decide whether to show the config page or subscription
      if(userID) {
        // Use database if available, otherwise assume UUID is valid for basic operation
        const userIsValid = (env.DB && env.KV) ? await isValidUser(userID, env, ctx) : true;

        if (userIsValid) {
          if (core) {
            return handleIpSubscription(core, userID, url.hostname);
          }
          return handleConfigPage(userID, url.hostname, cfg.proxyAddress);
        }
      }

      return new Response('404 Not Found. Please use your unique user ID in the URL.', { status: 404 });
    } catch (err) {
      console.error('Unhandled Exception:', err.stack || err);
      return new Response('Internal Server Error', { status: 500 });
    }
  },
};

// --- DNS-OVER-HTTPS (DoH) PROXY FUNCTION ---
async function handleDnsQuery(request, upstreamUrl) {
  const url = new URL(request.url);
  const upstreamWithQuery = new URL(upstreamUrl);
  upstreamWithQuery.search = url.search;

  const dohRequest = new Request(upstreamWithQuery, {
    method: request.method,
    headers: {
        'Content-Type': 'application/dns-message',
        'Accept': 'application/dns-message',
        'User-Agent': request.headers.get('User-Agent') || 'Cloudflare-Worker-DoH-Proxy'
    },
    body: request.method === 'POST' ? request.body : null,
  });

  try {
    const dohResponse = await fetch(dohRequest);
    return dohResponse;
  } catch (e) {
    console.error('DoH proxy failed:', e);
    return new Response('DNS query proxy failed', { status: 502 });
  }
}

// --- SMART API ENDPOINT FOR NETWORK INFO ---
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
                country: data.country,
                isp: data.org,
            };
        } catch (error) {
            console.error(`Failed to fetch details for IP ${ip}:`, error);
            try {
                const fallbackResponse = await fetch(`https://ip-api.io/json/${ip}`);
                if (!fallbackResponse.ok) return { ip };
                const fbData = await fallbackResponse.json();
                return { ip: fbData.ip, city: fbData.city, country: fbData.country_code, isp: fbData.isp };
            } catch (fbError) {
                return { ip };
            }
        }
    };
    
    let resolvedProxyIp = proxyHost;
    if (proxyHost && !/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(proxyHost) && !/^[0-9a-fA-F:]+$/.test(proxyHost)) {
        try {
            const dnsRes = await fetch(`https://1.1.1.1/dns-query?name=${encodeURIComponent(proxyHost)}&type=A`, { headers: { 'accept': 'application/dns-json' } });
            if (dnsRes.ok) {
                const dnsData = await dnsRes.json();
                if (dnsData.Answer) resolvedProxyIp = dnsData.Answer[0].data;
            }
        } catch(e) { console.error('Proxy DNS resolution failed:', e); }
    }

    const [clientDetails, proxyDetails] = await Promise.all([
        getIpDetails(clientIp),
        getIpDetails(resolvedProxyIp),
    ]);

    const responseData = {
        client: clientDetails,
        proxy: {
            host: config.proxyAddress,
            ...proxyDetails
        }
    };

    return new Response(JSON.stringify(responseData), {
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        },
    });
}

async function handleScamalyticsLookup(request, config) {
  const url = new URL(request.url);
  const ipToLookup = url.searchParams.get('ip');
  if (!ipToLookup) {
    return new Response(JSON.stringify({ error: 'Missing IP parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  
  const { username, apiKey, baseUrl } = config.scamalytics;
  if (!username || !apiKey) {
    return new Response(JSON.stringify({ error: 'Scamalytics API credentials not configured.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  
  const scamalyticsUrl = `${baseUrl}${username}/?key=${apiKey}&ip=${ipToLookup}`;
  const headers = new Headers({
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  
  try {
    const scamalyticsResponse = await fetch(scamalyticsUrl);
    const responseBody = await scamalyticsResponse.json();
    return new Response(JSON.stringify(responseBody), { headers });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.toString() }), {
      status: 500,
      headers,
    });
  }
}

// --- WEBSOCKET & PROXY LOGIC ---
async function handleWebSocket(request, env, ctx) {
  const webSocketPair = new WebSocketPair();
  const [client, webSocket] = Object.values(webSocketPair);
  webSocket.accept();

  const cfg = Config.fromEnv(env);
  let address = '';
  let portWithRandomLog = '';
  let udpStreamWriter = null;

  const log = (info, event) => {
    if (address) console.log(`[${address}:${portWithRandomLog}] ${info}`, event || '');
    else console.log(`[WebSocket] ${info}`, event || '');
  };

  const earlyDataHeader = request.headers.get('Sec-WebSocket-Protocol') || '';
  const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, log);
  let remoteSocketWrapper = { value: null };

  readableWebSocketStream
    .pipeTo(
      new WritableStream({
        async write(chunk, controller) {
          if (udpStreamWriter) {
            return udpStreamWriter.write(chunk);
          }
          if (remoteSocketWrapper.value) {
            const writer = remoteSocketWrapper.value.writable.getWriter();
            await writer.write(chunk);
            writer.releaseLock();
            return;
          }

          const {
            hasError, message, addressRemote, portRemote,
            rawDataIndex, ProtocolVersion, isUDP
          } = await processVlessHeader(chunk, env, ctx);

          address = addressRemote;
          portWithRandomLog = `${portRemote}--${Math.floor(Math.random() * 1000)} ${isUDP ? 'udp' : 'tcp'}`;

          if (hasError) {
            throw new Error(message);
          }

          const vlessResponseHeader = new Uint8Array([ProtocolVersion[0], 0]);
          const rawClientData = chunk.slice(rawDataIndex);

          // <<< START: FIX - Intelligent DNS Handling Logic >>>
          if (isUDP) {
            if (portRemote === 53) {
              log(`Handling DNS request to port 53 via DoH`);
              const dnsPipeline = await createDnsPipeline(webSocket, vlessResponseHeader, log, cfg.dohUpstreamUrl);
              udpStreamWriter = dnsPipeline.write;
              await udpStreamWriter(rawClientData); // Use await here
            } else {
              log(`UDP proxy for port ${portRemote} is not supported. Closing connection.`);
              throw new Error(`UDP proxy is only enabled for DNS (port 53)`);
            }
            return;
          }
          // <<< END: FIX - Intelligent DNS Handling Logic >>>

          // Handle TCP outbound for regular traffic
          handleTCPOutbound(
            remoteSocketWrapper, addressRemote, portRemote,
            rawClientData, webSocket, vlessResponseHeader, log, cfg
          );
        },
        close() {
          log(`WebSocket readable stream closed`);
        },
        abort(err) {
          log(`WebSocket readable stream aborted`, err);
        },
      })
    )
    .catch((err) => {
      console.error('WebSocket pipeline failed:', err.stack || err);
      safeCloseWebSocket(webSocket);
    });

  return new Response(null, { status: 101, webSocket: client });
}


async function handleTCPOutbound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log, config) {
    
    async function connectAndWrite(address, port) {
        log(`Connecting to ${address}:${port}`);
        const tcpSocket = await connect({ hostname: address, port: port });
        remoteSocket.value = tcpSocket;
        log(`Connected successfully to ${address}:${port}`);

        const writer = tcpSocket.writable.getWriter();
        await writer.write(rawClientData);
        writer.releaseLock();
        return tcpSocket;
    }

    try {
        const tcpSocket = await connectAndWrite(addressRemote, portRemote);
        remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, log);
    } catch (error) {
        log(`Direct connection to ${addressRemote}:${portRemote} failed: ${error.message}. Retrying with proxy IP.`);
        try {
            const fallbackSocket = await connectAndWrite(config.proxyIP, config.proxyPort);
            remoteSocketToWS(fallbackSocket, webSocket, vlessResponseHeader, log);
        } catch (fallbackError) {
            log(`Fallback connection to proxy ${config.proxyIP}:${config.proxyPort} also failed: ${fallbackError.message}`);
            safeCloseWebSocket(webSocket, 1011, `Proxy connection failed.`);
        }
    }
}

// --- VLESS & UTILITY FUNCTIONS ---
async function processVlessHeader(vlessBuffer, env, ctx) {
  if (vlessBuffer.byteLength < 24) return { hasError: true, message: 'Invalid VLESS header' };
  const dataView = new DataView(vlessBuffer);
  const version = dataView.getUint8(0);
  const uuid = stringify(new Uint8Array(vlessBuffer.slice(1, 17)));
  
  // If DB is configured, validate user. Otherwise, allow any valid UUID.
  if (env.DB && env.KV && !(await isValidUser(uuid, env, ctx))) {
      return { hasError: true, message: 'Invalid user' };
  } else if (!isValidUUID(uuid)) {
      return { hasError: true, message: 'Invalid UUID format' };
  }


  const optLength = dataView.getUint8(17);
  const command = dataView.getUint8(18 + optLength); // 1=TCP, 2=UDP, 3=MUX
  const portIndex = 18 + optLength + 1;
  const portRemote = dataView.getUint16(portIndex);
  const addressType = dataView.getUint8(portIndex + 2);

  let addressRemote, rawDataIndex;
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
      addressRemote = Array.from({ length: 8 }, (_, i) =>
        dataView.getUint16(portIndex + 3 + i * 2).toString(16)
      ).join(':');
      rawDataIndex = portIndex + 19;
      break;
    default:
      return { hasError: true, message: `Invalid addressType: ${addressType}` };
  }

  return {
    hasError: false, addressRemote, portRemote, rawDataIndex,
    ProtocolVersion: new Uint8Array([version]), isUDP: command === 2,
  };
}


// <<< START: ADDED FUNCTION - DNS Pipeline from Script 1 >>>
/**
 * DNS pipeline for UDP DNS requests, using DNS-over-HTTPS.
 * @param {WebSocket} webSocket
 * @param {Uint8Array} vlessResponseHeader
 * @param {Function} log
 * @param {string} dohURL
 * @returns {Promise<{write: Function}>}
 */
async function createDnsPipeline(webSocket, vlessResponseHeader, log, dohURL) {
  let isHeaderSent = false;
  const transformStream = new TransformStream({
    async transform(chunk, controller) {
      // VLESS UDP packets are framed with a 2-byte length header.
      for (let index = 0; index < chunk.byteLength;) {
        if (index + 2 > chunk.byteLength) break;
        const lengthBuffer = chunk.slice(index, index + 2);
        const udpPacketLength = new DataView(lengthBuffer).getUint16(0);
        
        if (index + 2 + udpPacketLength > chunk.byteLength) {
             log(`Incomplete UDP packet received. Waiting for more data.`);
             // This part of the chunk will be processed in the next transform call
             break; 
        }

        const udpData = new Uint8Array(chunk.slice(index + 2, index + 2 + udpPacketLength));
        index = index + 2 + udpPacketLength;
        controller.enqueue(udpData);
      }
    },
  });

  transformStream.readable
    .pipeTo(
      new WritableStream({
        async write(chunk) {
          try {
            // Send DNS query using DoH
            const resp = await fetch(dohURL, {
              method: 'POST',
              headers: { 'content-type': 'application/dns-message' },
              body: chunk,
            });
            const dnsQueryResult = await resp.arrayBuffer();
            const udpSize = dnsQueryResult.byteLength;
            // Frame the response for the VLESS client
            const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);

            if (webSocket.readyState === CONST.WS_READY_STATE_OPEN) {
              log(`DNS query successful, length: ${udpSize}`);
              const blob = isHeaderSent
                ? new Blob([udpSizeBuffer, dnsQueryResult])
                : new Blob([vlessResponseHeader, udpSizeBuffer, dnsQueryResult]);
              
              webSocket.send(await blob.arrayBuffer());
              if (!isHeaderSent) isHeaderSent = true;

            }
          } catch (error) {
            log('DNS query error: ' + error);
          }
        },
      }),
    )
    .catch(e => {
      log('DNS stream error: ' + e);
    });

  const writer = transformStream.writable.getWriter();
  return {
    write: (chunk) => writer.write(chunk),
  };
}
// <<< END: ADDED FUNCTION - DNS Pipeline >>>


const isValidUUID = (uuid) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid);

async function isValidUser(userID, env, ctx) {
    if (!isValidUUID(userID)) return false;
    const cacheKey = `user:${userID}`;
    const cached = await env.KV.get(cacheKey);
    if (cached === 'valid') return true;
    if (cached === 'invalid') return false;

    try {
        const now = Math.floor(Date.now() / 1000);
        const stmt = env.DB.prepare('SELECT expiration_timestamp, status FROM users WHERE id = ?');
        const user = await stmt.bind(userID).first();
        if (!user || user.expiration_timestamp < now || user.status !== 'active') {
            await env.KV.put(cacheKey, 'invalid', { expirationTtl: 3600 });
            return false;
        }
        ctx.waitUntil(env.DB.prepare('UPDATE users SET last_accessed = ? WHERE id = ?').bind(now, userID).run());
        await env.KV.put(cacheKey, 'valid', { expiration: user.expiration_timestamp });
        return true;
    } catch (e) {
        console.error('D1 query failed in isValidUser:', e);
        return false; // Fail safe
    }
}


function makeReadableWebSocketStream(webSocket, earlyData, log) {
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
      const { earlyData: parsedEarlyData, error } = base64ToArrayBuffer(earlyData);
      if (error) {
        controller.error(error);
      } else if (parsedEarlyData) {
        controller.enqueue(parsedEarlyData);
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

/**
 * Pipes remote socket data to WebSocket.
 * @param {import('cloudflare:sockets').Socket} remoteSocket
 * @param {WebSocket} webSocket
 * @param {Uint8Array} vlessResponseHeader
 * @param {Function} log
 */
async function remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, log) {
    let headerSent = false;
    await remoteSocket.readable.pipeTo(
        new WritableStream({
            async write(chunk, controller) {
                if (webSocket.readyState !== CONST.WS_READY_STATE_OPEN) {
                    return controller.error('WebSocket is not open');
                }
                if (!headerSent) {
                    const dataToSend = new Uint8Array(vlessResponseHeader.length + chunk.length);
                    dataToSend.set(vlessResponseHeader);
                    dataToSend.set(chunk, vlessResponseHeader.length);
                    webSocket.send(dataToSend);
                    headerSent = true;
                } else {
                    webSocket.send(chunk);
                }
            },
            close() {
                log('Remote socket readable stream closed.');
            },
            abort(err) {
                console.error('Remote socket readable stream aborted:', err);
            },
        })
    ).catch(err => {
        console.error('Error piping remote to WebSocket:', err.stack || err);
        safeCloseWebSocket(webSocket);
    });
}


function safeCloseWebSocket(socket, code, reason) {
  try {
    if (socket && (socket.readyState === CONST.WS_READY_STATE_OPEN || socket.readyState === CONST.WS_READY_STATE_CLOSING)) {
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
  // No validation here, processVlessHeader will do it.
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

// --- SUBSCRIPTION & UI FUNCTIONS ---
function generateRandomPath(length = 12, query = '') {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `/${result}${query ? `?${query}` : ''}`;
}

const CORE_PRESETS = {
  xray: {
    tls: { path: () => generateRandomPath(12, 'ed=2048'), security: 'tls', fp: 'chrome', alpn: 'h2,http/1.1', extra: {} },
    tcp: { path: () => generateRandomPath(12, 'ed=2048'), security: 'none', fp: 'chrome', extra: {} },
  },
  sb: {
    tls: { path: () => generateRandomPath(18), security: 'tls', fp: 'firefox', alpn: 'h2,http/1.1', extra: {ed: 2560} },
    tcp: { path: () => generateRandomPath(18), security: 'none', fp: 'firefox', extra: {ed: 2560} },
  },
};

function makeName(tag, proto) {
  return `${tag}-${proto.toUpperCase()}`;
}

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
    userID,
    address,
    port,
    host: hostName,
    path: p.path(),
    security: p.security,
    sni: p.security === 'tls' ? hostName : undefined,
    fp: p.fp,
    alpn: p.alpn,
    extra: p.extra,
    name: makeName(tag, proto),
  });
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function handleIpSubscription(core, userID, hostName) {
  const mainDomains = [
    hostName, 'creativecommons.org', 'www.speedtest.net',
    'sky.rethinkdns.com', 'cf.090227.xyz', 'cdnjs.com', 'zula.ir',
    'cfip.1323123.xyz',
    'go.inmobi.com', 'singapore.com', 'www.visa.com',
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
    const r = await fetch('https://raw.githubusercontent.com/NiREvil/vless/refs/heads/main/Cloudflare-IPs.json');
    if (r.ok) {
      const json = await r.json();
      const ips = [...(json.ipv4 || []), ...(json.ipv6 || [])].slice(0, 20).map(x => x.ip);
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

  if (request.method === 'GET' && (path === '/login' || path === '/')) {
    return new Response(getAdminLoginHTML(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  if (request.method === 'GET' && path === '/dashboard') {
    return new Response(getAdminDashboardHTML(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

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

      await env.KV.delete(`user:${id}`);
      return Response.json({ success: true });
    }

    if (request.method === 'GET' && path === '/api/users') {
      const { results } = await env.DB.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
      return Response.json(results);
    }

    if (request.method === 'DELETE' && path.startsWith('/api/users/')) {
      const id = path.substring('/api/users/'.length);
      if (!isValidUUID(id)) return Response.json({ error: 'Invalid UUID format' }, { status: 400 });
      await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
      await env.KV.delete(`user:${id}`);
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
  const dream = buildLink({
    core: 'xray', proto: 'tls', userID, hostName,
    address: hostName, port: 443, tag: `${hostName}-Xray`,
  });

  const freedom = buildLink({
    core: 'sb', proto: 'tls', userID, hostName,
    address: hostName, port: 443, tag: `${hostName}-Singbox`,
  });

  const configs = { dream, freedom };
  const subXrayUrl = `https://${hostName}/xray/${userID}`;
  const subSbUrl = `https://${hostName}/sb/${userID}`;

  const clientUrls = {
    clashMeta: `clash://install-config?url=${encodeURIComponent(`https://revil-sub.pages.dev/sub/clash-meta?url=${subSbUrl}&remote_config=&udp=false&ss_uot=false&show_host=false&forced_ws0rtt=true`)}`,
    hiddify: `hiddify://install-config?url=${encodeURIComponent(subXrayUrl)}`,
    v2rayng: `v2rayng://install-config?url=${encodeURIComponent(subXrayUrl)}`,
    exclave: `sn://subscription?url=${encodeURIComponent(subSbUrl)}`,
  };

  let finalHTML = `
  <!doctype html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>VLESS Proxy Configuration</title>
    <link rel="icon" href="https://raw.githubusercontent.com/NiREvil/zizifn/refs/heads/Legacy/assets/favicon.png" type="image/png">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@300..700&display=swap" rel="stylesheet">
    <style>${getPageCSS()}</style>
  </head>
  <body data-proxy-ip="${proxyAddress}">
    ${getPageHTML(configs, clientUrls)}
    <script>${getPageScript()}</script>
  </body>
  </html>`;

  return finalHTML;
}

function getAdminLoginHTML() {
  return `<!DOCTYPE html><html><head><title>Admin Login</title><style>body{display:flex;justify-content:center;align-items:center;height:100vh;background:#1a1a1a;font-family:sans-serif;margin:0;}div{padding:2rem;background:#2a2a2a;border-radius:8px;color:white;text-align:center;}input,button{width:100%;padding:10px;margin-top:10px;border-radius:5px;border:1px solid #444;background:#333;color:white;box-sizing:border-box;}button{cursor:pointer;background:#007bff;}p{color:red;}</style></head><body><div><h2>Admin Login</h2><input type="password" id="admin-key" placeholder="Enter Admin Key"><button onclick="login()">Login</button><p id="error-message"></p></div><script>
    async function login() {
        const key = document.getElementById('admin-key').value;
        const errorP = document.getElementById('error-message');
        errorP.textContent = '';
        if (!key) {
            errorP.textContent = 'Key cannot be empty.';
            return;
        }
        try {
            const response = await fetch('/admin/api/users', {
                headers: { 'Authorization': key }
            });
            if (response.ok) {
                localStorage.setItem('admin_key', key);
                window.location.href = '/admin/dashboard';
            } else if (response.status === 401) {
                errorP.textContent = 'Invalid Key. Access Denied.';
            } else {
                errorP.textContent = 'An unknown error occurred.';
            }
        } catch (err) {
            errorP.textContent = 'Failed to connect to the server.';
        }
    }
    document.getElementById('admin-key').addEventListener('keyup', (event) => { if (event.key === 'Enter') login(); });
  </script></body></html>`;
}

function getAdminDashboardHTML() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Admin Dashboard</title><style>body{background:#1a1a1a;font-family:sans-serif;color:#fff;padding:20px;}.dashboard{max-width:900px;margin:auto;background:#2a2a2a;border-radius:15px;padding:20px;}h1,h2{text-align:center;}.create-section{background:#333;padding:15px;border-radius:10px;margin-bottom:20px;}input,button{padding:8px;margin:5px;border:none;border-radius:5px;background:#444;color:#fff;}button{background:#007bff;cursor:pointer;}table{width:100%;border-collapse:collapse;}th,td{padding:10px;text-align:left;border-bottom:1px solid #444;word-break:break-all;}.expired{color:#ff5252;}</style></head><body><div class="dashboard"><h1>Admin Dashboard</h1><div class="create-section"><h2>Create User</h2><input type="text" id="new-id" placeholder="User ID (UUID)"><button onclick="generateUUID()">Generate</button><input type="date" id="exp-date"><input type="time" id="exp-time"><input type="text" id="notes" placeholder="Notes"><button onclick="createUser()">Create</button></div><div class="user-list"><h2>User List</h2><table id="user-table"><thead><tr><th>ID</th><th>Expiry</th><th>Created</th><th>Status</th><th>Notes</th><th>Actions</th></tr></thead><tbody></tbody></table></div></div><script>
    const adminKey = localStorage.getItem('admin_key');
    if (!adminKey) window.location.href = '/admin/login';
    const apiHeaders = { 'Content-Type': 'application/json', 'Authorization': adminKey };
    async function apiFetch(endpoint, options={}){const res=await fetch('/admin/api'+endpoint,{...options,headers:apiHeaders});if(res.status===401){alert('Unauthorized!');window.location.href='/admin/login';}return res;}
    function generateUUID(){document.getElementById('new-id').value=crypto.randomUUID();}
    async function createUser(){const id=document.getElementById('new-id').value;const date=document.getElementById('exp-date').value;const time=document.getElementById('exp-time').value;const notes=document.getElementById('notes').value;if(!id||!date||!time)return alert('Fill required fields.');const res=await apiFetch('/users',{method:'POST',body:JSON.stringify({id,expiration_date:date,expiration_time:time,notes})});if(res.ok){alert('User created!');loadUsers();}else{alert('Error creating user.');}}
    async function loadUsers(){const res=await apiFetch('/users');const users=await res.json();const tbody=document.getElementById('user-table').querySelector('tbody');tbody.innerHTML='';const now=Date.now()/1000;users.forEach(u=>{const expiry=new Date(u.expiration_timestamp*1000).toLocaleString();const created=new Date(u.created_at*1000).toLocaleDateString();const statusClass=u.expiration_timestamp>now&&u.status==='active'?'':'expired';tbody.innerHTML+=\`<tr><td>\${u.id}</td><td class="\${statusClass}">\${expiry}</td><td>\${created}</td><td class="\${statusClass}">\${u.status}</td><td>\${u.notes||''}</td><td><button onclick="deleteUser('\${u.id}')">Delete</button></td></tr>\`;});}
    async function deleteUser(id){if(!confirm('Delete user?'))return;const res=await apiFetch(\`/users/\${id}\`,{method:'DELETE'});if(res.ok){alert('User deleted!');loadUsers();}else{alert('Error deleting user.');}}
    window.onload=()=>{generateUUID();loadUsers();};
  </script></body></html>`;
}

function getPageCSS() {
  return `
      * { margin: 0; padding: 0; box-sizing: border-box; }
     @font-face { font-family: "Aldine 401 BT Web"; src: url("https://pub-7a3b428c76aa411181a0f4dd7fa9064b.r2.dev/Aldine401_Mersedeh.woff2") format("woff2"); font-weight: 400; font-style: normal; font-display: swap; }
     @font-face { font-family: "Styrene B LC"; src: url("https://pub-7a3b428c76aa411181a0f4dd7fa9064b.r2.dev/StyreneBLC-Regular.woff2") format("woff2"); font-weight: 400; font-style: normal; font-display: swap; }
     @font-face { font-family: "Styrene B LC"; src: url("https://pub-7a3b428c76aa411181a0f4dd7fa9064b.r2.dev/StyreneBLC-Medium.woff2") format("woff2"); font-weight: 500; font-style: normal; font-display: swap; }
      :root {
        --background-primary: #2a2421; --background-secondary: #35302c; --background-tertiary: #413b35;
        --border-color: #5a4f45; --border-color-hover: #766a5f; --text-primary: #e5dfd6; --text-secondary: #b3a89d;
        --text-accent: #ffffff; --accent-primary: #be9b7b; --accent-secondary: #d4b595; --accent-tertiary: #8d6e5c;
        --accent-primary-darker: #8a6f56; --button-text-primary: #2a2421; --button-text-secondary: var(--text-primary);
        --shadow-color: rgba(0, 0, 0, 0.35); --shadow-color-accent: rgba(190, 155, 123, 0.4);
        --border-radius: 8px; --transition-speed: 0.2s;
        --status-success: #70b570; --status-error: #e05d44; --status-warning: #e0bc44; --status-info: #4f90c4;
        --serif: "Aldine 401 BT Web", serif;
        --sans-serif: "Styrene B LC", sans-serif;
        --mono-serif: "Fira Code", monospace;
       }
      body { font-family: var(--sans-serif); font-size: 16px; background-color: var(--background-primary); color: var(--text-primary); padding: 3rem; line-height: 1.5; }
      .container { max-width: 800px; margin: 20px auto; padding: 0 12px; border-radius: var(--border-radius); box-shadow: 0 6px 15px rgba(0, 0, 0, 0.2), 0 0 25px 8px var(--shadow-color-accent); transition: box-shadow 0.3s ease; }
      .header { text-align: center; margin-bottom: 40px; padding-top: 30px; }
      .header h1 { font-family: var(--serif); font-weight: 400; font-size: 1.8rem; color: var(--text-accent); }
      .header p { color: var(--text-secondary); font-size: 0.8rem; }
      .config-card { background: var(--background-secondary); border-radius: var(--border-radius); padding: 20px; margin-bottom: 24px; border: 1px solid var(--border-color); }
      .config-title { font-family: var(--serif); font-size: 1.6rem; color: var(--accent-secondary); margin-bottom: 16px; padding-bottom: 13px; border-bottom: 1px solid var(--border-color); display: flex; align-items: center; justify-content: space-between; }
      .refresh-btn { display: flex; align-items: center; gap: 4px; font-family: var(--serif); font-size: 12px; padding: 6px 12px; }
      .refresh-icon { width: 12px; height: 12px; stroke: currentColor; transition: transform 0.5s ease; }
      .refresh-btn:hover .refresh-icon { transform: rotate(180deg); }
      .config-content { position: relative; background: var(--background-tertiary); border-radius: var(--border-radius); padding: 16px; margin-bottom: 20px; border: 1px solid var(--border-color); }
      .config-content pre { overflow-x: auto; font-family: var(--mono-serif); font-size: 0.8rem; color: var(--text-primary); margin: 0; white-space: pre-wrap; word-break: break-all; }
      .button { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 8px 16px; border-radius: var(--border-radius); font-size: 15px; font-weight: 500; cursor: pointer; border: 1px solid var(--border-color); background-color: var(--background-tertiary); color: var(--button-text-secondary); text-decoration: none; transition: all 0.2s ease; }
      .button:hover { border-color: var(--border-color-hover); background-color: var(--background-primary); transform: translateY(-2px); }
      .copy-buttons { font-family: var(--serif); font-size: 13px; }
      .copy-icon { width: 12px; height: 12px; stroke: currentColor; }
      .client-buttons { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 12px; margin-top: 16px; }
      .client-btn { width: 100%; background-color: var(--accent-primary); color: var(--button-text-primary); }
      .client-btn:hover { background-color: var(--accent-secondary); }
      .button.copied { background-color: var(--status-success) !important; color: white !important; }
      .footer { text-align: center; margin-top: 20px; padding-bottom: 40px; color: var(--text-secondary); font-size: 0.8rem; }
      .ip-info-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 24px; }
      .ip-info-section { background-color: var(--background-tertiary); border-radius: var(--border-radius); padding: 16px; border: 1px solid var(--border-color); }
      .ip-info-header { display: flex; align-items: center; gap: 10px; border-bottom: 1px solid var(--border-color); padding-bottom: 10px; margin-bottom: 10px; }
      .ip-info-header svg { width: 20px; height: 20px; stroke: var(--accent-secondary); }
      .ip-info-header h3 { font-family: var(--serif); font-size: 18px; color: var(--accent-secondary); margin: 0; }
      .ip-info-content { display: flex; flex-direction: column; gap: 10px; }
      .ip-info-item { display: flex; flex-direction: column; gap: 2px; }
      .ip-info-item .label { font-size: 11px; color: var(--text-secondary); }
      .ip-info-item .value { font-size: 14px; color: var(--text-primary); word-break: break-all; }
      .badge { display: inline-flex; padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight: 500; }
      .badge-yes { background-color: rgba(112, 181, 112, 0.15); color: var(--status-success); }
      .badge-no { background-color: rgba(224, 93, 68, 0.15); color: var(--status-error); }
      .badge-neutral { background-color: rgba(79, 144, 196, 0.15); color: var(--status-info); }
      .badge-warning { background-color: rgba(224, 188, 68, 0.15); color: var(--status-warning); }
      .skeleton { display: block; background: linear-gradient(90deg, var(--background-tertiary) 25%, var(--background-secondary) 50%, var(--background-tertiary) 75%); background-size: 200% 100%; animation: loading 1.5s infinite; border-radius: 4px; height: 16px; }
      @keyframes loading { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
      .country-flag { display: inline-block; width: 18px; height: auto; margin-right: 6px; vertical-align: middle; border-radius: 2px; }
  `;
}

function getPageHTML(configs, clientUrls) {
    return `
    <div class="container">
      <div class="header">
        <h1>VLESS Proxy Configuration</h1>
        <p>Copy the configuration or import directly into your client</p>
      </div>
      <div class="config-card">
        <div class="config-title">
          <span>Network Information</span>
          <button id="refresh-ip-info" class="button refresh-btn" aria-label="Refresh IP information">
            <svg class="refresh-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" /></svg>
            Refresh
          </button>
        </div>
        <div class="ip-info-grid">
          <div class="ip-info-section">
            <div class="ip-info-header">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15.5 2H8.6c-.4 0-.8.2-1.1.5-.3.3-.5.7-.5 1.1v16.8c0 .4.2.8.5 1.1.3.3.7.5 1.1.5h6.9c.4 0 .8-.2 1.1-.5.3-.3.5-.7.5-1.1V3.6c0-.4-.2-.8-.5-1.1-.3-.3-.7-.5-1.1-.5z" /><circle cx="12" cy="18" r="1" /></svg>
              <h3>Proxy Server</h3>
            </div>
            <div class="ip-info-content">
              <div class="ip-info-item"><span class="label">Proxy Host</span><span class="value" id="proxy-host"><span class="skeleton" style="width: 150px"></span></span></div>
              <div class="ip-info-item"><span class="label">IP Address</span><span class="value" id="proxy-ip"><span class="skeleton" style="width: 120px"></span></span></div>
              <div class="ip-info-item"><span class="label">Location</span><span class="value" id="proxy-location"><span class="skeleton" style="width: 100px"></span></span></div>
              <div class="ip-info-item"><span class="label">ISP Provider</span><span class="value" id="proxy-isp"><span class="skeleton" style="width: 140px"></span></span></div>
            </div>
          </div>
          <div class="ip-info-section">
            <div class="ip-info-header">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16" /></svg>
              <h3>Your Connection</h3>
            </div>
            <div class="ip-info-content">
              <div class="ip-info-item"><span class="label">Your IP</span><span class="value" id="client-ip"><span class="skeleton" style="width: 110px"></span></span></div>
              <div class="ip-info-item"><span class="label">Location</span><span class="value" id="client-location"><span class="skeleton" style="width: 90px"></span></span></div>
              <div class="ip-info-item"><span class="label">ISP Provider</span><span class="value" id="client-isp"><span class="skeleton" style="width: 130px"></span></span></div>
              <div class="ip-info-item"><span class="label">Risk Score</span><span class="value" id="client-proxy"><span class="skeleton" style="width: 100px"></span></span></div>
            </div>
          </div>
        </div>
      </div>
      <div class="config-card">
        <div class="config-title">
          <span>Xray Core Clients</span>
          <button class="button copy-buttons" onclick="copyToClipboard(this, '${configs.dream}')"><svg class="copy-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> Copy</button>
        </div>
        <div class="config-content"><pre id="xray-config">${configs.dream}</pre></div>
        <div class="client-buttons">
          <a href="${clientUrls.hiddify}" class="button client-btn">Import to Hiddify</a>
          <a href="${clientUrls.v2rayng}" class="button client-btn">Import to V2rayNG</a>
        </div>
      </div>
      <div class="config-card">
        <div class="config-title">
          <span>Sing-Box Core Clients</span>
          <button class="button copy-buttons" onclick="copyToClipboard(this, '${configs.freedom}')"><svg class="copy-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> Copy</button>
        </div>
        <div class="config-content"><pre id="singbox-config">${configs.freedom}</pre></div>
        <div class="client-buttons">
          <a href="${clientUrls.clashMeta}" class="button client-btn">Import to Clash Meta</a>
          <a href="${clientUrls.exclave}" class="button client-btn">Import to Exclave</a>
        </div>
      </div>
      <div class="footer">
        <p>© ${new Date().getFullYear()} REvil - All Rights Reserved</p>
      </div>
    </div>`;
}

function getPageScript() {
  return `
      function copyToClipboard(button, text) {
        navigator.clipboard.writeText(text).then(() => {
          const originalHTML = button.innerHTML;
          button.innerHTML = 'Copied!';
          button.classList.add("copied");
          setTimeout(() => { button.innerHTML = originalHTML; button.classList.remove("copied"); }, 1200);
        });
      }

      function updateDisplay(data) {
        const createFlag = (countryCode) => countryCode ? \`<img src="https://flagcdn.com/w20/\${countryCode.toLowerCase()}.png" class="country-flag" alt="\${countryCode}"> \` : '';
        const createLocation = (city, country) => [city, country].filter(Boolean).join(', ');

        const proxy = data.proxy || {};
        document.getElementById('proxy-host').textContent = proxy.host || 'N/A';
        document.getElementById('proxy-ip').textContent = proxy.ip || 'N/A';
        document.getElementById('proxy-isp').textContent = proxy.isp || 'N/A';
        const p_loc = createLocation(proxy.city, proxy.country);
        document.getElementById('proxy-location').innerHTML = p_loc ? \`\${createFlag(proxy.country)}\${p_loc}\` : 'N/A';

        const client = data.client || {};
        document.getElementById('client-ip').textContent = client.ip || 'N/A';
        document.getElementById('client-isp').textContent = client.isp || 'N/A';
        const c_loc = createLocation(client.city, client.country);
        document.getElementById('client-location').innerHTML = c_loc ? \`\${createFlag(client.country)}\${c_loc}\` : 'N/A';
      }

      async function fetchScamalytics(ip) {
        if (!ip) {
            document.getElementById('client-proxy').innerHTML = '<span class="badge badge-neutral">N/A</span>';
            return;
        }
        try {
            const res = await fetch(\`/scamalytics-lookup?ip=\${ip}\`);
            if (!res.ok) throw new Error('Scamalytics lookup failed');
            const data = await res.json();
            
            let riskText = "Unknown", badgeClass = "badge-neutral";
            if (data.status === 'ok' && data.score !== undefined) {
                riskText = \`\${data.score} - \${data.risk}\`;
                if(data.risk === 'low') badgeClass = "badge-yes";
                else if(data.risk === 'medium') badgeClass = "badge-warning";
                else if(data.risk === 'high') badgeClass = "badge-no";
            }
            document.getElementById('client-proxy').innerHTML = \`<span class="badge \${badgeClass}">\${riskText}</span>\`;

        } catch (e) {
            console.error('Scamalytics fetch error:', e);
            document.getElementById('client-proxy').innerHTML = '<span class="badge badge-neutral">Error</span>';
        }
      }

      async function loadNetworkInfo() {
        try {
            const response = await fetch('/api/network-info');
            if (!response.ok) throw new Error('API request failed');
            const data = await response.json();
            updateDisplay(data);
            fetchScamalytics(data.client ? data.client.ip : null);
        } catch (error) {
            console.error('Failed to load network info:', error);
            updateDisplay({ client: {}, proxy: { host: document.body.getAttribute('data-proxy-ip') } });
            fetchScamalytics(null);
        }
      }
      
      document.getElementById('refresh-ip-info')?.addEventListener('click', function() {
        const button = this, icon = button.querySelector('.refresh-icon');
        button.disabled = true;
        
        const resetToSkeleton = () => {
          document.querySelectorAll('.value').forEach(el => {
            el.innerHTML = \`<span class="skeleton" style="width: \${Math.floor(80 + Math.random() * 60)}px;"></span>\`;
          });
        };
        resetToSkeleton();
        loadNetworkInfo().finally(() => setTimeout(() => { button.disabled = false; }, 500));
      });
      
      document.addEventListener('DOMContentLoaded', loadNetworkInfo);
  `;
}

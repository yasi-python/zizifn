/**
 * Cloudflare Worker VLESS Proxy with Admin Panel, D1/KV User Management, and Advanced Features
 *
 * @version 2.1.0
 * @author REvil (revised by AI)
 *
 * --- DEPLOYMENT NOTICE ---
 * This script is designed for the CLOUDFLARE WORKERS environment.
 * It WILL NOT work on Cloudflare Pages Functions because it requires the `cloudflare:sockets` API
 * for direct TCP connections, which is only available on Workers.
 *
 * --- SETUP INSTRUCTIONS ---
 * 1.  Create a Cloudflare Worker.
 * 2.  Create a D1 Database and bind it to this worker as `DB`.
 * 3.  In the D1 console, run the following SQL to create the user table:
 * CREATE TABLE users (
 * id TEXT PRIMARY KEY,
 * expiration INTEGER,
 * status TEXT DEFAULT 'active',
 * notes TEXT
 * );
 * 4.  Create a KV Namespace and bind it to this worker as `USER_CACHE`.
 * 5.  Set the following Environment Variables in the worker settings:
 * - `ADMIN_KEY`: A strong, secret key for the admin panel.
 * - `UUID` (optional): A default UUID for basic access. Can be a comma-separated list.
 * - `PROXYIP` (optional): A fallback IP/host for failed direct connections (e.g., '1.2.3.4:443').
 * - `SOCKS5` (optional): A SOCKS5 proxy address (e.g., 'user:pass@host:port').
 *
 * --- ENDPOINTS ---
 * - `/{uuid}`: Shows the user configuration page.
 * - `/admin`: Admin panel login page.
 * - `/admin/dashboard`: Main admin dashboard for user management.
 * - `/xray/{uuid}` & `/sb/{uuid}`: Subscription links for VLESS configs.
 * - WebSocket Path (`/` or random): Handles VLESS connections.
 */

import { connect } from 'cloudflare:sockets';

// --- MAIN CONFIGURATION ---
const Config = {
  // Default values. These will be overridden by environment variables if set.
  defaultUserID: 'd342d11e-d424-4583-b36e-524ab1f0afa4', // A default UUID for testing. It's recommended to set your own via the `UUID` env var.
  proxyIPs: ['nima.nscl.ir:443'], // Default proxy IPs if PROXYIP env var is not set.

  // Scamalytics API configuration
  scamalytics: {
    username: 'revilseptember',
    apiKey: 'b2fc368184deb3d8ac914bd776b8215fe899dd8fef69fbaba77511acfbdeca0d',
    baseUrl: 'https://api12.scamalytics.com/v3/',
  },

  // SOCKS5 configuration (controlled by environment variables)
  socks5: {
    enabled: false,
    address: '',
  },

  // Cache TTL for user validation status in KV (in seconds)
  userCacheTTL: 300, // 5 minutes

  /**
   * Loads configuration from environment variables.
   * @param {any} env - The environment object from the worker context.
   * @returns {object} The fully resolved configuration.
   */
  fromEnv(env) {
    const selectedProxyIP = env.PROXYIP || this.proxyIPs[Math.floor(Math.random() * this.proxyIPs.length)];
    const [proxyHost, proxyPort = '443'] = selectedProxyIP.split(':');

    let socks5Config = {
      enabled: !!env.SOCKS5,
      address: env.SOCKS5 || this.socks5.address,
      parsed: null,
    };

    if (socks5Config.enabled) {
      try {
        socks5Config.parsed = socks5AddressParser(socks5Config.address);
      } catch (error) {
        console.error(`[CONFIG ERROR] Invalid SOCKS5 address format: "${socks5Config.address}". SOCKS5 will be disabled.`, error.message);
        socks5Config.enabled = false;
      }
    }

    return {
      adminKey: env.ADMIN_KEY,
      db: env.DB,
      kv: env.USER_CACHE,
      defaultUserID: env.UUID || this.defaultUserID,
      proxyIP: proxyHost,
      proxyPort: proxyPort,
      proxyAddress: selectedProxyIP,
      scamalytics: {
        username: env.SCAMALYTICS_USERNAME || this.scamalytics.username,
        apiKey: env.SCAMALYTICS_API_KEY || this.scamalytics.apiKey,
        baseUrl: env.SCAMALYTICS_BASEURL || this.scamalytics.baseUrl,
      },
      socks5: socks5Config,
    };
  },
};

// --- CONSTANTS ---
const CONST = {
  WS_READY_STATE_OPEN: 1,
  WS_READY_STATE_CLOSING: 2,
  ADMIN_COOKIE_NAME: '__admin_auth',
};

// =================================================================================
// === MAIN WORKER ENTRY POINT & ROUTER ============================================
// =================================================================================
export default {
  /**
   * @param {Request} request
   * @param {object} env
   * @param {object} ctx
   * @returns {Promise<Response>}
   */
  async fetch(request, env, ctx) {
    const cfg = Config.fromEnv(env);
    const url = new URL(request.url);

    // VLESS WebSocket connections
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
      return handleVLESS(request, cfg);
    }

    // Admin Panel Routes
    if (url.pathname.startsWith('/admin')) {
      return handleAdminRoutes(request, cfg);
    }

    // API endpoint for Scamalytics lookup (used by user page)
    if (url.pathname === '/scamalytics-lookup') {
      return handleScamalyticsLookup(request, cfg);
    }

    // Subscription links and user configuration pages are based on UUID paths
    const uuidMatch = url.pathname.match(/^\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);
    const subscriptionMatch = url.pathname.match(/^\/(xray|sb)\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);

    let userId = null;
    if (uuidMatch) {
      userId = uuidMatch[1];
      if (await authenticateUser(userId, cfg)) {
        return generateBeautifulConfigPage(userId, url.hostname, cfg.proxyAddress);
      }
    } else if (subscriptionMatch) {
      const core = subscriptionMatch[1];
      userId = subscriptionMatch[2];
      if (await authenticateUser(userId, cfg)) {
        return handleIpSubscription(core, userId, url.hostname);
      }
    } else {
        // Fallback for default UUID if configured
        const defaultUsers = cfg.defaultUserID.split(',').map(id => id.trim());
        const pathname = url.pathname;
        for (const defaultId of defaultUsers) {
            if (pathname.startsWith(`/${defaultId}`)) {
                return generateBeautifulConfigPage(defaultId, url.hostname, cfg.proxyAddress);
            }
             if (pathname.startsWith(`/xray/${defaultId}`)) {
                 return handleIpSubscription('xray', defaultId, url.hostname);
             }
             if (pathname.startsWith(`/sb/${defaultId}`)) {
                return handleIpSubscription('sb', defaultId, url.hostname);
             }
        }
    }

    // Default response for unmatched paths
    return new Response(
      'Not Found. Access the service via your UUID path, subscription link, or the admin panel.', { status: 404 }
    );
  },
};


// =================================================================================
// === USER AUTHENTICATION (D1 & KV) ===============================================
// =================================================================================

/**
 * Authenticates a user based on their UUID, using KV for caching and D1 as the source of truth.
 * @param {string} userId - The user's UUID to validate.
 * @param {object} cfg - The worker configuration object.
 * @returns {Promise<boolean>} - True if the user is valid and active, false otherwise.
 */
async function authenticateUser(userId, cfg) {
  // First, check for default, statically configured users
  const staticUsers = cfg.defaultUserID.split(',').map(id => id.trim());
  if (staticUsers.includes(userId)) {
    return true;
  }

  // If D1 or KV are not configured, authentication fails for dynamic users
  if (!cfg.db || !cfg.kv) {
    console.warn('D1 or KV not configured. Only static UUIDs are allowed.');
    return false;
  }

  const cacheKey = `user-status:${userId}`;

  try {
    // 1. Check KV cache first
    const cachedStatus = await cfg.kv.get(cacheKey);
    if (cachedStatus) {
      return cachedStatus === 'valid';
    }

    // 2. If not in cache, query D1
    const stmt = cfg.db.prepare('SELECT status, expiration FROM users WHERE id = ?');
    const user = await stmt.bind(userId).first();

    let isValid = false;
    if (user) {
      const isExpired = user.expiration && user.expiration < Date.now();
      if (user.status === 'active' && !isExpired) {
        isValid = true;
      }
    }

    // 3. Update KV cache with the result
    await cfg.kv.put(cacheKey, isValid ? 'valid' : 'invalid', { expirationTtl: Config.userCacheTTL });

    return isValid;
  } catch (error) {
    console.error(`Authentication error for UUID ${userId}:`, error.stack || error);
    return false; // Fail-safe
  }
}

// =================================================================================
// === VLESS PROTOCOL HANDLING =====================================================
// =================================================================================

/**
 * Handles the entire VLESS over WebSocket protocol.
 * @param {Request} request
 * @param {object} config
 * @returns {Promise<Response>}
 */
async function handleVLESS(request, config) {
  const webSocketPair = new WebSocketPair();
  const [client, webSocket] = Object.values(webSocketPair);
  webSocket.accept();
  let address = '';
  let portWithRandomLog = '';
  let udpStreamWriter = null;
  const log = (info, event) => console.log(`[${address}:${portWithRandomLog}] ${info}`, event || '');
  const earlyDataHeader = request.headers.get('Sec-WebSocket-Protocol') || '';
  const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, log);
  let remoteSocketWapper = { value: null };

  readableWebSocketStream
    .pipeTo(
      new WritableStream({
        async write(chunk, controller) {
          if (udpStreamWriter) return udpStreamWriter.write(chunk);
          if (remoteSocketWapper.value) {
            const writer = remoteSocketWapper.value.writable.getWriter();
            await writer.write(chunk);
            writer.releaseLock();
            return;
          }

          const {
            hasError,
            message,
            addressType,
            portRemote = 443,
            addressRemote = '',
            rawDataIndex,
            vlessVersion = new Uint8Array([0, 0]),
            isUDP,
            userID
          } = processVlessHeader(chunk);
          
          if (hasError) throw new Error(message);

          // Authenticate the user from the VLESS header
          const isUserValid = await authenticateUser(userID, config);
          if (!isUserValid) throw new Error(`Invalid or expired user: ${userID}`);

          address = addressRemote;
          portWithRandomLog = `${portRemote}--${Math.random().toString(36).substring(2, 7)} ${isUDP ? 'udp' : 'tcp'}`;
          const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
          const rawClientData = chunk.slice(rawDataIndex);

          if (isUDP) {
            if (portRemote === 53) {
              const dnsPipeline = await createDnsPipeline(webSocket, vlessResponseHeader, log);
              udpStreamWriter = dnsPipeline.write;
              await udpStreamWriter(rawClientData);
            } else throw new Error('UDP proxy is only enabled for DNS (port 53)');
            return;
          }
          
          handleTCPOutBound(
            remoteSocketWapper,
            addressType,
            addressRemote,
            portRemote,
            rawClientData,
            webSocket,
            vlessResponseHeader,
            log,
            config
          );
        },
        close: () => log(`readableWebSocketStream closed`),
        abort: (err) => log(`readableWebSocketStream aborted`, err),
      }),
    )
    .catch(err => {
      log('VLESS pipeline error:', err.stack || err);
      safeCloseWebSocket(webSocket);
    });

  return new Response(null, { status: 101, webSocket: client });
}

/**
 * Parses and validates the VLESS protocol header from the client's first packet.
 * @param {ArrayBuffer} protocolBuffer
 * @returns {object} Parsed header information.
 */
function processVlessHeader(protocolBuffer) {
  if (protocolBuffer.byteLength < 24) return { hasError: true, message: 'invalid data' };
  const dataView = new DataView(protocolBuffer);
  const version = dataView.getUint8(0);
  const userID = stringify(new Uint8Array(protocolBuffer.slice(1, 17)));
  if (!isValidUUID(userID)) return { hasError: true, message: 'invalid user UUID' };

  const optLength = dataView.getUint8(17);
  const command = dataView.getUint8(18 + optLength);
  if (command !== 1 && command !== 2) return { hasError: true, message: `command ${command} is not supported` };

  const portIndex = 18 + optLength + 1;
  const portRemote = dataView.getUint16(portIndex);
  const addressType = dataView.getUint8(portIndex + 2);
  let addressValue, addressLength, addressValueIndex;

  switch (addressType) {
    case 1: // IPv4
      addressLength = 4;
      addressValueIndex = portIndex + 3;
      addressValue = new Uint8Array(protocolBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
      break;
    case 2: // Domain
      addressLength = dataView.getUint8(portIndex + 3);
      addressValueIndex = portIndex + 4;
      addressValue = new TextDecoder().decode(protocolBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
      break;
    case 3: // IPv6
      addressLength = 16;
      addressValueIndex = portIndex + 3;
      const ipv6 = new DataView(protocolBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
      addressValue = Array.from({ length: 8 }, (_, i) => ipv6.getUint16(i * 2).toString(16)).join(':');
      break;
    default:
      return { hasError: true, message: `invalid addressType: ${addressType}` };
  }

  if (!addressValue) return { hasError: true, message: `address is empty, type: ${addressType}` };

  return {
    hasError: false,
    addressRemote: addressValue,
    addressType: addressType,
    portRemote: portRemote,
    rawDataIndex: addressValueIndex + addressLength,
    vlessVersion: new Uint8Array([version]),
    isUDP: command === 2,
    userID: userID,
  };
}


/**
 * Handles TCP outbound connections with SOCKS5 and relay fallback logic.
 * @param {object} remoteSocket
 * @param {number} addressType
 * @param {string} addressRemote
 * @param {number} portRemote
 * @param {Uint8Array} rawClientData
 * @param {WebSocket} webSocket
 * @param {Uint8Array} vlessResponseHeader
 * @param {Function} log
 * @param {object} config
 */
async function handleTCPOutBound(remoteSocket, addressType, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log, config) {
  async function connectAndWrite(address, port, isSocks = false) {
    const options = {
      hostname: address,
      port: port
    };
    log(`Connecting to ${address}:${port}`);
    const tcpSocket = isSocks ?
      await socks5Connect(addressType, addressRemote, portRemote, log, config.socks5.parsed) :
      connect(options);
    remoteSocket.value = tcpSocket;
    log(`Connected to ${address}:${port}`);
    const writer = tcpSocket.writable.getWriter();
    await writer.write(rawClientData);
    writer.releaseLock();
    return tcpSocket;
  }

  const connectWithFallback = async () => {
    // Primary connection: SOCKS5 if enabled
    if (config.socks5.enabled) {
      try {
        return await connectAndWrite(config.socks5.parsed.hostname, config.socks5.parsed.port, true);
      } catch (err) {
        log(`SOCKS5 connection failed: ${err.message}`, err);
        // If SOCKS fails, do not fall back to direct connection for security reasons.
        throw new Error(`SOCKS5 proxy connection failed. Aborting.`);
      }
    }

    // Primary connection: Direct connection
    try {
      return await connectAndWrite(addressRemote, portRemote, false);
    } catch (err) {
      log(`Direct connection to ${addressRemote}:${portRemote} failed: ${err.message}`, err);
      // Fallback: Use proxyIP if direct connection fails
      if (config.proxyIP) {
        log(`Falling back to proxy: ${config.proxyIP}:${config.proxyPort}`);
        try {
          return await connectAndWrite(config.proxyIP, parseInt(config.proxyPort), false);
        } catch (fallbackErr) {
          log(`Fallback connection failed: ${fallbackErr.message}`, fallbackErr);
          throw fallbackErr; // Throw the fallback error
        }
      }
      throw err; // Re-throw original error if no proxyIP is configured
    }
  };

  try {
    const tcpSocket = await connectWithFallback();
    remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, log);
  } catch (error) {
    log(`Failed to establish outbound connection: ${error.message}`, error.stack);
    safeCloseWebSocket(webSocket);
  }
}


// =================================================================================
// === ADMIN PANEL =================================================================
// =================================================================================

/**
 * Router for all /admin/* routes.
 * @param {Request} request
 * @param {object} cfg
 * @returns {Promise<Response>}
 */
async function handleAdminRoutes(request, cfg) {
  if (!cfg.adminKey || !cfg.db) {
    return new Response('Admin panel is not configured. `ADMIN_KEY` and `DB` binding are required.', { status: 503 });
  }

  const url = new URL(request.url);

  // API routes
  if (url.pathname.startsWith('/admin/api/')) {
    // API routes require authentication via cookie
    const cookie = request.headers.get('Cookie');
    const isAuthenticated = cookie && cookie.includes(`${CONST.ADMIN_COOKIE_NAME}=${cfg.adminKey}`);
    if (!isAuthenticated) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
    return handleAdminApi(request, cfg);
  }

  // Login page
  if (url.pathname === '/admin' || url.pathname === '/admin/login') {
    if (request.method === 'POST') {
      const formData = await request.formData();
      const password = formData.get('password');
      if (password === cfg.adminKey) {
        return new Response(null, {
          status: 302,
          headers: {
            'Location': '/admin/dashboard',
            'Set-Cookie': `${CONST.ADMIN_COOKIE_NAME}=${cfg.adminKey}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`, // Cookie for 1 day
          },
        });
      }
      // Failed login attempt
      return new Response(getAdminLoginPage(true), { status: 401, headers: { 'Content-Type': 'text/html' } });
    }
    return new Response(getAdminLoginPage(), { headers: { 'Content-Type': 'text/html' } });
  }
    
  // Logout
  if (url.pathname === '/admin/logout') {
    return new Response(null, {
        status: 302,
        headers: {
            'Location': '/admin/login',
            'Set-Cookie': `${CONST.ADMIN_COOKIE_NAME}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`
        }
    });
  }


  // Dashboard page (requires cookie)
  if (url.pathname === '/admin/dashboard') {
    const cookie = request.headers.get('Cookie');
    if (cookie && cookie.includes(`${CONST.ADMIN_COOKIE_NAME}=${cfg.adminKey}`)) {
      return new Response(getAdminDashboardPage(), { headers: { 'Content-Type': 'text/html' } });
    }
    // Redirect to login if not authenticated
    return new Response(null, { status: 302, headers: { 'Location': '/admin/login' } });
  }

  return new Response('Admin route not found.', { status: 404 });
}

/**
 * Handles all /admin/api/* requests.
 * @param {Request} request
 * @param {object} cfg
 * @returns {Promise<Response>}
 */
async function handleAdminApi(request, cfg) {
  const { pathname } = new URL(request.url);
  const headers = { 'Content-Type': 'application/json' };

  try {
    // GET /admin/api/users
    if (request.method === 'GET' && pathname === '/admin/api/users') {
      const { results } = await cfg.db.prepare('SELECT id, expiration, status, notes FROM users ORDER BY expiration DESC').all();
      return new Response(JSON.stringify(results), { headers });
    }

    // POST /admin/api/users (Create)
    if (request.method === 'POST' && pathname === '/admin/api/users') {
      const { expiration, notes } = await request.json();
      const newUuid = crypto.randomUUID();
      const expirationTimestamp = expiration ? new Date(expiration).getTime() : null;

      await cfg.db.prepare('INSERT INTO users (id, expiration, notes, status) VALUES (?, ?, ?, ?)')
        .bind(newUuid, expirationTimestamp, notes, 'active')
        .run();

      return new Response(JSON.stringify({ id: newUuid, expiration: expirationTimestamp, notes, status: 'active' }), { status: 201, headers });
    }

    // PUT /admin/api/users/:id (Update)
    const updateMatch = pathname.match(/^\/admin\/api\/users\/([0-9a-f-]+)$/i);
    if (request.method === 'PUT' && updateMatch) {
      const userId = updateMatch[1];
      const { expiration, status, notes } = await request.json();
      const expirationTimestamp = expiration ? new Date(expiration).getTime() : null;

      await cfg.db.prepare('UPDATE users SET expiration = ?, status = ?, notes = ? WHERE id = ?')
        .bind(expirationTimestamp, status, notes, userId)
        .run();

      // Invalidate cache for the updated user
      await cfg.kv.delete(`user-status:${userId}`);

      return new Response(JSON.stringify({ success: true }), { headers });
    }

    // DELETE /admin/api/users/:id (Delete)
    const deleteMatch = pathname.match(/^\/admin\/api\/users\/([0-9a-f-]+)$/i);
    if (request.method === 'DELETE' && deleteMatch) {
      const userId = deleteMatch[1];
      await cfg.db.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
       // Invalidate cache for the deleted user
       await cfg.kv.delete(`user-status:${userId}`);
      return new Response(null, { status: 204 });
    }

    return new Response(JSON.stringify({ error: 'API route not found' }), { status: 404, headers });

  } catch (error) {
    console.error('Admin API error:', error.stack || error);
    return new Response(JSON.stringify({ error: 'Internal Server Error', details: error.message }), { status: 500, headers });
  }
}

// =================================================================================
// === HTML/CSS/JS GENERATION FOR WEB PAGES ========================================
// =================================================================================

// --- ADMIN PANEL HTML/CSS/JS ---

function getAdminLoginPage(error = false) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin Login</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background-color: #1a1a1a; color: #e0e0e0; }
    .login-container { background-color: #2c2c2c; padding: 40px; border-radius: 8px; box-shadow: 0 4px 15px rgba(0,0,0,0.5); text-align: center; width: 90%; max-width: 350px; }
    h1 { margin-bottom: 24px; color: #fff; }
    input { width: 100%; padding: 12px; margin-bottom: 20px; border-radius: 4px; border: 1px solid #555; background-color: #333; color: #fff; font-size: 16px; box-sizing: border-box; }
    button { width: 100%; padding: 12px; border: none; border-radius: 4px; background-color: #007aff; color: white; font-size: 16px; cursor: pointer; transition: background-color 0.2s; }
    button:hover { background-color: #0056b3; }
    .error { color: #ff4d4d; margin-top: -10px; margin-bottom: 10px; }
  </style>
</head>
<body>
  <div class="login-container">
    <h1>Admin Access</h1>
    <form method="POST">
      <input type="password" name="password" placeholder="Enter Admin Key" required>
      ${error ? '<p class="error">Invalid key. Please try again.</p>' : ''}
      <button type="submit">Login</button>
    </form>
  </div>
</body>
</html>`;
}

function getAdminDashboardPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin Dashboard</title>
  <style>
    :root { --bg: #1a1a1a; --surface: #2c2c2c; --primary: #007aff; --text: #e0e0e0; --border: #444; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background-color: var(--bg); color: var(--text); padding: 20px; }
    .container { max-width: 1200px; margin: auto; }
    h1 { display: flex; justify-content: space-between; align-items: center; }
    a.logout { font-size: 1rem; color: var(--primary); text-decoration: none; }
    .modal { display: none; position: fixed; z-index: 100; left: 0; top: 0; width: 100%; height: 100%; overflow: auto; background-color: rgba(0,0,0,0.7); justify-content: center; align-items: center; }
    .modal-content { background-color: var(--surface); padding: 20px; border-radius: 8px; width: 90%; max-width: 500px; }
    .modal-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); padding-bottom: 10px; margin-bottom: 20px; }
    .close-btn { font-size: 28px; font-weight: bold; cursor: pointer; }
    .table-wrapper { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; margin-top: 20px; min-width: 800px; }
    th, td { padding: 12px; border: 1px solid var(--border); text-align: left; font-size: 0.9em; }
    th { background-color: #333; }
    td { word-break: break-all; }
    .actions button { margin-right: 5px; cursor: pointer; padding: 5px 10px; border-radius: 4px; border: none; }
    .btn-edit { background-color: #ff9500; color: white; }
    .btn-delete { background-color: #ff3b30; color: white; }
    .btn-add { background-color: var(--primary); color: white; padding: 10px 15px; border: none; border-radius: 5px; cursor: pointer; font-size: 16px; margin-bottom: 20px; }
    label { display: block; margin-bottom: 8px; }
    input, textarea, select { width: 100%; padding: 10px; margin-bottom: 15px; border-radius: 4px; border: 1px solid #555; background-color: #333; color: var(--text); box-sizing: border-box; }
    .form-actions { text-align: right; }
    .form-actions button { padding: 10px 20px; }
    .status-active { color: #34c759; }
    .status-inactive { color: #ff9500; }
  </style>
</head>
<body>
<div class="container">
    <h1><span>User Management</span> <a href="/admin/logout" class="logout">Logout</a></h1>
    <button class="btn-add" id="addUserBtn">Add New User</button>
    <div class="table-wrapper">
      <table>
          <thead>
              <tr><th>UUID</th><th>Expiration</th><th>Status</th><th>Notes</th><th>Actions</th></tr>
          </thead>
          <tbody id="user-table-body"></tbody>
      </table>
    </div>
</div>

<div id="userModal" class="modal">
    <div class="modal-content">
        <div class="modal-header">
            <h2 id="modalTitle">Add User</h2>
            <span class="close-btn">&times;</span>
        </div>
        <form id="userForm">
            <input type="hidden" id="userId">
            <label for="userNotes">Notes:</label>
            <textarea id="userNotes" rows="3"></textarea>
            <label for="userExpiration">Expiration (optional):</label>
            <input type="datetime-local" id="userExpiration">
            <label for="userStatus" id="statusLabel">Status:</label>
            <select id="userStatus">
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
            </select>
            <div class="form-actions">
                <button type="submit" class="btn-add">Save</button>
            </div>
        </form>
    </div>
</div>

<script>
    const modal = document.getElementById('userModal');
    const addUserBtn = document.getElementById('addUserBtn');
    const closeBtn = document.querySelector('.close-btn');
    const userForm = document.getElementById('userForm');
    const modalTitle = document.getElementById('modalTitle');
    
    function openModal() { modal.style.display = 'flex'; }
    function closeModal() { modal.style.display = 'none'; userForm.reset(); document.getElementById('userId').value = ''; }

    addUserBtn.onclick = () => {
        modalTitle.textContent = 'Add New User';
        document.getElementById('userStatus').style.display = 'none';
        document.getElementById('statusLabel').style.display = 'none';
        openModal();
    };
    closeBtn.onclick = closeModal;
    window.onclick = (event) => { if (event.target == modal) closeModal(); };

    async function fetchUsers() {
        const response = await fetch('/admin/api/users');
        const users = await response.json();
        const tbody = document.getElementById('user-table-body');
        tbody.innerHTML = '';
        users.forEach(user => {
            const expirationDate = user.expiration ? new Date(user.expiration).toLocaleString() : 'Never';
            const row = \`
                <tr>
                    <td>\${user.id}</td>
                    <td>\${expirationDate}</td>
                    <td><span class="status-\${user.status}">\${user.status}</span></td>
                    <td>\${user.notes || ''}</td>
                    <td class="actions">
                        <button class="btn-edit" onclick="editUser('\${user.id}', '\${user.expiration || ''}', '\${user.status}', '\${user.notes || ''}')">Edit</button>
                        <button class="btn-delete" onclick="deleteUser('\${user.id}')">Delete</button>
                    </td>
                </tr>
            \`;
            tbody.innerHTML += row;
        });
    }

    function editUser(id, expiration, status, notes) {
        modalTitle.textContent = 'Edit User';
        document.getElementById('userId').value = id;
        document.getElementById('userNotes').value = notes;
        const expDate = expiration ? new Date(parseInt(expiration)) : null;
        document.getElementById('userExpiration').value = expDate ? new Date(expDate.getTime() - (expDate.getTimezoneOffset() * 60000)).toISOString().slice(0, 16) : '';
        document.getElementById('userStatus').value = status;
        document.getElementById('userStatus').style.display = 'block';
        document.getElementById('statusLabel').style.display = 'block';
        openModal();
    }

    async function deleteUser(id) {
        if (!confirm('Are you sure you want to delete this user?')) return;
        await fetch(\`/admin/api/users/\${id}\`, { method: 'DELETE' });
        fetchUsers();
    }

    userForm.onsubmit = async (e) => {
        e.preventDefault();
        const id = document.getElementById('userId').value;
        const notes = document.getElementById('userNotes').value;
        const expiration = document.getElementById('userExpiration').value;
        const status = document.getElementById('userStatus').value;
        
        const body = { notes, expiration, status };
        const url = id ? \`/admin/api/users/\${id}\` : '/admin/api/users';
        const method = id ? 'PUT' : 'POST';

        const response = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        if (response.ok) {
            closeModal();
            fetchUsers();
        } else {
            const error = await response.json();
            alert('Error: ' + (error.details || error.error));
        }
    };

    fetchUsers();
</script>
</body>
</html>`;
}


// --- USER CONFIG PAGE HTML/CSS/JS ---
function generateBeautifulConfigPage(userID, hostName, proxyAddress) {
  const dream = buildLink({
    core: 'xray', proto: 'tls', userID, hostName,
    address: hostName, port: 443, tag: `${hostName}-Xray`,
  });

  const freedom = buildLink({
    core: 'sb',   proto: 'tls', userID, hostName,
    address: hostName, port: 443, tag: `${hostName}-Singbox`,
  });
  
  const configs = { dream, freedom };
  const subXrayUrl = `https://${hostName}/xray/${userID}`;
  const subSbUrl   = `https://${hostName}/sb/${userID}`;
  
  const clientUrls = {
    clashMeta: `clash://install-config?url=${encodeURIComponent(`https://revil-sub.pages.dev/sub/clash-meta?url=${subSbUrl}&remote_config=&udp=false&ss_uot=false&show_host=false&forced_ws0rtt=true`)}`,
    hiddify: `hiddify://install-config?url=${encodeURIComponent(subXrayUrl)}`,
    v2rayng: `v2rayng://install-config?url=${encodeURIComponent(subXrayUrl)}`,
    exclave: `sn://subscription?url=${encodeURIComponent(subSbUrl)}`,
  };

  return new Response(`
  <!doctype html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
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
  </html>`, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
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
      body { font-family: var(--sans-serif); font-size: 16px; font-weight: 400; background-color: var(--background-primary); color: var(--text-primary); padding: 3rem; line-height: 1.5; }
      .container { max-width: 800px; margin: 20px auto; padding: 0 12px; border-radius: var(--border-radius); box-shadow: 0 6px 15px rgba(0,0,0,0.2), 0 0 25px 8px var(--shadow-color-accent); transition: box-shadow .3s ease; }
      .container:hover { box-shadow: 0 8px 20px rgba(0,0,0,0.25), 0 0 35px 10px var(--shadow-color-accent); }
      .header { text-align: center; margin-bottom: 40px; padding-top: 30px; }
      .header h1 { font-family: var(--serif); font-weight: 400; font-size: 1.8rem; color: var(--text-accent); margin-bottom: 2px; }
      .header p { color: var(--text-secondary); font-size: 0.6rem; }
      .config-card { background: var(--background-secondary); border-radius: var(--border-radius); padding: 20px; margin-bottom: 24px; border: 1px solid var(--border-color); transition: border-color .2s ease, box-shadow .2s ease; }
      .config-card:hover { border-color: var(--border-color-hover); box-shadow: 0 4px 8px var(--shadow-color); }
      .config-title { font-family: var(--serif); font-size: 1.6rem; font-weight: 400; color: var(--accent-secondary); margin-bottom: 16px; padding-bottom: 13px; border-bottom: 1px solid var(--border-color); display: flex; align-items: center; justify-content: space-between; }
      .config-title .refresh-btn { position: relative; overflow: hidden; display: flex; align-items: center; gap: 4px; font-family: var(--serif); font-size: 12px; padding: 6px 12px; border-radius: 6px; color: var(--accent-secondary); background-color: var(--background-tertiary); border: 1px solid var(--border-color); cursor: pointer; transition: all .2s ease; }
      .config-title .refresh-btn::before { content: ''; position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: linear-gradient(120deg, transparent, rgba(255,255,255,0.2), transparent); transform: translateX(-100%); transition: transform .6s ease; z-index: 1; }
      .config-title .refresh-btn:hover { letter-spacing: 0.5px; font-weight: 600; background-color: #4d453e; color: var(--accent-primary); border-color: var(--border-color-hover); transform: translateY(-2px); box-shadow: 0 4px 8px var(--shadow-color); }
      .config-title .refresh-btn:hover::before { transform: translateX(100%); }
      .refresh-icon { width: 12px; height: 12px; stroke: currentColor; }
      .config-content { position: relative; background: var(--background-tertiary); border-radius: var(--border-radius); padding: 16px; margin-bottom: 20px; border: 1px solid var(--border-color); }
      .config-content pre { overflow-x: auto; font-family: var(--mono-serif); font-size: 7px; color: var(--text-primary); margin: 0; white-space: pre-wrap; word-break: break-all; }
      .button { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 8px 16px; border-radius: var(--border-radius); font-size: 15px; font-weight: 500; cursor: pointer; border: 1px solid var(--border-color); background-color: var(--background-tertiary); color: var(--button-text-secondary); transition: all .2s ease; text-decoration: none; }
      .copy-buttons { position: relative; display: flex; gap: 4px; overflow: hidden; align-self: center; font-family: var(--serif); font-size: 13px; padding: 6px 12px; border-radius: 6px; color: var(--accent-secondary); border: 1px solid var(--border-color); }
      .copy-buttons::before, .client-btn::before { content: ''; position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: linear-gradient(120deg, transparent, rgba(255,255,255,0.2), transparent); transform: translateX(-100%); transition: transform .6s ease; z-index: -1; }
      .copy-buttons:hover::before, .client-btn:hover::before { transform: translateX(100%); }
      .copy-buttons:hover { background-color: #4d453e; letter-spacing: 0.5px; font-weight: 600; border-color: var(--border-color-hover); transform: translateY(-2px); box-shadow: 0 4px 8px var(--shadow-color); }
      .copy-icon { width: 12px; height: 12px; stroke: currentColor; }
      .client-buttons { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; margin-top: 16px; }
      .client-btn { width: 100%; background-color: var(--accent-primary); color: var(--background-tertiary); border-radius: 6px; border-color: var(--accent-primary-darker); position: relative; overflow: hidden; transition: all 0.3s cubic-bezier(0.2, 0.8, 0.2, 1); box-shadow: 0 2px 5px rgba(0,0,0,0.15); }
      .client-btn:hover { text-transform: uppercase; transform: translateY(-3px); background-color: var(--accent-secondary); color: var(--button-text-primary); box-shadow: 0 5px 15px rgba(190, 155, 123, 0.5); border-color: var(--accent-secondary); }
	    .client-icon { width: 18px; height: 18px; border-radius: 6px; background-color: var(--background-secondary); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
	    .client-icon svg { width: 14px; height: 14px; fill: var(--accent-secondary); }
	    .button.copied { background-color: var(--accent-secondary) !important; color: var(--background-tertiary) !important; }
	    .footer { text-align: center; margin-top: 20px; padding-bottom: 40px; color: var(--text-secondary); font-size: 8px; }
	    .ip-info-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 24px; }
	    .ip-info-section { background-color: var(--background-tertiary); border-radius: var(--border-radius); padding: 16px; border: 1px solid var(--border-color); display: flex; flex-direction: column; gap: 20px; }
	    .ip-info-header { display: flex; align-items: center; gap: 10px; border-bottom: 1px solid var(--border-color); padding-bottom: 10px; }
	    .ip-info-header svg { width: 20px; height: 20px; stroke: var(--accent-secondary); }
	    .ip-info-header h3 { font-family: var(--serif); font-size: 18px; font-weight: 400; color: var(--accent-secondary); margin: 0; }
	    .ip-info-item { display: flex; flex-direction: column; gap: 2px; }
	    .ip-info-item .label { font-size: 11px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px; }
	    .ip-info-item .value { font-size: 14px; color: var(--text-primary); word-break: break-all; line-height: 1.4; }
	    .badge { display: inline-flex; align-items: center; justify-content: center; padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight: 500; }
	    .badge-yes { background-color: rgba(112,181,112,0.15); color: var(--status-success); border: 1px solid rgba(112,181,112,0.3); }
	    .badge-no { background-color: rgba(224,93,68,0.15); color: var(--status-error); border: 1px solid rgba(224,93,68,0.3); }
	    .badge-neutral { background-color: rgba(79,144,196,0.15); color: var(--status-info); border: 1px solid rgba(79,144,196,0.3); }
	    .badge-warning { background-color: rgba(224,188,68,0.15); color: var(--status-warning); border: 1px solid rgba(224,188,68,0.3); }
	    .skeleton { display: block; background: linear-gradient(90deg, var(--background-tertiary) 25%, var(--background-secondary) 50%, var(--background-tertiary) 75%); background-size: 200% 100%; animation: loading 1.5s infinite; border-radius: 4px; height: 16px; }
	    @keyframes loading { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
	    .country-flag { display: inline-block; width: 18px; height: auto; margin-right: 6px; vertical-align: middle; border-radius: 2px; }
        @media (max-width: 768px) { body { padding: 20px; } .container { padding: 0 14px; width: auto; } }
  `;
}

function getPageHTML(configs, clientUrls) {
  return `
    <div class="container">
      <div class="header"><h1>VLESS Proxy Configuration</h1><p>Copy configuration or import directly</p></div>
      <div class="config-card">
        <div class="config-title"><span>Network Information</span><button id="refresh-ip-info" class="refresh-btn"><svg class="refresh-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" /></svg>Refresh</button></div>
        <div class="ip-info-grid">
          <div class="ip-info-section">
            <div class="ip-info-header"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15.5 2H8.6c-.4 0-.8.2-1.1.5-.3.3-.5.7-.5 1.1v16.8c0 .4.2.8.5 1.1.3.3.7.5 1.1.5h6.9c.4 0 .8-.2 1.1-.5.3-.3.5-.7.5-1.1V3.6c0-.4-.2-.8-.5-1.1-.3-.3-.7-.5-1.1-.5z" /><circle cx="12" cy="18" r="1" /></svg><h3>Proxy Server</h3></div>
            <div class="ip-info-content">
              <div class="ip-info-item"><span class="label">Proxy Host</span><span class="value" id="proxy-host"><span class="skeleton" style="width:150px"></span></span></div>
              <div class="ip-info-item"><span class="label">IP Address</span><span class="value" id="proxy-ip"><span class="skeleton" style="width:120px"></span></span></div>
              <div class="ip-info-item"><span class="label">Location</span><span class="value" id="proxy-location"><span class="skeleton" style="width:100px"></span></span></div>
              <div class="ip-info-item"><span class="label">ISP</span><span class="value" id="proxy-isp"><span class="skeleton" style="width:140px"></span></span></div>
            </div>
          </div>
          <div class="ip-info-section">
            <div class="ip-info-header"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16" /></svg><h3>Your Connection</h3></div>
            <div class="ip-info-content">
              <div class="ip-info-item"><span class="label">Your IP</span><span class="value" id="client-ip"><span class="skeleton" style="width:110px"></span></span></div>
              <div class="ip-info-item"><span class="label">Location</span><span class="value" id="client-location"><span class="skeleton" style="width:90px"></span></span></div>
              <div class="ip-info-item"><span class="label">ISP</span><span class="value" id="client-isp"><span class="skeleton" style="width:130px"></span></span></div>
              <div class="ip-info-item"><span class="label">Risk Score</span><span class="value" id="client-proxy"><span class="skeleton" style="width:100px"></span></span></div>
            </div>
          </div>
        </div>
      </div>
      <div class="config-card">
        <div class="config-title"><span>Xray Core</span><button class="button copy-buttons" onclick="copyToClipboard(this, '${configs.dream}')"><svg class="copy-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>Copy</button></div>
        <div class="config-content"><pre id="xray-config">${configs.dream}</pre></div>
        <div class="client-buttons">
          <a href="${clientUrls.hiddify}" class="button client-btn"><span class="client-icon"><svg viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" /></svg></span><span>Import to Hiddify</span></a>
          <a href="${clientUrls.v2rayng}" class="button client-btn"><span class="client-icon"><svg viewBox="0 0 24 24"><path d="M12 2L4 5v6c0 5.5 3.5 10.7 8 12.3 4.5-1.6 8-6.8 8-12.3V5l-8-3z" /></svg></span><span>Import to V2rayNG</span></a>
        </div>
      </div>
      <div class="config-card">
        <div class="config-title"><span>Sing-Box Core</span><button class="button copy-buttons" onclick="copyToClipboard(this, '${configs.freedom}')"><svg class="copy-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>Copy</button></div>
        <div class="config-content"><pre id="singbox-config">${configs.freedom}</pre></div>
        <div class="client-buttons">
          <a href="${clientUrls.clashMeta}" class="button client-btn"><span class="client-icon"><svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93z" /></svg></span><span>Import to Clash Meta</span></a>
          <a href="${clientUrls.exclave}" class="button client-btn"><span class="client-icon"><svg viewBox="0 0 24 24"><path d="M20,8h-3V6c0-1.1-0.9-2-2-2H9C7.9,4,7,4.9,7,6v2H4C2.9,8,2,8.9,2,10v9c0,1.1,0.9,2,2,2h16c1.1,0,2-0.9,2-2v-9 C22,8.9,21.1,8,20,8z M9,6h6v2H9V6z" /></svg></span><span>Import to Exclave</span></a>
        </div>
      </div>
      <div class="footer"><p>© ${new Date().getFullYear()} REvil - All Rights Reserved</p></div>
    </div>
  `;
}

function getPageScript() {
  return `
      function copyToClipboard(button, text) {
        navigator.clipboard.writeText(text).then(() => {
          button.innerHTML = 'Copied!';
          button.classList.add("copied");
          setTimeout(() => {
            button.innerHTML = '<svg class="copy-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> Copy';
            button.classList.remove("copied");
          }, 1200);
        });
      }
      async function fetchIpInfo(ip) {
        try {
          const response = await fetch(\`https://ip-api.io/json/\${ip}\`);
          return response.ok ? await response.json() : null;
        } catch { return null; }
      }
      async function fetchScamalytics(ip) {
        try {
          const response = await fetch(\`/scamalytics-lookup?ip=\${ip}\`);
          return response.ok ? await response.json() : null;
        } catch { return null; }
      }
      function updateDisplay(prefix, data) {
        if (!data) return;
        document.getElementById(\`\${prefix}-ip\`).textContent = data.ip || 'N/A';
        const flag = data.country_code ? \`<img src="https://flagcdn.com/w20/\${data.country_code.toLowerCase()}.png" class="country-flag"> \` : '';
        document.getElementById(\`\${prefix}-location\`).innerHTML = \`\${flag}\${[data.city, data.country_name].filter(Boolean).join(', ')}\` || 'N/A';
        document.getElementById(\`\${prefix}-isp\`).textContent = data.isp || data.organisation || 'N/A';
      }
      async function loadNetworkInfo() {
        const proxyIpWithPort = document.body.getAttribute('data-proxy-ip') || '';
        const proxyDomain = proxyIpWithPort.split(':')[0];
        document.getElementById('proxy-host').textContent = proxyIpWithPort;
        if (proxyDomain) {
          const proxyGeo = await fetchIpInfo(proxyDomain);
          updateDisplay('proxy', proxyGeo);
        }
        try {
          const clientIpData = await fetch('https://api.ipify.org?format=json').then(r => r.json());
          if (clientIpData.ip) {
              const clientGeo = await fetchIpInfo(clientIpData.ip);
              updateDisplay('client', clientGeo);
              const scamData = await fetchScamalytics(clientIpData.ip);
              if(scamData && scamData.scamalytics && scamData.scamalytics.score) {
                const { score, risk } = scamData.scamalytics;
                let badgeClass = 'neutral';
                if (risk === 'low') badgeClass = 'yes';
                else if (risk === 'medium') badgeClass = 'warning';
                else if (risk === 'high' || risk === 'very high') badgeClass = 'no';
                document.getElementById('client-proxy').innerHTML = \`<span class="badge badge-\${badgeClass}">\${score} - \${risk}</span>\`;
              }
          }
        } catch(e) { console.error('Could not fetch client IP info', e); }
      }
      document.getElementById('refresh-ip-info').addEventListener('click', loadNetworkInfo);
      document.addEventListener('DOMContentLoaded', loadNetworkInfo);
  `;
}

// =================================================================================
// === UTILITY & HELPER FUNCTIONS ==================================================
// =================================================================================

/**
 * Handles the Scamalytics API lookup for the user page.
 * @param {Request} request
 * @param {object} config
 * @returns {Promise<Response>}
 */
async function handleScamalyticsLookup(request, config) {
  const url = new URL(request.url);
  const ipToLookup = url.searchParams.get('ip');
  if (!ipToLookup) return new Response(JSON.stringify({ error: 'Missing IP' }), { status: 400 });

  const { username, apiKey, baseUrl } = config.scamalytics;
  const scamalyticsUrl = `${baseUrl}${username}/?key=${apiKey}&ip=${ipToLookup}`;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  
  try {
    const response = await fetch(scamalyticsUrl);
    const body = await response.json();
    return new Response(JSON.stringify(body), { headers });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.toString() }), { status: 500, headers });
  }
}

/**
 * Handles the generation of subscription links.
 * @param {string} core - 'xray' or 'sb'.
 * @param {string} userID
 * @param {string} hostName
 * @returns {Promise<Response>}
 */
async function handleIpSubscription(core, userID, hostName) {
  const mainDomains = [hostName, 'www.speedtest.net', 'sky.rethinkdns.com', 'cdnjs.com'];
  const httpsPorts = [443, 8443, 2053, 2087, 2096];
  let links = [];

  mainDomains.forEach((domain, i) => {
    links.push(buildLink({ core, proto: 'tls', userID, hostName, address: domain, port: httpsPorts[Math.floor(Math.random() * httpsPorts.length)], tag: `D${i+1}` }));
  });

  try {
    const r = await fetch('https://raw.githubusercontent.com/NiREvil/vless/main/Cloudflare-IPs.json');
    if (r.ok) {
      const { ipv4 = [] } = await r.json();
      ipv4.slice(0, 10).forEach((ip, i) => {
        links.push(buildLink({ core, proto: 'tls', userID, hostName, address: ip, port: httpsPorts[Math.floor(Math.random() * httpsPorts.length)], tag: `IP${i+1}` }));
      });
    }
  } catch (e) { console.error('Fetch IP list failed', e); }

  return new Response(btoa(links.join('\n')), { headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
}


function makeReadableWebSocketStream(webSocketServer, earlyDataHeader, log) {
  return new ReadableStream({
    start(controller) {
      webSocketServer.addEventListener('message', event => controller.enqueue(event.data));
      webSocketServer.addEventListener('close', () => { safeCloseWebSocket(webSocketServer); controller.close(); });
      webSocketServer.addEventListener('error', err => { log('webSocketServer error'); controller.error(err); });
      const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
      if (error) controller.error(error);
      else if (earlyData) controller.enqueue(earlyData);
    },
    pull() {},
    cancel(reason) {
      log(`ReadableStream was canceled, due to ${reason}`);
      if (webSocketServer.readyState === CONST.WS_READY_STATE_OPEN) {
        safeCloseWebSocket(webSocketServer);
      }
    }
  });
}

async function remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, log) {
  try {
    await remoteSocket.readable.pipeTo(
      new WritableStream({
        start() {
          if (webSocket.readyState === CONST.WS_READY_STATE_OPEN && vlessResponseHeader) {
            webSocket.send(vlessResponseHeader);
          }
        },
        async write(chunk) {
          if (webSocket.readyState !== CONST.WS_READY_STATE_OPEN) {
            throw new Error('WebSocket connection is not open');
          }
          webSocket.send(chunk);
        },
        close: () => log(`remoteSocketToWS pipe closed`),
        abort: err => log(`remoteSocketToWS pipe aborted`, err.stack || err),
      })
    );
  } catch (error) {
    log('remoteSocketToWS error:', error.stack || error);
  } finally {
    safeCloseWebSocket(webSocket);
  }
}

async function createDnsPipeline(webSocket, vlessResponseHeader, log) {
  let isHeaderSent = false;
  const transformStream = new TransformStream({
    transform(chunk, controller) {
      for (let index = 0; index < chunk.byteLength;) {
        if (index + 2 > chunk.byteLength) break;
        const lengthBuffer = chunk.slice(index, index + 2);
        const udpPacketLength = new DataView(lengthBuffer).getUint16(0);
        const packetEnd = index + 2 + udpPacketLength;
        if (packetEnd > chunk.byteLength) break;
        controller.enqueue(new Uint8Array(chunk.slice(index + 2, packetEnd)));
        index = packetEnd;
      }
    },
  });

  transformStream.readable.pipeTo(new WritableStream({
    async write(chunk) {
      try {
        const resp = await fetch(`https://1.1.1.1/dns-query`, {
          method: 'POST',
          headers: { 'content-type': 'application/dns-message' },
          body: chunk,
        });
        const dnsResult = await resp.arrayBuffer();
        const sizeBuffer = new Uint8Array([(dnsResult.byteLength >> 8) & 0xff, dnsResult.byteLength & 0xff]);
        if (webSocket.readyState === CONST.WS_READY_STATE_OPEN) {
          const dataToSend = isHeaderSent ? [sizeBuffer, dnsResult] : [vlessResponseHeader, sizeBuffer, dnsResult];
          webSocket.send(new Blob(dataToSend));
          isHeaderSent = true;
        }
      } catch (e) { log('DNS query error: ', e.stack || e); }
    },
  })).catch(e => { log('DNS stream error: ', e.stack || e); });

  return transformStream.writable.getWriter();
}

async function socks5Connect(addressType, addressRemote, portRemote, log, parsedSocks5Addr) {
  const { username, password, hostname, port } = parsedSocks5Addr;
  const socket = connect({ hostname, port });
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const encoder = new TextEncoder();

  await writer.write(new Uint8Array([5, 1, 0])); // Version 5, 1 auth method, no-auth
  let res = (await reader.read()).value;
  if (res[0] !== 0x05 || res[1] !== 0x00) {
    // try auth
    await writer.write(new Uint8Array([5, 2, 0, 2])); // Greeting
    res = (await reader.read()).value;
    if (res[0] !== 0x05 || res[1] === 0xff) throw new Error('SOCKS5 auth negotiation failed.');
    if (res[1] === 0x02) { // Auth required
        if (!username || !password) throw new Error('SOCKS5 auth required but not provided.');
        const authRequest = new Uint8Array([1, username.length, ...encoder.encode(username), password.length, ...encoder.encode(password)]);
        await writer.write(authRequest);
        res = (await reader.read()).value;
        if (res[0] !== 0x01 || res[1] !== 0x00) throw new Error('SOCKS5 authentication failed.');
    }
  }
  
  let DSTADDR;
  switch(addressType) {
    case 1: DSTADDR = new Uint8Array([1, ...addressRemote.split('.').map(Number)]); break;
    case 2: DSTADDR = new Uint8Array([3, addressRemote.length, ...encoder.encode(addressRemote)]); break;
    case 3: DSTADDR = new Uint8Array([4, ...addressRemote.split(':').flatMap(x => [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2), 16)])]); break;
    default: throw new Error(`Invalid addressType for SOCKS5: ${addressType}`);
  }

  await writer.write(new Uint8Array([5, 1, 0, ...DSTADDR, portRemote >> 8, portRemote & 0xff]));
  res = (await reader.read()).value;
  if (res[1] !== 0x00) throw new Error(`SOCKS5 connection failed, status: ${res[1]}`);

  writer.releaseLock();
  reader.releaseLock();
  return socket;
}

function socks5AddressParser(address) {
    const match = address.match(/^(?:(.+?):(.+?)@)?([^:]+):(\d+)$/);
    if (!match) {
        throw new Error('Invalid SOCKS5 address format. Expected [user:pass@]host:port');
    }
    const [, username, password, hostname, portStr] = match;
    const port = parseInt(portStr, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
        throw new Error('Invalid port number in SOCKS5 address.');
    }
    return { username, password, hostname, port };
}

function base64ToArrayBuffer(base64Str) {
  if (!base64Str) return { earlyData: null, error: null };
  try {
    const binaryStr = atob(base64Str.replace(/-/g, '+').replace(/_/g, '/'));
    const buffer = new ArrayBuffer(binaryStr.length);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < binaryStr.length; i++) view[i] = binaryStr.charCodeAt(i);
    return { earlyData: buffer, error: null };
  } catch (error) {
    return { earlyData: null, error };
  }
}

function safeCloseWebSocket(socket) {
  try {
    if (socket && (socket.readyState === CONST.WS_READY_STATE_OPEN || socket.readyState === CONST.WS_READY_STATE_CLOSING)) {
      socket.close();
    }
  } catch (error) { console.error('safeCloseWebSocket error:', error.stack || error); }
}

const byteToHex = Array.from({ length: 256 }, (_, i) => (i + 0x100).toString(16).slice(1));
function stringify(arr, offset = 0) {
  return (byteToHex[arr[offset]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + '-' + byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + '-' + byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + '-' + byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + '-' + byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]).toLowerCase();
}

function isValidUUID(uuid) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid);
}

function generateRandomPath(length = 12, query = '') {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return `/${result}${query ? `?${query}` : ''}`;
}

const CORE_PRESETS = {
  xray: { tls: { path: () => generateRandomPath(12, 'ed=2048'), security: 'tls', fp: 'chrome', alpn: 'http/1.1' } },
  sb: { tls: { path: () => generateRandomPath(18), security: 'tls', fp: 'firefox', alpn: 'h2,http/1.1', extra: {} } },
};

function createVlessLink({ userID, address, port, host, path, security, sni, fp, alpn, extra = {}, name }) {
  const params = new URLSearchParams({ type: 'ws', host, path, security, sni, fp, alpn, ...extra });
  return `vless://${userID}@${address}:${port}?${params.toString()}#${encodeURIComponent(name)}`;
}

function buildLink({ core, proto, userID, hostName, address, port, tag }) {
  const p = CORE_PRESETS[core][proto];
  return createVlessLink({ userID, address, port, host: hostName, path: p.path(), security: p.security, sni: p.security === 'tls' ? hostName : undefined, fp: p.fp, alpn: p.alpn, extra: p.extra, name: `${tag}-${proto.toUpperCase()}` });
}

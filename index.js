/**
 * @typedef {import('@cloudflare/workers-types').Request} Request
 * @typedef {import('@cloudflare/workers-types').ExecutionContext} ExecutionContext
 * @typedef {import('@cloudflare/workers-types').D1Database} D1Database
 * @typedef {import('@cloudflare/workers-types').KVNamespace} KVNamespace
 */

// --- GLOBAL CONFIGURATION ---
const config = {
	userID: 'd342d11e-d424-4583-b36e-524ab1f0afa4',
	proxyIP: 'pro.iranserver.com', // This is now used only for the single config on the user page
	dohURL: 'https://1.1.1.1/dns-query',
	adminKey: 'admin-key-placeholder',
};

// --- ENVIRONMENT VARIABLE PARSER ---
function fromEnv(env) {
	return {
		userID: env.UUID || config.userID,
		proxyIP: env.PROXYIP || config.proxyIP,
		dohURL: env.DOH_UPSTREAM_URL || config.dohURL,
		adminKey: env.ADMIN_KEY || config.adminKey,
		DB: env.DB,
		CACHE: env.CACHE,
	};
}

// --- CORE SUBSCRIPTION & LINK GENERATION LOGIC (NEW) ---
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
    tls: { path: () => generateRandomPath(12, 'ed=2048'), security: 'tls', fp: 'chrome', alpn: 'http/1.1', extra: {} },
    tcp: { path: () => generateRandomPath(12, 'ed=2048'), security: 'none', fp: 'chrome', extra: {} },
  },
  sb: {
    tls: { path: () => generateRandomPath(18), security: 'tls', fp: 'firefox', alpn: 'h3', extra: {ed: 2560} },
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

async function handleSubscription(core, userID, hostName) {
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

// --- MAIN FETCH HANDLER & ROUTER ---
export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		const cfg = fromEnv(env);

		// 1. WebSocket VLESS connections
		const upgradeHeader = request.headers.get('Upgrade');
		if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
			return handleVlessWebSocket(request, cfg);
		}

		// 2. Admin Panel routes
		if (url.pathname.startsWith('/admin')) {
			return handleAdminRoutes(request, cfg);
		}

		// 3. Subscription routes (UPDATED)
		const subMatch = url.pathname.match(/^\/sub\/(xray|sb)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/);
		if (subMatch) {
			const core = subMatch[1];
			const requestedUUID = subMatch[2];
			const user = await getAndCacheUser(requestedUUID, cfg.DB, cfg.CACHE);
			if (user && user.isValid) {
				return handleSubscription(core, requestedUUID, url.hostname);
			} else {
				return new Response('Invalid or expired user UUID.', { status: 403 });
			}
		}

		// 4. User config page route
		const userPageMatch = url.pathname.match(/^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/);
		if (userPageMatch) {
			const requestedUUID = userPageMatch[1];
			const user = await getAndCacheUser(requestedUUID, cfg.DB, cfg.CACHE);
			if (user && user.isValid) {
				return handleUserConfigPage(requestedUUID, url.hostname, cfg.proxyIP, user.expirationTimestamp);
			} else {
				return new Response('Invalid or expired user UUID.', { status: 403 });
			}
		}

        // 5. DOH Proxy route
		if (url.pathname === '/dns-query') {
			return fetch(cfg.dohURL, request);
		}

		// 6. Landing Page
		const html = `
			<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>VLESS Worker</title>
			<style>body{font-family:sans-serif;background-color:#121212;color:#e0e0e0;text-align:center;padding-top:5em;}h1{color:#00bcd4;}p{color:#bdbdbd;}a{color:#80deea;}</style></head>
			<body><h1>VLESS Worker is running</h1><p>Access your configuration page via <code>/{your-uuid}</code></p><p>Access the admin panel via <code>/admin</code></p></body></html>
		`;
		return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } });
	},
};

// --- USER & DB MANAGEMENT ---
async function getAndCacheUser(uuid, db, cache) {
	if (!db || !cache) {
		const envUUIDs = (process.env.UUID || config.userID).split(',');
		const isValid = envUUIDs.map(u => u.trim()).includes(uuid);
		return { isValid, expirationTimestamp: null };
	}
	const cachedStatus = await cache.get(`uuid-status:${uuid}`);
	if (cachedStatus) {
		const [status, expiration] = cachedStatus.split(':');
		return { isValid: status === 'valid', expirationTimestamp: parseInt(expiration, 10) || null };
	}
	try {
		const stmt = db.prepare('SELECT expiration_timestamp, status FROM users WHERE uuid = ?');
		const result = await stmt.bind(uuid).first();
		let isValid = false;
		let expirationTimestamp = null;
		if (result) {
			expirationTimestamp = result.expiration_timestamp;
			const isExpired = Date.now() > expirationTimestamp;
			const isActive = result.status === 'active';
			isValid = isActive && !isExpired;
		}
		const cacheValue = `${isValid ? 'valid' : 'invalid'}:${expirationTimestamp || 0}`;
		await cache.put(`uuid-status:${uuid}`, cacheValue, { expirationTtl: 300 });
		return { isValid, expirationTimestamp };
	} catch (error) {
		console.error('D1 Database query failed:', error);
		return { isValid: false, expirationTimestamp: null };
	}
}

// --- WEBSOCKET & VLESS LOGIC ---
async function handleVlessWebSocket(request, cfg) {
	const webSocketPair = new WebSocketPair();
	const [client, webSocket] = Object.values(webSocketPair);
	webSocket.accept();
	let address = '';
	let portWithRandomLog = '';
	const log = (info, event) => console.log(`[${address}:${portWithRandomLog}] ${info}`, event || '');
	const earlyDataHeader = request.headers.get('Sec-WebSocket-Protocol') || '';
	const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, log);
	readableWebSocketStream.pipeTo(new WritableStream({
		async write(chunk, controller) {
			const { hasError, message, addressRemote = '', portRemote = 443, rawDataIndex, vlessVersion = new Uint8Array([0, 0]), isUDP, uuid, } = processVlessHeader(chunk, cfg.userID);
			if (hasError) throw new Error(message);
			const user = await getAndCacheUser(uuid, cfg.DB, cfg.CACHE);
			if (!user || !user.isValid) throw new Error(`User with UUID ${uuid} is invalid, expired, or inactive.`);
			address = addressRemote;
			portWithRandomLog = `${portRemote}--${Math.random().toString(36).slice(2, 8)}`;
			log(`${isUDP ? 'UDP' : 'TCP'} request`);
			const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
			const rawClientData = chunk.slice(rawDataIndex);
			if (isUDP) throw new Error('UDP proxying is not supported.');
			const remoteSocket = connect({ hostname: addressRemote, port: portRemote });
			const writer = remoteSocket.writable.getWriter();
			writer.write(rawClientData);
			writer.releaseLock();
			return remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, log);
		},
		close() { log(`Client WebSocket stream closed`); },
		abort(err) { log(`Client WebSocket stream aborted`, err); },
	})).catch((err) => {
		log('Error in WebSocket pipeline:', err.message);
		safeCloseWebSocket(webSocket);
	});
	return new Response(null, { status: 101, webSocket: client });
}

function processVlessHeader(vlessBuffer) {
	if (vlessBuffer.byteLength < 24) return { hasError: true, message: 'Invalid VLESS header size' };
	const view = new DataView(vlessBuffer);
	const version = view.getUint8(0);
	const uuid = stringify(new Uint8Array(vlessBuffer.slice(1, 17)));
	const optLength = view.getUint8(17);
	const command = view.getUint8(18 + optLength);
	const portRemote = view.getUint16(19 + optLength);
	const addressType = view.getUint8(21 + optLength);
	let addressRemote = '';
	let rawDataIndex = 22 + optLength;
	switch (addressType) {
		case 1:
			addressRemote = new Uint8Array(vlessBuffer.slice(rawDataIndex, rawDataIndex + 4)).join('.');
			rawDataIndex += 4; break;
		case 2:
			const domainLength = view.getUint8(rawDataIndex);
			rawDataIndex += 1;
			addressRemote = new TextDecoder().decode(vlessBuffer.slice(rawDataIndex, rawDataIndex + domainLength));
			rawDataIndex += domainLength; break;
		case 3:
			addressRemote = new Uint16Array(vlessBuffer.slice(rawDataIndex, rawDataIndex + 16)).reduce((acc, part) => acc + part.toString(16).padStart(4, '0'), '').match(/.{1,4}/g).join(':');
			rawDataIndex += 16; break;
		default: return { hasError: true, message: `Invalid address type: ${addressType}` };
	}
	return { hasError: false, addressRemote, portRemote, rawDataIndex, vlessVersion: new Uint8Array([version]), isUDP: command === 2, uuid, };
}

// --- HTML & PAGE GENERATION ---
function handleUserConfigPage(uuid, hostname, proxyIP, expirationTimestamp) {
	// Generate a single, reliable config for the main page display
	const singleConfig = buildLink({
		core: 'xray',
		proto: 'tls',
		userID: uuid,
		hostName: hostname,
		address: proxyIP,
		port: 443,
		tag: 'Direct'
	});

    // Generate subscription links for both core types
	const subLinks = {
		xray: `https://${hostname}/sub/xray/${uuid}`,
		sb: `https://${hostname}/sub/sb/${uuid}`,
	};

	const html = getUserPageHTML(singleConfig, subLinks, expirationTimestamp);
	return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

function getUserPageHTML(configLink, subLinks, expirationTimestamp) {
    const expirationDate = expirationTimestamp ? new Date(expirationTimestamp).toLocaleString() : 'N/A';
	const timeRemaining = expirationTimestamp ? Math.round((expirationTimestamp - Date.now()) / (1000 * 60 * 60 * 24)) : 'N/A';
	return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>VLESS Configuration</title><style>:root{--bg-color:#121212;--card-bg:#1e1e1e;--text-color:#e0e0e0;--accent-color:#03dac6;--border-color:#333;}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background-color:var(--bg-color);color:var(--text-color);display:flex;justify-content:center;align-items:center;min-height:100vh;padding:20px;}.container{background-color:var(--card-bg);border-radius:12px;padding:30px;width:100%;max-width:600px;box-shadow:0 10px 30px rgba(0,0,0,0.5);border:1px solid var(--border-color);}h1{color:var(--accent-color);text-align:center;margin-bottom:30px;}.info-box{background-color:#2a2a2a;padding:15px;border-radius:8px;margin-bottom:20px;text-align:center;}.info-box p{margin:5px 0;}.info-box strong{color:var(--accent-color);}.config-box{margin-top:30px;}p strong{color:var(--accent-color);font-size:1.1em;}pre{background-color:#2a2a2a;padding:15px;border-radius:8px;word-wrap:break-word;white-space:pre-wrap;font-family:'Courier New',Courier,monospace;font-size:14px;}.buttons{display:flex;gap:10px;margin-top:10px;margin-bottom:20px;flex-wrap:wrap;}button,a.button{flex-grow:1;padding:12px;border:none;border-radius:8px;font-size:16px;font-weight:bold;cursor:pointer;text-decoration:none;text-align:center;background-color:var(--accent-color);color:#000;transition:background-color 0.2s;}button:hover,a.button:hover{background-color:#018786;}</style></head><body><div class="container"><h1>Your VLESS Configuration</h1><div class="info-box"><p><strong>Subscription Expires On:</strong> ${expirationDate}</p><p><strong>Days Remaining:</strong> ${timeRemaining}</p></div><div class="config-box"><p><strong>Direct Configuration Link:</strong></p><pre id="config-text">${configLink}</pre><div class="buttons"><button onclick="copyToClipboard('config-text')">Copy Config</button></div></div><hr style="border-color: #333; margin: 30px 0;"><div class="config-box"><p><strong>Xray Subscription (for v2rayNG):</strong></p><pre id="sub-text-xray">${subLinks.xray}</pre><div class="buttons"><button onclick="copyToClipboard('sub-text-xray')">Copy</button><a href="v2rayng://install-config?url=${encodeURIComponent(subLinks.xray)}" class="button">Add to v2rayNG</a></div></div><div class="config-box"><p><strong>Sing-Box Subscription (for Hiddify/NekoBox):</strong></p><pre id="sub-text-sb">${subLinks.sb}</pre><div class="buttons"><button onclick="copyToClipboard('sub-text-sb')">Copy</button><a href="hiddify://install-config?url=${encodeURIComponent(subLinks.sb)}" class="button">Add to Hiddify</a></div></div></div><script>function copyToClipboard(elementId){const text=document.getElementById(elementId).innerText;navigator.clipboard.writeText(text).then(()=>alert('Copied to clipboard!'),()=>alert('Failed to copy!'));}</script></body></html>`;
}


// --- ADMIN PANEL (UNCHANGED) ---
async function handleAdminRoutes(request, cfg) {
	const url = new URL(request.url);
	if (cfg.adminKey === 'admin-key-placeholder' || !cfg.adminKey) return new Response('Admin key is not set. Please set ADMIN_KEY environment variable.', { status: 500 });
	if (url.pathname.startsWith('/admin/api/')) {
		const authHeader = request.headers.get('Authorization');
		if (!authHeader || authHeader !== `Bearer ${cfg.adminKey}`) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
		return handleAdminApi(request, cfg);
	}
	if (url.pathname === '/admin' || url.pathname === '/admin/login') {
		if (request.method === 'POST') {
			try {
				const formData = await request.formData();
				if (formData.get('key') === cfg.adminKey) return new Response(null, { status: 302, headers: { 'Location': `/admin/dashboard?auth=${cfg.adminKey}` } });
				else return new Response('Invalid Key', { status: 403 });
			} catch { return new Response('Invalid request', { status: 400 }); }
		}
		return new Response(getAdminLoginPageHTML(), { headers: { 'Content-Type': 'text/html' } });
	}
	if (url.pathname === '/admin/dashboard') {
		const authKey = url.searchParams.get('auth');
		if (authKey !== cfg.adminKey) return new Response('Unauthorized', { status: 403 });
		return new Response(getAdminDashboardHTML(cfg.adminKey), { headers: { 'Content-Type': 'text/html' } });
	}
	return new Response('Not Found', { status: 404 });
}

async function handleAdminApi(request, cfg) {
	const { pathname } = new URL(request.url);
	const db = cfg.DB;
	if (!db) return new Response(JSON.stringify({ error: 'D1 Database not configured' }), { status: 500 });
	if (pathname === '/admin/api/users' && request.method === 'GET') {
		try {
			const { results } = await db.prepare('SELECT * FROM users ORDER BY expiration_timestamp DESC').all();
			return new Response(JSON.stringify(results || []), { headers: { 'Content-Type': 'application/json' } });
		} catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
	}
	if (pathname === '/admin/api/users' && request.method === 'POST') {
		try {
			const { expiration, note } = await request.json();
			const newUUID = crypto.randomUUID();
			const expirationTimestamp = new Date(expiration).getTime();
			await db.prepare('INSERT INTO users (id, uuid, expiration_timestamp, note) VALUES (?, ?, ?, ?)').bind(crypto.randomUUID(), newUUID, expirationTimestamp, note || '').run();
			await cfg.CACHE.delete(`uuid-status:${newUUID}`);
			return new Response(JSON.stringify({ success: true, uuid: newUUID }), { status: 201 });
		} catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
	}
	const updateMatch = pathname.match(/^\/admin\/api\/users\/([0-9a-f-]+)$/);
	if (updateMatch && request.method === 'PUT') {
		try {
			const uuidToUpdate = updateMatch[1];
			const { expiration, note, status } = await request.json();
			const expirationTimestamp = new Date(expiration).getTime();
			await db.prepare('UPDATE users SET expiration_timestamp = ?, note = ?, status = ? WHERE uuid = ?').bind(expirationTimestamp, note, status, uuidToUpdate).run();
			await cfg.CACHE.delete(`uuid-status:${uuidToUpdate}`);
			return new Response(JSON.stringify({ success: true }), { status: 200 });
		} catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
	}
	const deleteMatch = pathname.match(/^\/admin\/api\/users\/([0-9a-f-]+)$/);
	if (deleteMatch && request.method === 'DELETE') {
		try {
			const uuidToDelete = deleteMatch[1];
			await db.prepare('DELETE FROM users WHERE uuid = ?').bind(uuidToDelete).run();
			await cfg.CACHE.delete(`uuid-status:${uuidToDelete}`);
			return new Response(JSON.stringify({ success: true }), { status: 200 });
		} catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
	}
	return new Response('API route not found', { status: 404 });
}

function getAdminLoginPageHTML() { return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Admin Login</title><style>body{display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#212121;color:#fff;font-family:sans-serif;}.login-box{background:#333;padding:40px;border-radius:8px;box-shadow:0 0 15px rgba(0,0,0,0.5);text-align:center;}h1{margin-bottom:20px;color:#00e5ff;}input{width:100%;padding:10px;margin-bottom:20px;border-radius:4px;border:1px solid #555;background:#444;color:#fff;}button{padding:10px 20px;border:none;border-radius:4px;background:#00e5ff;color:#000;font-weight:bold;cursor:pointer;}</style></head><body><div class="login-box"><h1>Admin Panel</h1><form method="POST" action="/admin/login"><input type="password" name="key" placeholder="Enter Admin Key" required><button type="submit">Login</button></form></div></body></html>`; }
function getAdminDashboardHTML(adminKey) { return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Admin Dashboard</title><style>body{font-family:sans-serif;background:#1a1a1a;color:#e0e0e0;margin:0;padding:20px;}.container{max-width:1200px;margin:auto;}h1{color:#26c6da;border-bottom:2px solid #26c6da;padding-bottom:10px;}table{width:100%;border-collapse:collapse;margin-top:20px;}th,td{padding:12px;border:1px solid #444;text-align:left;}th{background:#333;}tr:nth-child(even){background:#2a2a2a;}button{cursor:pointer;padding:8px 12px;border:none;border-radius:4px;margin:2px;}.btn-edit{background:#ffab40;}.btn-delete{background:#f44336;color:white;}.btn-add{background:#4caf50;color:white;padding:10px 20px;font-size:16px;margin-bottom:20px;}.modal{display:none;position:fixed;z-index:1;left:0;top:0;width:100%;height:100%;overflow:auto;background-color:rgba(0,0,0,0.7);}.modal-content{background-color:#333;margin:10% auto;padding:20px;border:1px solid #888;width:80%;max-width:500px;border-radius:8px;}.close{color:#aaa;float:right;font-size:28px;font-weight:bold;cursor:pointer;}.form-group{margin-bottom:15px;}label{display:block;margin-bottom:5px;}input,select,textarea{width:100%;padding:8px;background:#444;color:#fff;border:1px solid #666;border-radius:4px;box-sizing:border-box;}.actions{text-align:right;}.actions button{font-size:14px;}</style></head><body><div class="container"><h1>User Management</h1><button class="btn-add" id="addUserBtn">Add New User</button><table><thead><tr><th>UUID</th><th>Expiration</th><th>Status</th><th>Note</th><th>Actions</th></tr></thead><tbody id="user-table-body"></tbody></table></div><div id="userModal" class="modal"><div class="modal-content"><span class="close">&times;</span><h2 id="modal-title">Add User</h2><form id="userForm"><input type="hidden" id="user-uuid"><div class="form-group"><label for="expiration">Expiration Date & Time</label><input type="datetime-local" id="expiration" required></div><div class="form-group"><label for="status">Status</label><select id="status"><option value="active">Active</option><option value="inactive">Inactive</option></select></div><div class="form-group"><label for="note">Note</label><textarea id="note" rows="3"></textarea></div><div class="actions"><button type="submit" class="btn-add">Save</button></div></form></div></div><script>
        const API_KEY = '${adminKey}'; const modal = document.getElementById('userModal'); const userForm = document.getElementById('userForm'); const modalTitle = document.getElementById('modal-title'); const userTableBody = document.getElementById('user-table-body');
        async function apiCall(endpoint, method = 'GET', body = null) { const options = { method, headers: { 'Authorization': \`Bearer \${API_KEY}\`, 'Content-Type': 'application/json' },}; if (body) options.body = JSON.stringify(body); const response = await fetch(\`/admin/api\${endpoint}\`, options); if (!response.ok) { const error = await response.json(); alert(\`Error: \${error.error || 'Unknown error'}\`); throw new Error('API call failed'); } return response.json(); }
        const getUsers = () => apiCall('/users'); const createUser = (data) => apiCall('/users', 'POST', data); const updateUser = (uuid, data) => apiCall(\`/users/\${uuid}\`, 'PUT', data); const deleteUser = (uuid) => apiCall(\`/users/\${uuid}\`, 'DELETE');
        function renderUsers(users) { userTableBody.innerHTML = ''; users.forEach(user => { const expirationDate = new Date(user.expiration_timestamp); const isExpired = expirationDate < new Date(); const row = document.createElement('tr'); row.innerHTML = \`<td>\${user.uuid}</td><td style="color: \${isExpired ? '#f44336' : 'inherit'}">\${expirationDate.toLocaleString()}</td><td>\${user.status}</td><td>\${user.note || ''}</td><td><button class="btn-edit" data-uuid="\${user.uuid}">Edit</button><button class="btn-delete" data-uuid="\${user.uuid}">Delete</button></td>\`; userTableBody.appendChild(row); }); }
        function openModal(mode, user = {}) { userForm.reset(); if (mode === 'edit') { modalTitle.textContent = 'Edit User'; document.getElementById('user-uuid').value = user.uuid; document.getElementById('expiration').value = new Date(user.expiration_timestamp).toISOString().slice(0, 16); document.getElementById('status').value = user.status; document.getElementById('note').value = user.note || ''; } else { modalTitle.textContent = 'Add New User'; document.getElementById('user-uuid').value = ''; const defaultDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); document.getElementById('expiration').value = defaultDate.toISOString().slice(0, 16); document.getElementById('status').value = 'active'; } modal.style.display = 'block'; }
        async function loadUsers() { try { const users = await getUsers(); renderUsers(users); } catch (e) { console.error(e); } }
        document.getElementById('addUserBtn').addEventListener('click', () => openModal('add')); document.querySelector('.close').addEventListener('click', () => modal.style.display = 'none'); window.addEventListener('click', (event) => { if (event.target == modal) modal.style.display = 'none'; });
        userForm.addEventListener('submit', async (e) => { e.preventDefault(); const uuid = document.getElementById('user-uuid').value; const data = { expiration: document.getElementById('expiration').value, status: document.getElementById('status').value, note: document.getElementById('note').value, }; try { if (uuid) { await updateUser(uuid, data); } else { await createUser(data); } modal.style.display = 'none'; loadUsers(); } catch (e) { console.error(e); } });
        userTableBody.addEventListener('click', async (e) => { if (e.target.classList.contains('btn-edit')) { const uuid = e.target.dataset.uuid; const users = await getUsers(); const user = users.find(u => u.uuid === uuid); if (user) openModal('edit', user); } if (e.target.classList.contains('btn-delete')) { const uuid = e.target.dataset.uuid; if (confirm(\`Are you sure you want to delete user \${uuid}?\`)) { try { await deleteUser(uuid); loadUsers(); } catch (e) { console.error(e); } } } });
        loadUsers();
    </script></body></html>`;
}


// --- UTILITY HELPERS ---
function makeReadableWebSocketStream(ws, earlyData, log) {
	return new ReadableStream({
		start(controller) {
			ws.addEventListener('message', e => controller.enqueue(e.data));
			ws.addEventListener('close', () => controller.close());
			ws.addEventListener('error', e => controller.error(e));
			if (earlyData) {
				const decoded = base64ToArrayBuffer(earlyData);
				if (decoded) controller.enqueue(decoded);
			}
		},
		cancel() { safeCloseWebSocket(ws); }
	});
}

async function remoteSocketToWS(remoteSocket, ws, vlessResponse, log) {
	let hasSentData = false;
	await remoteSocket.readable.pipeTo(new WritableStream({
		start() {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(vlessResponse);
				hasSentData = true;
			}
		},
		async write(chunk, controller) {
			if (ws.readyState !== WebSocket.OPEN) controller.error('WebSocket is not open');
			ws.send(chunk);
		},
		close() { log(`Remote socket readable closed`); },
		abort(err) { log(`Remote socket readable aborted`, err); }
	})).catch(err => log('Remote to WS pipe error:', err.message));
	if (!hasSentData && ws.readyState === WebSocket.OPEN) ws.send(vlessResponse);
}

function safeCloseWebSocket(ws) {
	try {
		if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CLOSING) ws.close();
	} catch (e) { console.error('Error closing WebSocket:', e); }
}

function base64ToArrayBuffer(base64) {
	try {
		const binary_string = atob(base64);
		const len = binary_string.length;
		const bytes = new Uint8Array(len);
		for (let i = 0; i < len; i++) bytes[i] = binary_string.charCodeAt(i);
		return bytes.buffer;
	} catch { return null; }
}

const byteToHex = Array.from({ length: 256 }, (v, i) => (i + 256).toString(16).slice(1));
function stringify(arr) {
	return (byteToHex[arr[0]] + byteToHex[arr[1]] + byteToHex[arr[2]] + byteToHex[arr[3]] + '-' + byteToHex[arr[4]] + byteToHex[arr[5]] + '-' + byteToHex[arr[6]] + byteToHex[arr[7]] + '-' + byteToHex[arr[8]] + byteToHex[arr[9]] + '-' + byteToHex[arr[10]] + byteToHex[arr[11]] + byteToHex[arr[12]] + byteToHex[arr[13]] + byteToHex[arr[14]] + byteToHex[arr[15]]).toLowerCase();
}

import { connect } from 'cloudflare:sockets';

// Helper functions (updated for robustness)
/**
 * Generates a standard RFC4122 version 4 UUID.
 * @returns {string} A new UUID.
 */
function generateUUID() {
  return crypto.randomUUID();
}

/**
* Checks if the expiration date and time are in the future.
* Treats the stored time as UTC to prevent timezone ambiguity.
* @param {string} expDate - The expiration date in 'YYYY-MM-DD' format.
* @param {string} expTime - The expiration time in 'HH:MM:SS' format.
* @returns {boolean} - True if the expiration is in the future, otherwise false.
*/
async function checkExpiration(expDate, expTime) {
  if (!expDate || !expTime) return false;
  const expDatetimeUTC = new Date(`${expDate}T${expTime}Z`);
  return expDatetimeUTC > new Date() && !isNaN(expDatetimeUTC);
}

/**
* Retrieves user data from KV cache or falls back to D1 database.
* @param {object} env - The worker environment object.
* @param {string} uuid - The user's UUID.
* @returns {Promise<object|null>} - The user data or null if not found.
*/
async function getUserData(env, uuid) {
  let userData = await env.USER_KV.get(`user:${uuid}`);
  if (userData) {
    try {
      return JSON.parse(userData);
    } catch (e) {
      console.error(`Failed to parse user data from KV for UUID: ${uuid}`, e);
    }
  }

  const query = await env.DB.prepare("SELECT expiration_date, expiration_time FROM users WHERE uuid = ?")
    .bind(uuid)
    .first();

  if (!query) {
    return null;
  }

  userData = { exp_date: query.expiration_date, exp_time: query.expiration_time };
  await env.USER_KV.put(`user:${uuid}`, JSON.stringify(userData), { expirationTtl: 3600 });
  return userData;
}

// --- Admin Security & Panel ---

// HTML for the Admin Login Page
const adminLoginHTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin Login</title>
    <style>
        body { display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background-color: #121212; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
        .login-container { background-color: #1e1e1e; padding: 40px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5); text-align: center; width: 320px; border: 1px solid #333; }
        h1 { color: #ffffff; margin-bottom: 24px; font-weight: 500; }
        form { display: flex; flex-direction: column; }
        input[type="password"] { background-color: #2c2c2c; border: 1px solid #444; color: #ffffff; padding: 12px; border-radius: 8px; margin-bottom: 20px; font-size: 16px; }
        input[type="password"]:focus { outline: none; border-color: #007aff; box-shadow: 0 0 0 2px rgba(0, 122, 255, 0.3); }
        button { background-color: #007aff; color: white; border: none; padding: 12px; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; transition: background-color 0.2s; }
        button:hover { background-color: #005ecb; }
        .error { color: #ff3b30; margin-top: 15px; font-size: 14px; }
    </style>
</head>
<body>
    <div class="login-container">
        <h1>Admin Login</h1>
        <form method="POST" action="/admin">
            <input type="password" name="password" placeholder="••••••••••••••" required>
            <button type="submit">Login</button>
        </form>
        </div>
</body>
</html>`;

// --- FINAL, COMPLETE, AND TIMEZONE-SMART ADMIN PANEL HTML ---
const adminPanelHTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin Dashboard</title>
    <style>
        :root {
            --bg-main: #111827; --bg-card: #1F2937; --border: #374151; --text-primary: #F9FAFB;
            --text-secondary: #9CA3AF; --accent: #3B82F6; --accent-hover: #2563EB; --danger: #EF4444;
            --danger-hover: #DC2626; --success: #22C55E; --expired: #F59E0B; --btn-secondary-bg: #4B5563;
        }
        body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background-color: var(--bg-main); color: var(--text-primary); font-size: 14px; }
        .container { max-width: 1200px; margin: 40px auto; padding: 0 20px; }
        h1, h2 { font-weight: 600; }
        h1 { font-size: 24px; margin-bottom: 20px; }
        h2 { font-size: 18px; border-bottom: 1px solid var(--border); padding-bottom: 10px; margin-bottom: 20px; }
        .card { background-color: var(--bg-card); border-radius: 8px; padding: 24px; border: 1px solid var(--border); box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
        .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; align-items: flex-end; }
        .form-group { display: flex; flex-direction: column; }
        .form-group label { margin-bottom: 8px; font-weight: 500; color: var(--text-secondary); }
        .form-group .input-group { display: flex; }
        input[type="text"], input[type="date"], input[type="time"] {
            width: 100%; box-sizing: border-box; background-color: #374151; border: 1px solid #4B5563; color: var(--text-primary);
            padding: 10px; border-radius: 6px; font-size: 14px; transition: border-color 0.2s;
        }
        input:focus { outline: none; border-color: var(--accent); }
        .label-note { font-size: 11px; color: var(--text-secondary); margin-top: 4px; }
        .btn {
            padding: 10px 16px; border: none; border-radius: 6px; font-weight: 600; cursor: pointer;
            transition: background-color 0.2s, transform 0.1s; display: inline-flex; align-items: center; justify-content: center; gap: 8px;
        }
        .btn:active { transform: scale(0.98); }
        .btn-primary { background-color: var(--accent); color: white; }
        .btn-primary:hover { background-color: var(--accent-hover); }
        .btn-secondary { background-color: var(--btn-secondary-bg); color: white; }
        .btn-secondary:hover { background-color: #6B7280; }
        .btn-danger { background-color: var(--danger); color: white; }
        .btn-danger:hover { background-color: var(--danger-hover); }
        .input-group .btn-secondary { border-top-left-radius: 0; border-bottom-left-radius: 0; }
        .input-group input { border-top-right-radius: 0; border-bottom-right-radius: 0; border-right: none; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th, td { padding: 12px 16px; text-align: left; border-bottom: 1px solid var(--border); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        th { color: var(--text-secondary); font-weight: 600; font-size: 12px; text-transform: uppercase; }
        td { color: var(--text-primary); font-family: "SF Mono", "Fira Code", monospace; }
        .status-badge { padding: 4px 8px; border-radius: 12px; font-size: 12px; font-weight: 600; display: inline-block; }
        .status-active { background-color: var(--success); color: #064E3B; }
        .status-expired { background-color: var(--expired); color: #78350F; }
        .actions-cell .btn { padding: 6px 10px; font-size: 12px; }
        #toast { position: fixed; top: 20px; right: 20px; background-color: var(--bg-card); color: white; padding: 15px 20px; border-radius: 8px; z-index: 1001; display: none; border: 1px solid var(--border); box-shadow: 0 4px 12px rgba(0,0,0,0.3); opacity: 0; transition: opacity 0.3s, transform 0.3s; transform: translateY(-20px); }
        #toast.show { display: block; opacity: 1; transform: translateY(0); }
        #toast.error { border-left: 5px solid var(--danger); }
        #toast.success { border-left: 5px solid var(--success); }
        .uuid-cell { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .btn-copy { background: transparent; border: none; color: var(--text-secondary); padding: 4px; border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .btn-copy:hover { background-color: #374151; color: var(--text-primary); }
        .btn svg, .actions-cell .btn svg { width: 14px; height: 14px; }
        .actions-cell { display: flex; gap: 8px; justify-content: center; }
        .time-display { display: flex; flex-direction: column; }
        .time-local { font-weight: 600; }
        .time-utc, .time-relative { font-size: 11px; color: var(--text-secondary); }
        .modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background-color: rgba(0,0,0,0.7); z-index: 1000; display: flex; justify-content: center; align-items: center; opacity: 0; visibility: hidden; transition: opacity 0.3s, visibility 0.3s; }
        .modal-overlay.show { opacity: 1; visibility: visible; }
        .modal-content { background-color: var(--bg-card); padding: 30px; border-radius: 12px; box-shadow: 0 5px 25px rgba(0,0,0,0.4); width: 90%; max-width: 500px; transform: scale(0.9); transition: transform 0.3s; border: 1px solid var(--border); }
        .modal-overlay.show .modal-content { transform: scale(1); }
        .modal-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); padding-bottom: 15px; margin-bottom: 20px; }
        .modal-header h2 { margin: 0; border: none; font-size: 20px; }
        .modal-close-btn { background: none; border: none; color: var(--text-secondary); font-size: 24px; cursor: pointer; line-height: 1; }
        .modal-footer { display: flex; justify-content: flex-end; gap: 12px; margin-top: 25px; }
        .time-quick-set-group { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
        .btn-outline-secondary {
            background-color: transparent; border: 1px solid var(--btn-secondary-bg); color: var(--text-secondary);
            padding: 6px 10px; font-size: 12px; font-weight: 500;
        }
        .btn-outline-secondary:hover { background-color: var(--btn-secondary-bg); color: white; border-color: var(--btn-secondary-bg); }
        @media (max-width: 768px) {
            tr { border: 1px solid var(--border); border-radius: 8px; display: block; margin-bottom: 1rem; }
            td { border: none; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Admin Dashboard</h1>
        <div class="card">
            <h2>Create User</h2>
            <form id="createUserForm" class="form-grid">
                <div class="form-group" style="grid-column: 1 / -1;"><label for="uuid">UUID</label><div class="input-group"><input type="text" id="uuid" required><button type="button" id="generateUUID" class="btn btn-secondary">Generate</button></div></div>
                <div class="form-group"><label for="expiryDate">Expiry Date</label><input type="date" id="expiryDate" required></div>
                <div class="form-group">
                    <label for="expiryTime">Expiry Time (Your Local Time)</label>
                    <input type="time" id="expiryTime" step="1" required>
                    <div class="label-note">Automatically converted to UTC on save.</div>
                    <div class="time-quick-set-group" data-target-date="expiryDate" data-target-time="expiryTime">
                        <button type="button" class="btn btn-outline-secondary" data-amount="1" data-unit="hour">+1 Hour</button>
                        <button type="button" class="btn btn-outline-secondary" data-amount="1" data-unit="day">+1 Day</button>
                        <button type="button" class="btn btn-outline-secondary" data-amount="7" data-unit="day">+1 Week</button>
                        <button type="button" class="btn btn-outline-secondary" data-amount="1" data-unit="month">+1 Month</button>
                    </div>
                </div>
                <div class="form-group"><label for="notes">Notes</label><input type="text" id="notes" placeholder="(Optional)"></div>
                <div class="form-group"><label>&nbsp;</label><button type="submit" class="btn btn-primary">Create User</button></div>
            </form>
        </div>
        <div class="card" style="margin-top: 30px;">
            <h2>User List</h2>
            <div style="overflow-x: auto;">
                 <table>
                    <thead><tr><th>UUID</th><th>Created</th><th>Expiry (Admin Local)</th><th>Expiry (Tehran)</th><th>Status</th><th>Notes</th><th>Actions</th></tr></thead>
                    <tbody id="userList"></tbody>
                </table>
            </div>
        </div>
    </div>
    <div id="toast"></div>
    <div id="editModal" class="modal-overlay">
        <div class="modal-content">
            <div class="modal-header">
                <h2>Edit User</h2>
                <button id="modalCloseBtn" class="modal-close-btn">&times;</button>
            </div>
            <form id="editUserForm">
                <input type="hidden" id="editUuid" name="uuid">
                <div class="form-group"><label for="editExpiryDate">Expiry Date</label><input type="date" id="editExpiryDate" name="exp_date" required></div>
                <div class="form-group" style="margin-top: 16px;">
                    <label for="editExpiryTime">Expiry Time (Your Local Time)</label>
                    <input type="time" id="editExpiryTime" name="exp_time" step="1" required>
                     <div class="label-note">Your current timezone is used for conversion.</div>
                    <div class="time-quick-set-group" data-target-date="editExpiryDate" data-target-time="editExpiryTime">
                        <button type="button" class="btn btn-outline-secondary" data-amount="1" data-unit="hour">+1 Hour</button>
                        <button type="button" class="btn btn-outline-secondary" data-amount="1" data-unit="day">+1 Day</button>
                        <button type="button" class="btn btn-outline-secondary" data-amount="7" data-unit="day">+1 Week</button>
                        <button type="button" class="btn btn-outline-secondary" data-amount="1" data-unit="month">+1 Month</button>
                    </div>
                </div>
                <div class="form-group" style="margin-top: 16px;"><label for="editNotes">Notes</label><input type="text" id="editNotes" name="notes" placeholder="(Optional)"></div>
                <div class="modal-footer">
                    <button type="button" id="modalCancelBtn" class="btn btn-secondary">Cancel</button>
                    <button type="submit" class="btn btn-primary">Save Changes</button>
                </div>
            </form>
        </div>
    </div>

    <script>
        document.addEventListener('DOMContentLoaded', () => {
            const API_BASE = '/admin/api';
            let allUsers = [];
            const userList = document.getElementById('userList');
            const createUserForm = document.getElementById('createUserForm');
            const generateUUIDBtn = document.getElementById('generateUUID');
            const uuidInput = document.getElementById('uuid');
            const toast = document.getElementById('toast');
            const editModal = document.getElementById('editModal');
            const editUserForm = document.getElementById('editUserForm');

            function showToast(message, isError = false) {
                toast.textContent = message;
                toast.className = isError ? 'error' : 'success';
                toast.classList.add('show');
                setTimeout(() => { toast.classList.remove('show'); }, 3000);
            }

            const api = {
                get: (endpoint) => fetch(\`\${API_BASE}\${endpoint}\`, { credentials: 'include' }).then(handleResponse),
                post: (endpoint, body) => fetch(\`\${API_BASE}\${endpoint}\`, { method: 'POST', credentials: 'include', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) }).then(handleResponse),
                put: (endpoint, body) => fetch(\`\${API_BASE}\${endpoint}\`, { method: 'PUT', credentials: 'include', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) }).then(handleResponse),
                delete: (endpoint) => fetch(\`\${API_BASE}\${endpoint}\`, { method: 'DELETE', credentials: 'include' }).then(handleResponse),
            };

            async function handleResponse(response) {
                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({ error: 'An unknown error occurred.' }));
                    throw new Error(errorData.error || \`Request failed with status \${response.status}\`);
                }
                return response.status === 204 ? null : response.json();
            }

            const pad = (num) => num.toString().padStart(2, '0');

            function localToUTC(dateStr, timeStr) {
                if (!dateStr || !timeStr) return { utcDate: '', utcTime: '' };
                const localDateTime = new Date(\`\${dateStr}T\${timeStr}\`);
                if (isNaN(localDateTime)) return { utcDate: '', utcTime: '' };

                const year = localDateTime.getUTCFullYear();
                const month = pad(localDateTime.getUTCMonth() + 1);
                const day = pad(localDateTime.getUTCDate());
                const hours = pad(localDateTime.getUTCHours());
                const minutes = pad(localDateTime.getUTCMinutes());
                const seconds = pad(localDateTime.getUTCSeconds());

                return {
                    utcDate: \`\${year}-\${month}-\${day}\`,
                    utcTime: \`\${hours}:\${minutes}:\${seconds}\`
                };
            }

            function utcToLocal(utcDateStr, utcTimeStr) {
                if (!utcDateStr || !utcTimeStr) return { localDate: '', localTime: '' };
                const utcDateTime = new Date(\`\${utcDateStr}T\${utcTimeStr}Z\`);
                if (isNaN(utcDateTime)) return { localDate: '', localTime: '' };

                const year = utcDateTime.getFullYear();
                const month = pad(utcDateTime.getMonth() + 1);
                const day = pad(utcDateTime.getDate());
                const hours = pad(utcDateTime.getHours());
                const minutes = pad(utcDateTime.getMinutes());
                const seconds = pad(utcDateTime.getSeconds());

                return {
                    localDate: \`\${year}-\${month}-\${day}\`,
                    localTime: \`\${hours}:\${minutes}:\${seconds}\`
                };
            }

            function addExpiryTime(dateInputId, timeInputId, amount, unit) {
                const dateInput = document.getElementById(dateInputId);
                const timeInput = document.getElementById(timeInputId);

                let date = new Date(\`\${dateInput.value}T\${timeInput.value || '00:00:00'}\`);
                if (isNaN(date.getTime())) {
                    date = new Date();
                }

                if (unit === 'hour') date.setHours(date.getHours() + amount);
                else if (unit === 'day') date.setDate(date.getDate() + amount);
                else if (unit === 'month') date.setMonth(date.getMonth() + amount);

                const year = date.getFullYear();
                const month = pad(date.getMonth() + 1);
                const day = pad(date.getDate());
                const hours = pad(date.getHours());
                const minutes = pad(date.getMinutes());
                const seconds = pad(date.getSeconds());

                dateInput.value = \`\${year}-\${month}-\${day}\`;
                timeInput.value = \`\${hours}:\${minutes}:\${seconds}\`;
            }

            document.body.addEventListener('click', (e) => {
                const target = e.target.closest('.time-quick-set-group button');
                if (!target) return;
                const group = target.closest('.time-quick-set-group');
                addExpiryTime(
                    group.dataset.targetDate,
                    group.dataset.targetTime,
                    parseInt(target.dataset.amount, 10),
                    target.dataset.unit
                );
            });

            function formatExpiryDateTime(expDateStr, expTimeStr) {
                const expiryUTC = new Date(\`\${expDateStr}T\${expTimeStr}Z\`);
                if (isNaN(expiryUTC)) return { local: 'Invalid Date', utc: '', relative: '', tehran: '', isExpired: true };

                const now = new Date();
                const isExpired = expiryUTC < now;

                const commonOptions = {
                    year: 'numeric', month: '2-digit', day: '2-digit',
                    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZoneName: 'short'
                };

                const localTime = expiryUTC.toLocaleString(undefined, commonOptions);
                const tehranTime = expiryUTC.toLocaleString('en-US', { ...commonOptions, timeZone: 'Asia/Tehran' });
                const utcTime = expiryUTC.toISOString().replace('T', ' ').substring(0, 19) + ' UTC';

                const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
                const diffSeconds = (expiryUTC.getTime() - now.getTime()) / 1000;
                let relativeTime = '';
                if (Math.abs(diffSeconds) < 60) relativeTime = rtf.format(Math.round(diffSeconds), 'second');
                else if (Math.abs(diffSeconds) < 3600) relativeTime = rtf.format(Math.round(diffSeconds / 60), 'minute');
                else if (Math.abs(diffSeconds) < 86400) relativeTime = rtf.format(Math.round(diffSeconds / 3600), 'hour');
                else relativeTime = rtf.format(Math.round(diffSeconds / 86400), 'day');

                return { local: localTime, tehran: tehranTime, utc: utcTime, relative: relativeTime, isExpired };
            }

            function renderUsers() {
                userList.innerHTML = '';
                if (allUsers.length === 0) {
                    userList.innerHTML = '<tr><td colspan="7" style="text-align:center;">No users found.</td></tr>';
                } else {
                    allUsers.forEach(user => {
                        const expiry = formatExpiryDateTime(user.expiration_date, user.expiration_time);
                        const row = document.createElement('tr');
                        row.innerHTML = \`
                            <td><div class="uuid-cell" title="\${user.uuid}">\${user.uuid}</div></td>
                            <td>\${new Date(user.created_at).toLocaleString()}</td>
                            <td>
                                <div class="time-display">
                                    <span class="time-local" title="Your Local Time">\${expiry.local}</span>
                                    <span class="time-utc" title="Coordinated Universal Time">\${expiry.utc}</span>
                                    <span class="time-relative">\${expiry.relative}</span>
                                </div>
                            </td>
                             <td>
                                <div class="time-display">
                                    <span class="time-local" title="Tehran Time (GMT+03:30)">\${expiry.tehran}</span>
                                    <span class="time-utc">Asia/Tehran</span>
                                </div>
                            </td>
                            <td><span class="status-badge \${expiry.isExpired ? 'status-expired' : 'status-active'}">\${expiry.isExpired ? 'Expired' : 'Active'}</span></td>
                            <td>\${user.notes || '-'}</td>
                            <td>
                                <div class="actions-cell">
                                    <button class="btn btn-secondary btn-edit" data-uuid="\${user.uuid}">Edit</button>
                                    <button class="btn btn-danger btn-delete" data-uuid="\${user.uuid}">Delete</button>
                                </div>
                            </td>
                        \`;
                        userList.appendChild(row);
                    });
                }
            }

            async function fetchAndRenderUsers() {
                try {
                    allUsers = await api.get('/users');
                    allUsers.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
                    renderUsers();
                } catch (error) { showToast(error.message, true); }
            }

            async function handleCreateUser(e) {
                e.preventDefault();
                const localDate = document.getElementById('expiryDate').value;
                const localTime = document.getElementById('expiryTime').value;

                const { utcDate, utcTime } = localToUTC(localDate, localTime);
                if (!utcDate || !utcTime) return showToast('Invalid date or time entered.', true);

                const userData = {
                    uuid: uuidInput.value,
                    exp_date: utcDate,
                    exp_time: utcTime,
                    notes: document.getElementById('notes').value
                };

                try {
                    await api.post('/users', userData);
                    showToast('User created successfully!');
                    createUserForm.reset();
                    uuidInput.value = crypto.randomUUID();
                    setDefaultExpiry();
                    await fetchAndRenderUsers();
                } catch (error) { showToast(error.message, true); }
            }

            async function handleDeleteUser(uuid) {
                if (confirm(\`Delete user \${uuid}?\`)) {
                    try {
                        await api.delete(\`/users/\${uuid}\`);
                        showToast('User deleted successfully!');
                        await fetchAndRenderUsers();
                    } catch (error) { showToast(error.message, true); }
                }
            }

            function openEditModal(uuid) {
                const user = allUsers.find(u => u.uuid === uuid);
                if (!user) return showToast('User not found.', true);

                const { localDate, localTime } = utcToLocal(user.expiration_date, user.expiration_time);

                document.getElementById('editUuid').value = user.uuid;
                document.getElementById('editExpiryDate').value = localDate;
                document.getElementById('editExpiryTime').value = localTime;
                document.getElementById('editNotes').value = user.notes || '';
                editModal.classList.add('show');
            }

            function closeEditModal() { editModal.classList.remove('show'); }

            async function handleEditUser(e) {
                e.preventDefault();
                const localDate = document.getElementById('editExpiryDate').value;
                const localTime = document.getElementById('editExpiryTime').value;

                const { utcDate, utcTime } = localToUTC(localDate, localTime);
                if (!utcDate || !utcTime) return showToast('Invalid date or time entered.', true);

                const updatedData = {
                    exp_date: utcDate,
                    exp_time: utcTime,
                    notes: document.getElementById('editNotes').value
                };

                try {
                    await api.put(\`/users/\${document.getElementById('editUuid').value}\`, updatedData);
                    showToast('User updated successfully!');
                    closeEditModal();
                    await fetchAndRenderUsers();
                } catch (error) { showToast(error.message, true); }
            }

            function setDefaultExpiry() {
                const now = new Date();
                now.setDate(now.getDate() + 1); // Set expiry to 24 hours from now in LOCAL time

                const year = now.getFullYear();
                const month = pad(now.getMonth() + 1);
                const day = pad(now.getDate());
                const hours = pad(now.getHours());
                const minutes = pad(now.getMinutes());
                const seconds = pad(now.getSeconds());

                document.getElementById('expiryDate').value = \`\${year}-\${month}-\${day}\`;
                document.getElementById('expiryTime').value = \`\${hours}:\${minutes}:\${seconds}\`;
            }

            generateUUIDBtn.addEventListener('click', () => uuidInput.value = crypto.randomUUID());
            createUserForm.addEventListener('submit', handleCreateUser);
            editUserForm.addEventListener('submit', handleEditUser);
            editModal.addEventListener('click', (e) => { if (e.target === editModal) closeEditModal(); });
            document.getElementById('modalCloseBtn').addEventListener('click', closeEditModal);
            document.getElementById('modalCancelBtn').addEventListener('click', closeEditModal);
            userList.addEventListener('click', (e) => {
                const target = e.target.closest('button');
                if (!target) return;
                const uuid = target.dataset.uuid;
                if (target.classList.contains('btn-edit')) openEditModal(uuid);
                else if (target.classList.contains('btn-delete')) handleDeleteUser(uuid);
            });

            setDefaultExpiry();
            uuidInput.value = crypto.randomUUID();
            fetchAndRenderUsers();
        });
    </script>
</body>
</html>`;

async function isAdmin(request, env) {
    const cookieHeader = request.headers.get('Cookie');
    if (!cookieHeader) return false;

    const token = cookieHeader.match(/auth_token=([^;]+)/)?.[1];
    if (!token) return false;

    const storedToken = await env.USER_KV.get('admin_session_token');

    return storedToken && storedToken === token;
}

/**
* --- Handles all incoming requests to /admin/* routes with API routing. ---
* @param {Request} request
* @param {object} env
* @returns {Promise<Response>}
*/
async function handleAdminRequest(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const jsonHeader = { 'Content-Type': 'application/json' };

    if (!env.ADMIN_KEY) {
        return new Response('Admin panel is not configured.', { status: 503 });
    }

    // --- API Routes ---
    if (pathname.startsWith('/admin/api/')) {
        if (!(await isAdmin(request, env))) {
            return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: jsonHeader });
        }
        
        // --- ENHANCEMENT: Basic CSRF protection for mutating requests ---
        if (request.method !== 'GET') {
            const origin = request.headers.get('Origin');
            if (!origin || new URL(origin).hostname !== url.hostname) {
                return new Response(JSON.stringify({ error: 'Invalid Origin' }), { status: 403, headers: jsonHeader });
            }
        }
        
        // GET /admin/api/users - List all users
        if (pathname === '/admin/api/users' && request.method === 'GET') {
            try {
                const { results } = await env.DB.prepare("SELECT uuid, created_at, expiration_date, expiration_time, notes FROM users ORDER BY created_at DESC").all();
                return new Response(JSON.stringify(results ?? []), { status: 200, headers: jsonHeader });
            } catch (e) {
                return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: jsonHeader });
            }
        }

        // POST /admin/api/users - Create a new user
        if (pathname === '/admin/api/users' && request.method === 'POST') {
             try {
                const { uuid, exp_date: expDate, exp_time: expTime, notes } = await request.json();

                // Corrected and clarified validation logic
                if (!uuid || !expDate || !expTime || !/^\d{4}-\d{2}-\d{2}$/.test(expDate) || !/^\d{2}:\d{2}:\d{2}$/.test(expTime)) {
                    throw new Error('Invalid or missing fields. Use UUID, YYYY-MM-DD, and HH:MM:SS.');
                }
                 
                await env.DB.prepare("INSERT INTO users (uuid, expiration_date, expiration_time, notes) VALUES (?, ?, ?, ?)")
                    .bind(uuid, expDate, expTime, notes || null).run();
                await env.USER_KV.put(`user:${uuid}`, JSON.stringify({ exp_date: expDate, exp_time: expTime }));
                 
                return new Response(JSON.stringify({ success: true, uuid }), { status: 201, headers: jsonHeader });
            } catch (error) {
                 if (error.message?.includes('UNIQUE constraint failed')) {
                     return new Response(JSON.stringify({ error: 'A user with this UUID already exists.' }), { status: 409, headers: jsonHeader });
                 }
                 return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: jsonHeader });
            }
        }
         
        // POST /admin/api/users/bulk-delete - Efficiently delete multiple users
        if (pathname === '/admin/api/users/bulk-delete' && request.method === 'POST') {
            try {
                const { uuids } = await request.json();
                if (!Array.isArray(uuids) || uuids.length === 0) {
                    throw new Error('Invalid request body: Expected an array of UUIDs.');
                }
                 
                const deleteUserStmt = env.DB.prepare("DELETE FROM users WHERE uuid = ?");
                const stmts = uuids.map(uuid => deleteUserStmt.bind(uuid));
                await env.DB.batch(stmts);

                // Delete from KV in parallel for speed
                await Promise.all(uuids.map(uuid => env.USER_KV.delete(`user:${uuid}`)));
                 
                return new Response(JSON.stringify({ success: true, count: uuids.length }), { status: 200, headers: jsonHeader });
            } catch (error) {
                return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: jsonHeader });
            }
        }

        // Matcher for single-user routes
        const userRouteMatch = pathname.match(/^\/admin\/api\/users\/([a-f0-9-]+)$/);

        // PUT /admin/api/users/:uuid - Update a single user
        if (userRouteMatch && request.method === 'PUT') {
            const uuid = userRouteMatch[1];
            try {
                const { exp_date: expDate, exp_time: expTime, notes } = await request.json();
                if (!expDate || !expTime || !/^\d{4}-\d{2}-\d{2}$/.test(expDate) || !/^\d{2}:\d{2}:\d{2}$/.test(expTime)) {
                    throw new Error('Invalid date/time fields. Use YYYY-MM-DD and HH:MM:SS.');
                }
                 
                await env.DB.prepare("UPDATE users SET expiration_date = ?, expiration_time = ?, notes = ? WHERE uuid = ?")
                    .bind(expDate, expTime, notes || null, uuid).run();
                await env.USER_KV.put(`user:${uuid}`, JSON.stringify({ exp_date: expDate, exp_time: expTime }));
                 
                return new Response(JSON.stringify({ success: true, uuid }), { status: 200, headers: jsonHeader });
            } catch (error) {
                return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: jsonHeader });
            }
        }
         
        // DELETE /admin/api/users/:uuid - Delete a single user
        if (userRouteMatch && request.method === 'DELETE') {
            const uuid = userRouteMatch[1];
             try {
                await env.DB.prepare("DELETE FROM users WHERE uuid = ?").bind(uuid).run();
                await env.USER_KV.delete(`user:${uuid}`);
                return new Response(JSON.stringify({ success: true, uuid }), { status: 200, headers: jsonHeader });
            } catch (error) {
                return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: jsonHeader });
            }
        }
         
        return new Response(JSON.stringify({ error: 'API route not found' }), { status: 404, headers: jsonHeader });
    }

    // --- Page Serving Routes (/admin) ---
    if (pathname === '/admin') {
        if (request.method === 'POST') {
            const formData = await request.formData();
            if (formData.get('password') === env.ADMIN_KEY) {
                const token = crypto.randomUUID();
                await env.USER_KV.put('admin_session_token', token, { expirationTtl: 86400 }); // 24 hour session
                return new Response(null, {
                    status: 302,
                    headers: { 'Location': '/admin', 'Set-Cookie': `auth_token=${token}; HttpOnly; Secure; Path=/admin; Max-Age=86400; SameSite=Strict` },
                });
            } else {
                const loginPageWithError = adminLoginHTML.replace('</form>', '</form><p class="error">Invalid password.</p>');
                return new Response(loginPageWithError, { status: 401, headers: { 'Content-Type': 'text/html;charset=utf-8' } });
            }
        }
         
        if (request.method === 'GET') {
            return new Response(await isAdmin(request, env) ? adminPanelHTML : adminLoginHTML, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
        }
         
        return new Response('Method Not Allowed', { status: 405 });
    }

    return new Response('Not found', { status: 404 });
}


// --- Original Code (Config, Handlers, etc.) ---
const Config = {
  userID: 'd342d11e-d424-4583-b36e-524ab1f0afa4',
  proxyIPs: ['nima.nscl.ir:443'],
  scamalytics: {
    username: 'revilseptember',
    apiKey: 'b2fc368184deb3d8ac914bd776b8215fe899dd8fef69fbaba77511acfbdeca0d',
    baseUrl: 'https://api12.scamalytics.com/v3/',
  },
  socks5: {
    enabled: false,
    relayMode: false,
    address: '',
  },
  fromEnv(env) {
    const selectedProxyIP = env.PROXYIP || this.proxyIPs[Math.floor(Math.random() * this.proxyIPs.length)];
    const [proxyHost, proxyPort = '443'] = selectedProxyIP.split(':');
    return {
      userID: env.UUID || this.userID,
      proxyIP: proxyHost,
      proxyPort: proxyPort,
      proxyAddress: selectedProxyIP,
      scamalytics: {
        username: env.SCAMALYTICS_USERNAME || this.scamalytics.username,
        apiKey: env.SCAMALYTICS_API_KEY || this.scamalytics.apiKey,
        baseUrl: env.SCAMALYTICS_BASEURL || this.scamalytics.baseUrl,
      },
      socks5: {
        enabled: !!env.SOCKS5,
        relayMode: env.SOCKS5_RELAY === 'true' || this.socks5.relayMode,
        address: env.SOCKS5 || this.socks5.address,
      },
    };
  },
};

const CONST = {
  ED_PARAMS: { ed: 2560, eh: 'Sec-WebSocket-Protocol' },
  AT_SYMBOL: '@',
  VLESS_PROTOCOL: 'vless',
  WS_READY_STATE_OPEN: 1,
  WS_READY_STATE_CLOSING: 2,
};

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
    tls: { path: () => generateRandomPath(18), security: 'tls', fp: 'firefox', alpn: 'h3', extra: CONST.ED_PARAMS },
    tcp: { path: () => generateRandomPath(18), security: 'none', fp: 'firefox', extra: CONST.ED_PARAMS },
  },
};

function makeName(tag, proto) {
  return `${tag}-${proto.toUpperCase()}`;
}

function createVlessLink({ userID, address, port, host, path, security, sni, fp, alpn, extra = {}, name }) {
  const params = new URLSearchParams({
    type: 'ws',
    host,
    path,
  });
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
    'sky.rethinkdns.com', 'cfip.1323123.xyz', 'cfip.xxxxxxxx.tk',
    'go.inmobi.com', 'singapore.com', 'www.visa.com',
    'cf.090227.xyz', 'cdnjs.com', 'zula.ir',
  ];

  const httpsPorts = [443, 8443, 2053, 2083, 2087, 2096];
  const httpPorts = [80, 8080, 8880, 2052, 2082, 2086, 2095];

  let links = [];

  const isPagesDeployment = hostName.endsWith('.pages.dev');

  mainDomains.forEach((domain, i) => {
    links.push(
      buildLink({ core, proto: 'tls', userID, hostName, address: domain, port: pick(httpsPorts), tag: `D${i+1}` })
    );

    if (!isPagesDeployment) {
      links.push(
        buildLink({ core, proto: 'tcp', userID, hostName, address: domain, port: pick(httpPorts), tag: `D${i+1}` })
      );
    }
  });

  try {
    const r = await fetch('https://raw.githubusercontent.com/NiREvil/vless/refs/heads/main/Cloudflare-IPs.json');
    if (r.ok) {
      const json = await r.json();
      const ips = [...(json.ipv4 ?? []), ...(json.ipv6 ?? [])].slice(0, 20).map(x => x.ip);
      ips.forEach((ip, i) => {
        const formattedAddress = ip.includes(':') ? `[${ip}]` : ip;
        links.push(
          buildLink({ core, proto: 'tls', userID, hostName, address: formattedAddress, port: pick(httpsPorts), tag: `IP${i+1}` })
        );

        if (!isPagesDeployment) {
          links.push(
            buildLink({ core, proto: 'tcp', userID, hostName, address: formattedAddress, port: pick(httpPorts), tag: `IP${i+1}` })
          );
        }
      });
    }
  } catch (e) { console.error('Fetch IP list failed', e); }

  return new Response(btoa(links.join('\n')), {
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
  });
}

export default {
  async fetch(request, env, ctx) {
    const cfg = Config.fromEnv(env);
    const url = new URL(request.url);

    if (url.pathname.startsWith('/admin')) {
      return handleAdminRequest(request, env);
    }

    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader?.toLowerCase() === 'websocket') {
      const requestConfig = {
        userID: cfg.userID,
        proxyIP: cfg.proxyIP,
        proxyPort: cfg.proxyPort,
        socks5Address: cfg.socks5.address,
        socks5Relay: cfg.socks5.relayMode,
        enableSocks: cfg.socks5.enabled,
        parsedSocks5Address: cfg.socks5.enabled ? socks5AddressParser(cfg.socks5.address) : {},
      };
      return await ProtocolOverWSHandler(request, requestConfig, env);
    }

    if (url.pathname === '/scamalytics-lookup') {
        return handleScamalyticsLookup(request, cfg);
    }

    const handleSubscription = async (core) => {
      const uuid = url.pathname.slice(`/${core}/`.length);
      if (!isValidUUID(uuid)) return new Response('Invalid UUID', { status: 400 });
      const userData = await getUserData(env, uuid);
      if (!userData || !(await checkExpiration(userData.exp_date, userData.exp_time))) {
        return new Response('Invalid or expired user', { status: 403 });
      }
      return handleIpSubscription(core, uuid, url.hostname);
    };

    if (url.pathname.startsWith('/xray/')) {
      return handleSubscription('xray');
    }

    if (url.pathname.startsWith('/sb/')) {
      return handleSubscription('sb');
    }

    const path = url.pathname.slice(1);
    if (isValidUUID(path)) {
      const userData = await getUserData(env, path);
      if (!userData || !(await checkExpiration(userData.exp_date, userData.exp_time))) {
        return new Response('Invalid or expired user', { status: 403 });
      }
      return handleConfigPage(path, url.hostname, cfg.proxyAddress, userData.exp_date, userData.exp_time);
    }
     
    if (env.ROOT_PROXY_URL) {
      try {
        const proxyUrl = new URL(env.ROOT_PROXY_URL);
        const targetUrl = new URL(request.url);

        targetUrl.hostname = proxyUrl.hostname;
        targetUrl.protocol = proxyUrl.protocol;
        targetUrl.port = proxyUrl.port;
         
        const newRequest = new Request(targetUrl, request);
         
        newRequest.headers.set('Host', proxyUrl.hostname);
        newRequest.headers.set('X-Forwarded-For', request.headers.get('CF-Connecting-IP'));
        newRequest.headers.set('X-Forwarded-Proto', 'https');
         
        const response = await fetch(newRequest);
         
        const mutableHeaders = new Headers(response.headers);
        mutableHeaders.delete('Content-Security-Policy');
        mutableHeaders.delete('Content-Security-Policy-Report-Only');
        mutableHeaders.delete('X-Frame-Options');

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: mutableHeaders
        });

      } catch (e) {
        console.error(`Reverse Proxy Error: ${e.message}`);
        return new Response(`Proxy configuration error or upstream server is down. Please check the ROOT_PROXY_URL variable. Error: ${e.message}`, { status: 502 });
      }
    }

    return new Response('Not found', { status: 404 });
  },
};

async function ProtocolOverWSHandler(request, config, env) {
  const webSocketPair = new WebSocketPair();
  const [client, webSocket] = Object.values(webSocketPair);
  webSocket.accept();
  let address = '';
  let portWithRandomLog = '';
  let udpStreamWriter = null;
  const log = (info, event) => {
    console.log(`[${address}:${portWithRandomLog}] ${info}`, event || '');
  };
  const earlyDataHeader = request.headers.get('Sec-WebSocket-Protocol') || '';
  const readableWebSocketStream = MakeReadableWebSocketStream(webSocket, earlyDataHeader, log);
  let remoteSocketWapper = { value: null };
  let isDns = false;

  readableWebSocketStream
    .pipeTo(
      new WritableStream({
        async write(chunk, controller) {
          if (udpStreamWriter) {
            return udpStreamWriter.write(chunk);
          }

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
            ProtocolVersion = new Uint8Array([0, 0]),
            isUDP,
          } = await ProcessProtocolHeader(chunk, env);

          address = addressRemote;
          portWithRandomLog = `${portRemote}--${Math.random()} ${isUDP ? 'udp' : 'tcp'}` ;

          if (hasError) {
            controller.error(message);
            return;
          }

          const vlessResponseHeader = new Uint8Array([ProtocolVersion[0], 0]);
          const rawClientData = chunk.slice(rawDataIndex);

          if (isUDP) {
            if (portRemote === 53) {
              const dnsPipeline = await createDnsPipeline(webSocket, vlessResponseHeader, log);
              udpStreamWriter = dnsPipeline.write;
              await udpStreamWriter(rawClientData);
            } else {
              controller.error('UDP proxy only for DNS (port 53)');
            }
            return;
          }

          HandleTCPOutBound(
            remoteSocketWapper,
            addressType,
            addressRemote,
            portRemote,
            rawClientData,
            webSocket,
            vlessResponseHeader,
            log,
            config,
          );
        },
        close() {
          log('readableWebSocketStream closed');
        },
        abort(err) {
          log('readableWebSocketStream aborted', err);
        },
      }),
    )
    .catch(err => {
      console.error('Pipeline failed:', err.stack || err);
    });

  return new Response(null, { status: 101, webSocket: client });
}

async function ProcessProtocolHeader(protocolBuffer, env) {
  if (protocolBuffer.byteLength < 24) return { hasError: true, message: 'invalid data' };

  const dataView = new DataView(protocolBuffer);
  const version = dataView.getUint8(0);
  const slicedBufferString = stringify(new Uint8Array(protocolBuffer.slice(1, 17)));

  const userData = await getUserData(env, slicedBufferString);

  if (!userData || !(await checkExpiration(userData.exp_date, userData.exp_time))) {
    return { hasError: true, message: 'invalid or expired user' };
  }

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
      addressValue = Array.from({ length: 8 }, (_, i) => dataView.getUint16(addressValueIndex + i * 2).toString(16)).join(':');
      break;
    default:
      return { hasError: true, message: `invalid addressType: ${addressType}` };
  }

  if (!addressValue) return { hasError: true, message: `addressValue is empty, addressType is ${addressType}` };

  return {
    hasError: false,
    addressRemote: addressValue,
    addressType,
    portRemote,
    rawDataIndex: addressValueIndex + addressLength,
    ProtocolVersion: new Uint8Array([version]),
    isUDP: command === 2,
  };
}

async function HandleTCPOutBound(
  remoteSocket,
  addressType,
  addressRemote,
  portRemote,
  rawClientData,
  webSocket,
  protocolResponseHeader,
  log,
  config,
) {
  async function connectAndWrite(address, port, socks = false) {
    let tcpSocket;
    if (config.socks5Relay) {
      tcpSocket = await socks5Connect(addressType, address, port, log, config.parsedSocks5Address);
    } else {
      tcpSocket = socks
        ? await socks5Connect(addressType, address, port, log, config.parsedSocks5Address)
        : connect({ hostname: address, port: port });
    }
    remoteSocket.value = tcpSocket;
    log(`connected to ${address}:${port}`);
    const writer = tcpSocket.writable.getWriter();
    await writer.write(rawClientData);
    writer.releaseLock();
    return tcpSocket;
  }

  async function retry() {
    const tcpSocket = config.enableSocks
      ? await connectAndWrite(addressRemote, portRemote, true)
      : await connectAndWrite(
          config.proxyIP || addressRemote,
          config.proxyPort || portRemote,
          false,
        );

    tcpSocket.closed
      .catch(error => {
        console.log('retry tcpSocket closed error', error);
      })
      .finally(() => {
        safeCloseWebSocket(webSocket);
      });
    RemoteSocketToWS(tcpSocket, webSocket, protocolResponseHeader, null, log);
  }

  const tcpSocket = await connectAndWrite(addressRemote, portRemote);
  RemoteSocketToWS(tcpSocket, webSocket, protocolResponseHeader, retry, log);
}

function MakeReadableWebSocketStream(webSocketServer, earlyDataHeader, log) {
  return new ReadableStream({
    start(controller) {
      webSocketServer.addEventListener('message', (event) => controller.enqueue(event.data));
      webSocketServer.addEventListener('close', () => {
        safeCloseWebSocket(webSocketServer);
        controller.close();
      });
      webSocketServer.addEventListener('error', (err) => {
        log('webSocketServer has error');
        controller.error(err);
      });
      const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
      if (error) controller.error(error);
      else if (earlyData) controller.enqueue(earlyData);
    },
    pull(_controller) { },
    cancel(reason) {
      log(`ReadableStream was canceled, due to ${reason}`);
      safeCloseWebSocket(webSocketServer);
    },
  });
}

async function RemoteSocketToWS(remoteSocket, webSocket, protocolResponseHeader, retry, log) {
  let hasIncomingData = false;
  try {
    await remoteSocket.readable.pipeTo(
      new WritableStream({
        async write(chunk) {
          if (webSocket.readyState !== CONST.WS_READY_STATE_OPEN)
            throw new Error('WebSocket is not open');
          hasIncomingData = true;
          const dataToSend = protocolResponseHeader
            ? await new Blob([protocolResponseHeader, chunk]).arrayBuffer()
            : chunk;
          webSocket.send(dataToSend);
          protocolResponseHeader = null;
        },
        close() {
          log(`Remote connection readable closed. Had incoming data: ${hasIncomingData}`);
        },
        abort(reason) {
          console.error('Remote connection readable aborted:', reason);
        },
      }),
    );
  } catch (error) {
    console.error('RemoteSocketToWS error:', error.stack || error);
    safeCloseWebSocket(webSocket);
  }
  if (!hasIncomingData && retry) {
    log('No incoming data, retrying');
    retry();
  }
}

function base64ToArrayBuffer(base64Str) {
  if (!base64Str) return { earlyData: null, error: null };
  try {
    const binaryStr = atob(base64Str.replace(/-/g, '+').replace(/_/g, '/'));
    const buffer = new ArrayBuffer(binaryStr.length);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < binaryStr.length; i++) {
      view[i] = binaryStr.charCodeAt(i);
    }
    return { earlyData: buffer, error: null };
  } catch (error) {
    return { earlyData: null, error };
  }
}

function safeCloseWebSocket(socket) {
  try {
    if (
      socket.readyState === CONST.WS_READY_STATE_OPEN ||
      socket.readyState === CONST.WS_READY_STATE_CLOSING
    ) {
      socket.close();
    }
  } catch (error) {
    console.error('safeCloseWebSocket error:', error);
  }
}

const byteToHex = Array.from({ length: 256 }, (_, i) => (i + 0x100).toString(16).slice(1));

function unsafeStringify(arr, offset = 0) {
  return (
    byteToHex[arr[offset]] +
    byteToHex[arr[offset + 1]] +
    byteToHex[arr[offset + 2]] +
    byteToHex[arr[offset + 3]] +
    '-' +
    byteToHex[arr[offset + 4]] +
    byteToHex[arr[offset + 5]] +
    '-' +
    byteToHex[arr[offset + 6]] +
    byteToHex[arr[offset + 7]] +
    '-' +
    byteToHex[arr[offset + 8]] +
    byteToHex[arr[offset + 9]] +
    '-' +
    byteToHex[arr[offset + 10]] +
    byteToHex[arr[offset + 11]] +
    byteToHex[arr[offset + 12]] +
    byteToHex[arr[offset + 13]] +
    byteToHex[arr[offset + 14]] +
    byteToHex[arr[offset + 15]]
  ).toLowerCase();
}

function stringify(arr, offset = 0) {
  const uuid = unsafeStringify(arr, offset);
  if (!isValidUUID(uuid)) throw new TypeError('Stringified UUID is invalid');
  return uuid;
}

async function createDnsPipeline(webSocket, vlessResponseHeader, log) {
  let isHeaderSent = false;
  const transformStream = new TransformStream({
    transform(chunk, controller) {
      for (let index = 0; index < chunk.byteLength;) {
        const lengthBuffer = chunk.slice(index, index + 2);
        const udpPacketLength = new DataView(lengthBuffer).getUint16(0);
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
            const resp = await fetch('https://1.1.1.1/dns-query', {
              method: 'POST',
              headers: { 'content-type': 'application/dns-message' },
              body: chunk,
            });
            const dnsQueryResult = await resp.arrayBuffer();
            const udpSize = dnsQueryResult.byteLength;
            const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);

            if (webSocket.readyState === CONST.WS_READY_STATE_OPEN) {
              log(`DNS query successful, length: ${udpSize}`);
              if (isHeaderSent) {
                webSocket.send(await new Blob([udpSizeBuffer, dnsQueryResult]).arrayBuffer());
              } else {
                webSocket.send(
                  await new Blob([
                    vlessResponseHeader,
                    udpSizeBuffer,
                    dnsQueryResult,
                  ]).arrayBuffer(),
                );
                isHeaderSent = true;
              }
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

async function socks5Connect(addressType, addressRemote, portRemote, log, parsedSocks5Addr) {
  const { username, password, hostname, port } = parsedSocks5Addr;
  const socket = connect({ hostname, port });
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const encoder = new TextEncoder();

  await writer.write(new Uint8Array([5, 2, 0, 2])); // SOCKS5 greeting
  let res = (await reader.read()).value;
  if (res[0] !== 0x05 || res[1] === 0xff) throw new Error('SOCKS5 server connection failed.');

  if (res[1] === 0x02) {
    // Auth required
    if (!username || !password) throw new Error('SOCKS5 auth credentials not provided.');
    const authRequest = new Uint8Array([
      1,
      username.length,
      ...encoder.encode(username),
      password.length,
      ...encoder.encode(password),
    ]);
    await writer.write(authRequest);
    res = (await reader.read()).value;
    if (res[0] !== 0x01 || res[1] !== 0x00) throw new Error('SOCKS5 authentication failed.');
  }

  let DSTADDR;
  switch (addressType) {
    case 1:
      DSTADDR = new Uint8Array([1, ...addressRemote.split('.').map(Number)]);
      break;
    case 2:
      DSTADDR = new Uint8Array([3, addressRemote.length, ...encoder.encode(addressRemote)]);
      break;
    case 3:
      DSTADDR = new Uint8Array([
        4,
        ...addressRemote
          .split(':')
          .flatMap((x) => [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2), 16)]),
      ]);
      break;
    default:
      throw new Error(`Invalid addressType for SOCKS5: ${addressType}`);
  }

  const socksRequest = new Uint8Array([5, 1, 0, ...DSTADDR, portRemote >> 8, portRemote & 0xff]);
  await writer.write(socksRequest);
  res = (await reader.read()).value;
  if (res[1] !== 0x00) throw new Error('Failed to open SOCKS5 connection.');

  writer.releaseLock();
  reader.releaseLock();
  return socket;
}

function socks5AddressParser(address) {
  try {
    const [authPart, hostPart] = address.includes('@') ? address.split('@') : [null, address];
    const [hostname, portStr] = hostPart.split(':');
    const port = parseInt(portStr, 10);
    if (!hostname || isNaN(port)) throw new Error();

    let username, password;
    if (authPart) {
      [username, password] = authPart.split(':');
      if (!username) throw new Error();
    }
    return { username, password, hostname, port };
  } catch {
    throw new Error('Invalid SOCKS5 address format. Expected [user:pass@]host:port');
  }
}

function isValidUUID(uuid) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
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

function handleConfigPage(userID, hostName, proxyAddress, expDate, expTime) {
  const html = generateBeautifulConfigPage(userID, hostName, proxyAddress, expDate, expTime);
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function generateBeautifulConfigPage(userID, hostName, proxyAddress, expDate = '', expTime = '') {
  const dream = buildLink({
    core: 'xray', proto: 'tls', userID, hostName,
    address: hostName, port: 443, tag: `${hostName}-Xray`,
  });

  const freedom = buildLink({
    core: 'sb',   proto: 'tls', userID, hostName,
    address: hostName, port: 443, tag: `${hostName}-Singbox`,
  });
  
  const subXrayUrl = `https://${hostName}/xray/${userID}`;
  const subSbUrl   = `https://${hostName}/sb/${userID}`;
  const subClashUrl = `https://revil-sub.pages.dev/sub/clash-meta?url=${encodeURIComponent(subSbUrl)}`;

  const configs = { dream, freedom };

  // Generate universal and app-specific deep links
  const clientUrls = {
    android: `intent:${subXrayUrl}#Intent;action=android.intent.action.VIEW;scheme=https;end;`,
    v2rayng: `v2rayng://install-config?url=${encodeURIComponent(subXrayUrl)}`,
    hiddify: `hiddify://install-config?url=${encodeURIComponent(subXrayUrl)}`,
    nekobox: `nekobox://install-config?url=${encodeURIComponent(subXrayUrl)}`,
    clashmeta: `clash://install-config?url=${encodeURIComponent(subClashUrl)}`,
    shadowrocket: `shadowrocket://add/sub://${btoa(subXrayUrl)}?remark=${encodeURIComponent('REvil-Sub')}`,
    stash: `stash://install-config?url=${encodeURIComponent(subClashUrl)}`,
    foox: `foox://add-subscription?url=${encodeURIComponent(subXrayUrl)}`,
  };

  let expirationBlock = '';
  if (expDate && expTime) {
      const utcTimestamp = `${expDate}T${expTime.split('.')[0]}Z`;
      expirationBlock = `<p id="expiration-display" data-utc-time="${utcTimestamp}">Loading expiration time...</p>`;
  } else {
      expirationBlock = '<p id="expiration-display">No expiration date set.</p>';
  }

  const finalHTML = `<!doctype html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>VLESS Proxy Configuration</title>
    <link rel="icon" href="https://raw.githubusercontent.com/NiREvil/zizifn/refs/heads/Legacy/assets/favicon.png" type="image/png">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@300..700&display=swap" rel="stylesheet">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
    <style>${getPageCSS()}</style> 
  </head>
  <body data-proxy-ip="${proxyAddress}" data-sub-link="${subXrayUrl}">
    ${getPageHTML(configs, clientUrls)}
    <script>${getPageScript()}</script>
  </body>
  </html>`.replace(
    '<p>Copy the configuration or import directly into your client</p>', 
    `<p>Copy the configuration or import directly into your client</p>${expirationBlock}`
  );

  return finalHTML;
}

function getPageCSS() {
  return `
      :root {
        --background-primary: #2a2421; --background-secondary: #35302c; --background-tertiary: #413b35;
        --border-color: #5a4f45; --border-color-hover: #766a5f; --text-primary: #e5dfd6; --text-secondary: #b3a89d;
        --text-accent: #ffffff; --accent-primary: #be9b7b; --accent-secondary: #d4b595; --accent-tertiary: #8d6e5c;
        --accent-primary-darker: #8a6f56; --button-text-primary: #2a2421; --button-text-secondary: var(--text-primary);
        --shadow-color: rgba(0, 0, 0, 0.35); --shadow-color-accent: rgba(190, 155, 123, 0.4);
        --border-radius: 8px; --transition-speed: 0.2s;
        --status-success: #70b570; --status-error: #e05d44; --status-warning: #e0bc44; --status-info: #4f90c4;
        --serif: "Aldine 401 BT Web", "Times New Roman", Times, Georgia, ui-serif, serif;
        --sans-serif: "Styrene B LC", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, "Noto Color Emoji", sans-serif;
        --mono-serif: "Fira Code", Cantarell, "Courier Prime", monospace;
      }
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body {
        font-family: var(--sans-serif); font-size: 16px; background-color: var(--background-primary); color: var(--text-primary);
        padding: 2rem 1rem; line-height: 1.5; -webkit-font-smoothing: antialiased;
      }
      .container { max-width: 800px; margin: 0 auto; }
      .header { text-align: center; margin-bottom: 2.5rem; }
      .header h1 { font-family: var(--serif); font-weight: 400; font-size: 2.25rem; color: var(--text-accent); margin-bottom: 0.25rem; }
      .header p { color: var(--text-secondary); }
      #expiration-display { font-size: 0.9em; text-align: center; color: var(--text-secondary); margin-top: 8px; }
      #expiration-display span { display: block; margin-top: 4px; font-size: 0.9em; }
      #expiration-display strong { color: var(--text-primary); }
      .config-card {
        background: var(--background-secondary); border-radius: var(--border-radius); padding: 1.5rem; margin-bottom: 1.5rem;
        border: 1px solid var(--border-color); transition: all var(--transition-speed) ease;
      }
      .config-title {
        font-family: var(--serif); font-size: 1.5rem; color: var(--accent-secondary); margin-bottom: 1rem;
        padding-bottom: 0.75rem; border-bottom: 1px solid var(--border-color);
        display: flex; align-items: center; justify-content: space-between;
      }
      .button, button {
        display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 8px 16px;
        border-radius: var(--border-radius); font-size: 1rem; font-weight: 500; cursor: pointer;
        border: 1px solid var(--border-color); background-color: var(--background-tertiary); color: var(--button-text-secondary);
        transition: all var(--transition-speed) ease; text-decoration: none; user-select: none;
      }
      .button:hover, button:hover { border-color: var(--border-color-hover); background-color: #4d453e; }
      .button:active, button:active { transform: scale(0.98); }
      .client-buttons { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 0.75rem; margin-top: 1rem; }
      .client-btn {
        width: 100%; background-color: var(--accent-primary); color: var(--button-text-primary);
        border-color: var(--accent-primary-darker);
      }
      .client-btn:hover { background-color: var(--accent-secondary); border-color: var(--accent-secondary); }
      .client-icon { width: 20px; height: 20px; }
      .universal-btn {
          background: linear-gradient(135deg, var(--accent-secondary), var(--accent-primary));
          color: var(--button-text-primary); border: none; font-weight: 600;
          grid-column: 1 / -1; font-size: 1.1rem; padding: 12px 16px;
      }
      .universal-btn:hover { box-shadow: 0 0 15px rgba(190, 155, 123, 0.5); transform: translateY(-2px); }
      .config-content { background: var(--background-tertiary); border-radius: var(--border-radius); padding: 1rem; margin: 1rem 0; }
      .config-content pre { overflow-x: auto; font-family: var(--mono-serif); font-size: 0.8rem; color: var(--text-primary); white-space: pre-wrap; word-break: break-all; }
      .ip-info-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1.5rem; }
      .ip-info-section { background-color: var(--background-tertiary); border-radius: var(--border-radius); padding: 1rem; }
      .ip-info-header { display: flex; align-items: center; gap: 10px; border-bottom: 1px solid var(--border-color); padding-bottom: 0.5rem; margin-bottom: 0.75rem; }
      .ip-info-header h3 { font-family: var(--serif); font-size: 1.25rem; color: var(--accent-secondary); }
      .ip-info-item { margin-bottom: 0.5rem; }
      .ip-info-item .label { font-size: 0.75rem; color: var(--text-secondary); text-transform: uppercase; }
      .ip-info-item .value { font-size: 1rem; word-break: break-all; }
      .badge { display: inline-block; padding: 3px 8px; border-radius: 12px; font-size: 0.75rem; font-weight: 500; }
      .badge-yes { background-color: rgba(112, 181, 112, 0.2); color: #8de98d; }
      .badge-no { background-color: rgba(224, 93, 68, 0.2); color: #ff8b7d; }
      .badge-warning { background-color: rgba(224, 188, 68, 0.2); color: #ffdf85; }
      .skeleton { display: inline-block; background: linear-gradient(90deg, var(--background-tertiary) 25%, #4a423c 50%, var(--background-tertiary) 75%); background-size: 200% 100%; animation: loading 1.5s infinite; border-radius: 4px; height: 1em; width: 120px; }
      @keyframes loading { to { background-position: -200% 0; } }
      .country-flag { display: inline-block; width: 1.2em; height: 0.9em; margin-right: 0.5em; vertical-align: middle; border-radius: 2px; }
      /* iOS Modal Styles */
      .ios-modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.7); z-index: 1000; display: flex; justify-content: center; align-items: center; opacity: 0; visibility: hidden; transition: opacity 0.3s; }
      .ios-modal-overlay.show { opacity: 1; visibility: visible; }
      .ios-modal { background: var(--background-secondary); padding: 2rem; border-radius: var(--border-radius); border: 1px solid var(--border-color); width: 90%; max-width: 400px; text-align: center; }
      .ios-modal h2 { font-family: var(--serif); margin-bottom: 1.5rem; color: var(--accent-secondary); }
      .ios-modal .client-buttons { grid-template-columns: 1fr; }
      .footer { text-align: center; margin-top: 3rem; color: var(--text-secondary); font-size: 0.8rem; }
  `;
}

function getPageHTML(configs, clientUrls) {
  return `
    <div id="ios-modal" class="ios-modal-overlay">
      <div class="ios-modal">
        <h2 id="ios-modal-title">Add Subscription to iOS</h2>
        <div class="client-buttons">
          <a href="${clientUrls.shadowrocket}" class="button client-btn">Import to Shadowrocket</a>
          <a href="${clientUrls.stash}" class="button client-btn">Import to Stash</a>
          <a href="${clientUrls.foox}" class="button client-btn">Import to Foox</a>
        </div>
        <button id="ios-modal-close" class="button" style="margin-top: 1.5rem; background-color: var(--background-tertiary);">Close</button>
      </div>
    </div>

    <div class="container">
      <div class="header">
        <h1>VLESS Proxy Configuration</h1>
        <p>Copy the configuration or import directly into your client</p>
      </div>

      <div class="config-card">
        <div class="config-title"><span>Network Information</span><button id="refresh-ip-info" class="button">Refresh</button></div>
        <div class="ip-info-grid">
          <div class="ip-info-section">
            <div class="ip-info-header"><h3>Proxy Server</h3></div>
            <div class="ip-info-item"><span class="label">Proxy Host</span><span class="value" id="proxy-host"><span class="skeleton"></span></span></div>
            <div class="ip-info-item"><span class="label">IP Address</span><span class="value" id="proxy-ip"><span class="skeleton"></span></span></div>
            <div class="ip-info-item"><span class="label">Location</span><span class="value" id="proxy-location"><span class="skeleton"></span></span></div>
            <div class="ip-info-item"><span class="label">ISP Provider</span><span class="value" id="proxy-isp"><span class="skeleton"></span></span></div>
          </div>
          <div class="ip-info-section">
            <div class="ip-info-header"><h3>Your Connection</h3></div>
            <div class="ip-info-item"><span class="label">Your IP</span><span class="value" id="client-ip"><span class="skeleton"></span></span></div>
            <div class="ip-info-item"><span class="label">Location</span><span class="value" id="client-location"><span class="skeleton"></span></span></div>
            <div class="ip-info-item"><span class="label">ISP Provider</span><span class="value" id="client-isp"><span class="skeleton"></span></span></div>
            <div class="ip-info-item"><span class="label">Risk Score</span><span class="value" id="client-proxy"><span class="skeleton" style="width: 80px;"></span></span></div>
          </div>
        </div>
      </div>

      <div class="config-card">
        <div class="config-title"><span>Universal Subscription</span></div>
        <div class="client-buttons">
            <button id="universal-import-btn" class="button universal-btn">
                <span class="button-text">Add Subscription (All Platforms)</span>
            </button>
        </div>
      </div>

      <div class="config-card">
        <div class="config-title"><span>Specific Clients</span></div>
        <div class="client-buttons">
          <a href="${clientUrls.v2rayng}" class="button client-btn">Import to V2rayNG</a>
          <a href="${clientUrls.hiddify}" class="button client-btn">Import to Hiddify</a>
          <a href="${clientUrls.nekobox}" class="button client-btn">Import to NekoBox</a>
          <a href="${clientUrls.clashmeta}" class="button client-btn">Import to Clash Meta</a>
        </div>
      </div>
      
      <div class="config-card">
          <div class="config-title"><span>Manual Setup</span><button id="copy-xray-btn" class="button">Copy Link</button></div>
          <div class="config-content"><pre id="xray-config">${configs.dream}</pre></div>
          <button class="button" onclick="toggleQR('xray')">Show QR Code</button>
          <div id="qr-xray-container" style="display:none; text-align:center; margin-top: 1rem;"><div id="qr-xray"></div></div>
      </div>
      
      <div class="footer"><p>© ${new Date().getFullYear()} REvil - All Rights Reserved</p></div>
    </div>
  `;
}

function getPageScript() {
  return `
      function copyToClipboard(button, text) {
        const originalHTML = button.innerHTML;
        navigator.clipboard.writeText(text).then(() => {
          button.innerHTML = 'Copied!';
          button.disabled = true;
          setTimeout(() => {
            button.innerHTML = originalHTML;
            button.disabled = false;
          }, 1500);
        }).catch(err => console.error("Failed to copy: ", err));
      }

      function toggleQR(id) {
        const container = document.getElementById('qr-' + id + '-container');
        if (container.style.display === 'none') {
          container.style.display = 'block';
          if (!container.firstElementChild.hasChildNodes()) {
            new QRCode(container.firstElementChild, {
              text: document.getElementById(id + '-config').textContent,
              width: 256, height: 256
            });
          }
        } else {
          container.style.display = 'none';
        }
      }

      async function fetchJson(url) {
          const response = await fetch(url);
          if (!response.ok) throw new Error(\`HTTP error! status: \${response.status}\`);
          return response.json();
      }

      function updateIpDisplay(data, prefix, host = null) {
          const get = (id) => document.getElementById(\`\${prefix}-\${id}\`);
          if (host) get('host').textContent = host;
          get('ip').textContent = data.ip || 'N/A';
          const location = [data.city, data.country_name].filter(Boolean).join(', ');
          get('location').innerHTML = data.country_code ? \`<img src="https://flagcdn.com/w20/\${data.country_code.toLowerCase()}.png" class="country-flag" alt="\${data.country_code}"> \${location}\` : location || 'N/A';
          get('isp').textContent = data.isp || data.organisation || 'N/A';
      }
      
      function updateScamalyticsDisplay(data) {
          const el = document.getElementById('client-proxy');
          if (!data || data.status !== 'ok') {
              el.innerHTML = '<span class="badge">N/A</span>';
              return;
          }
          const risk = data.risk;
          let badgeClass = '';
          if (risk === "low") badgeClass = "badge-yes";
          else if (risk === "medium") badgeClass = "badge-warning";
          else if (risk === "high") badgeClass = "badge-no";
          el.innerHTML = \`<span class="badge \${badgeClass}">\${data.score} - \${risk}</span>\`;
      }

      async function loadNetworkInfo() {
          try {
              const proxyHost = document.body.dataset.proxyIp || "N/A";
              const proxyIp = proxyHost.split(':')[0];
              if (proxyIp && proxyIp !== "N/A") {
                  fetchJson(\`https://ip-api.io/json/\${proxyIp}\`).then(data => updateIpDisplay(data, 'proxy', proxyHost));
              }

              const clientData = await fetchJson('https://ip-api.io/json/');
              updateIpDisplay(clientData, 'client');
              fetch(\`/scamalytics-lookup?ip=\${clientData.ip}\`).then(r => r.json()).then(d => updateScamalyticsDisplay(d.scamalytics));
          } catch (error) {
              console.error('Network info loading failed:', error);
          }
      }

      function displayExpirationTimes() {
        const expElement = document.getElementById('expiration-display');
        if (!expElement || !expElement.dataset.utcTime) {
            if (expElement) expElement.textContent = 'No expiration date set.';
            return;
        }
        const utcDate = new Date(expElement.dataset.utcTime);
        if (isNaN(utcDate.getTime())) return;
        
        const options = { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' };
        expElement.innerHTML = \`
          <span><strong>Your Local Time:</strong> \${utcDate.toLocaleString(undefined, {...options, timeZoneName: 'short'})}</span>
          <span><strong>Tehran Time:</strong> \${utcDate.toLocaleString('en-US', {...options, timeZone: 'Asia/Tehran'})}</span>
        \`;
      }

      document.addEventListener('DOMContentLoaded', () => {
        loadNetworkInfo();
        displayExpirationTimes();

        const universalBtn = document.getElementById('universal-import-btn');
        const subLink = document.body.dataset.subLink;
        
        const ua = navigator.userAgent;
        const isAndroid = /android/i.test(ua);
        const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;

        if (universalBtn) {
            universalBtn.addEventListener('click', (e) => {
                e.preventDefault();
                if (isAndroid) {
                    window.location.href = \`intent:\${subLink}#Intent;action=android.intent.action.VIEW;scheme=https;end;\`;
                } else if (isIOS) {
                    document.getElementById('ios-modal').classList.add('show');
                } else {
                    // For Desktop, copy the subscription link
                    copyToClipboard(universalBtn, subLink);
                }
            });
        }
        
        const iosModal = document.getElementById('ios-modal');
        const closeModalBtn = document.getElementById('ios-modal-close');
        if (iosModal && closeModalBtn) {
            closeModalBtn.addEventListener('click', () => iosModal.classList.remove('show'));
            iosModal.addEventListener('click', (e) => {
                if(e.target === iosModal) iosModal.classList.remove('show');
            });
        }
        
        document.getElementById('copy-xray-btn')?.addEventListener('click', function() {
            copyToClipboard(this, document.getElementById('xray-config').textContent);
        });
        document.getElementById('refresh-ip-info')?.addEventListener('click', loadNetworkInfo);
      });
  `;
}

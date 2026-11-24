const el = (id) => document.getElementById(id);
const requestId = new URLSearchParams(location.search).get('r');
const show = (id, v) => {
  el(id).hidden = !v;
};
async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await r.json();
  if (!r.ok) throw new Error(result.error ?? '请求失败');
  return result;
}
const post = (url, body = {}) => api(url, { method: 'POST', body });
function action(fn) {
  return async (e) => {
    e.preventDefault();
    el('status').textContent = '';
    try {
      await fn(e);
    } catch (err) {
      el('status').textContent = err.message;
    }
  };
}
const devicePath = '/web/connect/' + encodeURIComponent(requestId ?? '');
async function session(user) {
  show('login', false);
  show('logout', true);
  if (requestId) {
    const device = await api(devicePath);
    el('deviceName').textContent = device.deviceName + ' · ' + device.platform;
    el('match').textContent = device.matchCode;
    show('device', true);
    return;
  }
  show('account', true);
  el('who').textContent = user.username;
  el('serverUrl').value = location.origin;
  if (user.admin) {
    show('admin', true);
    await users();
  }
}
async function users() {
  el('users').replaceChildren();
  for (const { username } of (await api('/web/users')).users) {
    const li = document.createElement('li'),
      button = document.createElement('button');
    li.append(document.createTextNode(username));
    button.className = 'secondary';
    button.textContent = '重置身份验证器';
    button.onclick = action(async () => {
      if (confirm('重置 ' + username + ' 的身份验证器并撤销该用户所有设备授权？'))
        enroll(await post('/web/reset', { username }));
    });
    li.append(button);
    el('users').append(li);
  }
}
function enroll({ username, qr }) {
  el('qrName').textContent = username;
  el('qr').src = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(qr);
  show('enrollment', true);
  el('enrollment').scrollIntoView({ block: 'nearest' });
}
el('dismiss').onclick = () => {
  show('enrollment', false);
  el('qr').removeAttribute('src');
};
el('signin').onsubmit = action(async (e) => {
  const f = e.currentTarget;
  const user = await post('/web/login', Object.fromEntries(new FormData(f)));
  f.reset();
  await session(user);
});
function tokenAction(fn) {
  return action(async () => {
    el('token').disabled = el('revokeToken').disabled = true;
    try {
      await fn();
    } finally {
      el('token').disabled = el('revokeToken').disabled = false;
    }
  });
}
el('token').onclick = tokenAction(async () => {
  el('access').value = (await post('/web/token')).token;
  show('access', true);
  el('access').select();
});
el('revokeToken').onclick = tokenAction(async () => {
  if (!confirm('撤销此账号的所有设备令牌？手动配置和已配对的设备都需要重新授权。')) return;
  await post('/web/token/revoke');
  el('access').value = '';
  show('access', false);
  el('status').textContent =
    '已撤销所有设备令牌。可以生成新的 Access Token，也可以在客户端重新配对。';
});
el('logout').onclick = action(async () => {
  await post('/web/logout');
  location.reload();
});
el('create').onsubmit = action(async (e) => {
  const f = e.currentTarget;
  enroll(await post('/web/users', Object.fromEntries(new FormData(f))));
  f.reset();
  await users();
});
for (const suffix of ['approve', 'cancel'])
  el(suffix).onclick = action(async () => {
    await post(devicePath + '/' + suffix);
    show('device', false);
    el('status').textContent =
      suffix === 'approve' ? '设备已获授权，可以返回 Super Productivity。' : '已拒绝本次连接。';
  });
try {
  await session(await api('/web/me'));
} catch (err) {
  if (el('logout').hidden) {
    const options = await api('/web/login-options').catch(() => ({}));
    if (options.localAdminLogin) {
      el('code').required = false;
      show('localLoginHint', true);
    }
    show('login', true);
  } else el('status').textContent = err.message;
}

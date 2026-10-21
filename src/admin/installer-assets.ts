export const INSTALLER_JS = String.raw`import { ESPLoader, Transport } from '/console/esptool.js';

const q = (id) => document.getElementById(id);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let running = false;

function setStatus(message, kind = '') {
  const node = q('install-status');
  node.textContent = message;
  node.className = 'install-status ' + kind;
}

function appendLog(message) {
  const log = q('install-log');
  const row = document.createElement('div');
  row.textContent = message;
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
}

function setProgress(percent) {
  q('install-progress').value = Math.max(0, Math.min(100, percent));
}

async function api(url, init = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...init });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || body.error?.code || '请求失败');
  return body;
}

async function writeApi(url, csrf, init = {}) {
  return api(url, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, ...(init.headers || {}) },
  });
}

function validPrivateHttpHost(host) {
  if (host === 'localhost' || host.endsWith('.local')) return true;
  const part = host.split('.').map(Number);
  if (part.length !== 4 || part.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  return part[0] === 10 || part[0] === 127 ||
    (part[0] === 172 && part[1] >= 16 && part[1] <= 31) ||
    (part[0] === 192 && part[1] === 168) ||
    (part[0] === 169 && part[1] === 254);
}

function readForm() {
  const deviceId = q('install-device-id').value.trim();
  const ssid = q('install-wifi-ssid').value;
  const password = q('install-wifi-password').value;
  const endpoint = q('install-endpoint').value.trim().replace(/\/$/, '');
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(deviceId)) throw new Error('设备名称只能使用字母、数字、点、横线、下划线或冒号');
  if (!ssid || encoder.encode(ssid).length > 32) throw new Error('请输入 2.4 GHz Wi‑Fi 名称，最长 32 字节');
  if (encoder.encode(password).length > 63) throw new Error('Wi‑Fi 密码最长 63 字节');
  let parsed;
  try { parsed = new URL(endpoint); } catch { throw new Error('服务器地址格式不正确'); }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error('服务器地址只填写站点根地址，不要带路径、参数或账号');
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && validPrivateHttpHost(parsed.hostname))) {
    throw new Error('公网服务器必须使用 HTTPS；HTTP 只允许局域网私有地址');
  }
  return { deviceId, ssid, password, endpoint };
}

async function digestHex(data) {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function fetchFirmware() {
  appendLog('正在取得并校验正式固件……');
  const manifest = await api('/admin/v1/device-installer/manifest');
  const files = [];
  for (const segment of manifest.segments) {
    const response = await fetch(segment.url, { credentials: 'same-origin' });
    if (!response.ok) throw new Error('固件文件下载失败：' + segment.name);
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength !== segment.bytes || await digestHex(data) !== segment.sha256) {
      throw new Error('固件校验失败：' + segment.name);
    }
    files.push({ data, address: segment.address });
  }
  appendLog('固件完整性校验通过（版本 ' + manifest.release_id + '）');
  return { manifest, files };
}

function progressForFile(files, index, written, total) {
  const previous = files.slice(0, index).reduce((sum, file) => sum + file.data.byteLength, 0);
  const all = files.reduce((sum, file) => sum + file.data.byteLength, 0);
  setProgress(5 + 70 * (previous + Math.min(written, total)) / all);
}

async function flash(port, firmware) {
  setStatus('正在写入完整固件，请不要拔线或关闭页面。');
  const transport = new Transport(port, false);
  const terminal = {
    clean() {},
    write() {},
    writeLine(line) {
      if (/^(Chip|Writing|Hash|Hard resetting|Stub)/i.test(line.trim())) appendLog(line.trim());
    },
  };
  const loader = new ESPLoader({ transport, baudrate: 921600, terminal, debugLogging: false });
  try {
    const chip = await loader.main();
    if (!String(chip).toUpperCase().includes('ESP32-S3')) throw new Error('所选设备不是支持的 ESP32-S3 墨水屏');
    appendLog('已识别设备：' + chip);
    await loader.writeFlash({
      fileArray: firmware.files,
      flashMode: firmware.manifest.flash_mode,
      flashFreq: firmware.manifest.flash_frequency,
      flashSize: firmware.manifest.flash_size,
      eraseAll: firmware.manifest.erase_all,
      compress: true,
      reportProgress: (index, written, total) => progressForFile(firmware.files, index, written, total),
    });
    setProgress(76);
    appendLog('完整固件写入完成，设备正在重新启动。');
    await loader.after('hard_reset');
  } finally {
    try { await transport.disconnect(); } catch {}
  }
}

function samePort(left, right) {
  const a = left.getInfo();
  const b = right.getInfo();
  return a.usbVendorId === b.usbVendorId && a.usbProductId === b.usbProductId;
}

async function reopenRuntimePort(original) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const granted = await navigator.serial.getPorts();
    const candidates = [original, ...granted.filter((item) => item !== original && samePort(item, original))];
    for (const port of candidates) {
      try {
        if (!port.readable && !port.writable) await port.open({ baudRate: 115200, bufferSize: 4096 });
        if (port.readable && port.writable) return port;
      } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error('固件已写入，但浏览器没有等到设备重新出现。请保持 USB 连接后点“只重新配置”。');
}

async function revokeOldBindings(deviceId, csrf) {
  const status = await api('/admin/v1/device-status');
  for (const binding of status.bindings || []) {
    if (binding.device_id === deviceId && binding.status === 'active') {
      await writeApi('/admin/v1/device-bindings/' + encodeURIComponent(binding.binding_id), csrf, { method: 'DELETE', body: '{}' });
    }
  }
}

async function provision(port, form, csrf) {
  setStatus('正在安全地把 Wi‑Fi 与服务器信息交给设备。');
  await revokeOldBindings(form.deviceId, csrf);
  const pairing = await writeApi('/admin/v1/pairings', csrf, { method: 'POST', body: '{}' });
  const command = JSON.stringify({
    type: 'm4_provision',
    wifi_ssid: form.ssid,
    wifi_password: form.password,
    endpoint: form.endpoint,
    enrollment_code: pairing.enrollment_code,
    device_id: form.deviceId,
    unix_time: Math.floor(Date.now() / 1000),
  }) + '\n';
  const reader = port.readable.getReader();
  let sent = false;
  let text = '';
  let pendingRead = reader.read();
  let watchdogBoots = 0;
  const openedAt = Date.now();
  const deadline = openedAt + 120000;
  try {
    while (Date.now() < deadline) {
      if (!sent && (text.includes('usb_provisioning=READY') || Date.now() - openedAt > 9000)) {
        const writer = port.writable.getWriter();
        try { await writer.write(encoder.encode(command)); } finally { writer.releaseLock(); }
        sent = true;
        setProgress(84);
        appendLog('配置已发送，设备正在连接 Wi‑Fi 和服务器。');
      }
      const outcome = await Promise.race([
        pendingRead.then((result) => ({ result })),
        new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 500)),
      ]);
      if (outcome.timeout) continue;
      const result = outcome.result;
      if (result.done) break;
      pendingRead = reader.read();
      text += decoder.decode(result.value, { stream: true });
      const lines = text.split(/\r?\n/);
      text = lines.pop() || '';
      for (const line of lines) {
        if (line.includes('[M2] boot')) watchdogBoots = 0;
        if (line.includes('TG0WDT_SYS_RST')) watchdogBoots += 1;
        if (line.includes('Guru Meditation Error') || line.includes('Stack canary watchpoint')) {
          throw new Error('设备固件运行时崩溃，已停止配置');
        }
        if (watchdogBoots >= 2) {
          throw new Error('设备固件没有正常启动，已停止配置；请重新运行完整安装');
        }
        if (line.includes('[M4] wifi=PASS')) appendLog('Wi‑Fi 已连接。');
        if (line.includes('[M4] pair=PASS')) appendLog('设备已和你的服务绑定。');
        if (line.includes('[M4] setup=PASS')) return;
        if (line.includes('[M4] command=FAIL')) throw new Error('设备拒绝了配置：' + line.replace(/^.*reason=/, ''));
      }
    }
    throw new Error(sent ? '设备联网或配对超时，请检查 Wi‑Fi 和服务器地址' : '设备没有进入配置状态');
  } finally {
    form.password = '';
    try { await reader.cancel(); } catch {}
    reader.releaseLock();
    try { await port.close(); } catch {}
  }
}

async function confirmOnline(deviceId) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const status = await api('/admin/v1/device-status');
    if ((status.bindings || []).some((binding) => binding.device_id === deviceId && binding.status === 'active')) return;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error('设备已经报告配置成功，但控制台尚未看到有效绑定');
}

async function run(shouldFlash) {
  if (running) return;
  running = true;
  const buttons = [q('install-button'), q('reconfigure-button')];
  buttons.forEach((button) => { button.disabled = true; });
  q('install-log').textContent = '';
  setProgress(0);
  try {
    if (!window.isSecureContext || !('serial' in navigator)) {
      throw new Error('请使用最新版 Chrome 或 Edge，并通过 HTTPS 或本机 localhost 打开控制台');
    }
    const form = readForm();
    const session = await api('/admin/v1/session');
    let port = await navigator.serial.requestPort();
    if (shouldFlash) {
      const firmware = await fetchFirmware();
      setProgress(5);
      await flash(port, firmware);
      port = await reopenRuntimePort(port);
    } else {
      if (!port.readable && !port.writable) await port.open({ baudRate: 115200, bufferSize: 4096 });
    }
    await provision(port, form, session.csrf_token);
    form.password = '';
    q('install-wifi-password').value = '';
    setProgress(94);
    await confirmOnline(form.deviceId);
    setProgress(100);
    setStatus('安装完成：设备已记住配置并连接到你的服务。', 'ok');
    appendLog('现在可以拔掉 USB；设备断电重启后会自动恢复。');
    q('refresh-devices').click();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '安装失败', 'error');
    appendLog('没有完成安装；可以修正信息后重新运行。');
  } finally {
    q('install-wifi-password').value = '';
    running = false;
    buttons.forEach((button) => { button.disabled = false; });
  }
}

async function initialize() {
  if (!window.isSecureContext || !('serial' in navigator)) {
    setStatus('这个浏览器不能进行 USB 安装。请用最新版 Chrome 或 Edge，通过 HTTPS 或 localhost 打开。', 'error');
    q('install-button').disabled = true;
    q('reconfigure-button').disabled = true;
  }
  try {
    const overview = await api('/admin/v1/console/overview');
    const hint = overview.device?.endpoint_hint;
    if (hint) q('install-endpoint').value = hint;
    else if (location.protocol === 'https:' && location.origin) q('install-endpoint').value = location.origin;
  } catch {}
}

q('install-button').addEventListener('click', () => void run(true));
q('reconfigure-button').addEventListener('click', () => void run(false));
document.querySelector('[data-page="devices"]')?.addEventListener('click', () => void initialize());
void initialize();
`;

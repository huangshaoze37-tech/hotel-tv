// ============================================================
// 智能直播源聚合脚本（云端版 · GitHub Actions）
// 功能：拉取全部上游直播源 → 按频道名合并去重（同名只留一个）
//       → 剔除 IPv6/黑名单/.ctv垃圾流 → 并发探测连通性
//       → 生成 live_all.m3u（影视仓/TVBox 直接拉取）
// 用法：在仓库根目录执行 node live_builder.js
// 上游源列表在下方 UPSTREAM 中维护，增删源改这里即可。
// ============================================================
const fs = require('fs');
const path = require('path');

// 云端版：直接输出到仓库根目录（GitHub Actions 里 process.cwd() = 仓库根）
const ROOT = process.cwd();
const OUT = path.join(ROOT, 'live_all.m3u');
const REPORT = path.join(ROOT, 'live_builder_report.txt');

// 上游直播源（可自行增删）
const UPSTREAM = [
  { name: 'iptv-org中文', url: 'https://iptv-org.github.io/iptv/languages/zho.m3u' },
  { name: '海外中文大包', url: 'https://m3u.ibert.me/o_s_cn.m3u' },
  { name: '香港台', url: 'https://iptv-org.github.io/iptv/countries/hk.m3u' },
  { name: '大陆台', url: 'https://iptv-org.github.io/iptv/countries/cn.m3u' },
  { name: '大陆补充', url: 'https://m3u.ibert.me/cn_c.m3u' },
  { name: '香港专源iill', url: 'https://tv.iill.top/m3u/HK' },
];

// 香港重点台：云端(GitHub美国服务器)探测经常连不上国内/香港源而误判死链，
// 但这些台国内电视往往能播。命中名单的台无论探测结果如何都强制保留，让电视端自己挑。
const HK_KEEP_RE = /翡翠|Jade|明珠|Pearl|ViuTV|HOY|RTHK|港台|凤凰|Phoenix|香港|開電視|开电视|now新闻|now新聞|i-Cable|有线/i;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0';
const PROBE_TIMEOUT = 8000; // 单流探测超时（毫秒）
const MAX_CANDIDATES = 6; // 每个频道最多探测几个候选流
const CONCURRENCY = 40; // 频道级并发数

// 垃圾/推广域名黑名单（返回 NO SIGNAL 推广画面或假流）
const BLOCKED_HOSTS = [
  '3y1.xyz', 'spread.3y1.xyz', 'tvbox.club', 'bili.tv',
  'ikanshu.net', 'jiangjiu.tv', 'xiaoyaook.xyz', 'tv8.live',
];

// 需要剔除的频道名关键词（推广台/非法台等）
const BLOCKED_NAME_KW = ['测试台', '测试频道', 'test', 'adult', '18禁', '推广台'];

// 判断是否为 IPv6 流（普通电视无公网 IPv6，播不了；含名字标记或 IPv6 地址都算）
function isIPv6(url, display) {
  if (/ipv6/i.test(display || '')) return true;
  try {
    const host = new URL(url).hostname;
    return host.includes(':');
  } catch {
    return /\[[0-9a-fA-F:]+\]/.test(url) || /\/\/[0-9a-fA-F]*:[0-9a-fA-F]*:/i.test(url);
  }
}

// 判断是否为垃圾推广流（epg.pw 的 .ctv 播放器流 → 内容是第三方推广画面）
function isJunkStream(url) {
  return /\.ctv([?#]|$)/i.test(url) || /epg\.pw\/stream\//i.test(url);
}

// 判断流 URL 是否命中黑名单域名
function isBlockedHost(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return BLOCKED_HOSTS.some((b) => host === b || host.endsWith('.' + b));
  } catch {
    return false;
  }
}

// 频道名归一化：去掉 [标记] (画质) 空格符号，用于同名合并
function normName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, '')
    .replace(/[^\u4e00-\u9fa5a-z0-9]/g, '');
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return await res.text();
}

function parseM3U(text, sourceName) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXTINF')) {
      const nameMatch = line.match(/,(.+)$/);
      const display = nameMatch ? nameMatch[1].trim() : '';
      const tvgId = (line.match(/tvg-id="([^"]*)"/) || [])[1] || '';
      const tvgLogo = (line.match(/tvg-logo="([^"]*)"/) || [])[1] || '';
      const group = (line.match(/group-title="([^"]*)"/) || [])[1] || '未分组';
      let url = '';
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j].trim();
        if (t.startsWith('#')) continue;
        if (/^https?:\/\//.test(t)) { url = t; break; }
        break;
      }
      if (url && display) {
        out.push({ display, tvgId, tvgLogo, group, url, source: sourceName });
      }
    }
  }
  return out;
}

// 探测单个流是否可连通（下载 ≥32KB 验证内容确为媒体流，拒绝 HTML/JSON/垃圾推广流）
function probe(url) {
  return new Promise((resolve) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT);
    const start = Date.now();
    fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://news.tvb.com/' },
      signal: ctrl.signal,
    })
      .then(async (res) => {
        clearTimeout(timer);
        if (!res.ok) {
          // 5xx 可能是服务器临时故障（不确定）；4xx 基本是死链
          const code = res.status;
          resolve({ ok: false, uncertain: code >= 500, ms: Date.now() - start, reason: 'HTTP ' + code });
          return;
        }
        // 重定向后的最终域名也要过黑名单
        if (isBlockedHost(res.url) || isJunkStream(res.url)) {
          resolve({ ok: false, uncertain: false, ms: Date.now() - start, reason: '最终跳转至黑名单/推广源' });
          return;
        }
        const reader = res.body.getReader();
        let buf = Buffer.alloc(0);
        let bytes = 0;
        while (bytes < 8192) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            buf = Buffer.concat([buf, Buffer.from(value)]);
            bytes = buf.length;
          }
          if (!value) break;
        }
        reader.cancel();
        const text = buf.toString('utf8').toLowerCase();
        // 明确是 HTML / JSON / 文本错误页 → 视为假流
        if (/<(!doctype|html|head|body|script|div)/.test(text) && !/\.ts|\.flv|adts/.test(text.slice(0, 64))) {
          resolve({ ok: false, uncertain: false, ms: Date.now() - start, reason: '返回网页而非流' });
          return;
        }
        if (/^\s*[{[]/.test(text) && !/#extm3u|#extinf/.test(text)) {
          resolve({ ok: false, uncertain: false, ms: Date.now() - start, reason: '返回 JSON 而非流' });
          return;
        }
        // 流特征：m3u8 / ts / flv / adts / mp4
        const looksStream =
          /#extm3u|#extinf|mpegurl/.test(text) ||
          /\.ts([?#]|$)/.test(text) ||
          /\.flv([?#]|$)/.test(text) ||
          /adts|mp4a|ftyp/.test(text);
        resolve({ ok: looksStream && bytes > 0, uncertain: false, ms: Date.now() - start, bytes });
      })
      .catch((e) => {
        clearTimeout(timer);
        // 超时/网络抖动：云端（美国）连不上的源，国内电视可能能播 → 标记为"不确定"，保留
        if (e.name === 'AbortError') {
          resolve({ ok: false, uncertain: true, ms: Date.now() - start, reason: '超时' });
        } else if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET/i.test(e.message || '')) {
          resolve({ ok: false, uncertain: false, ms: Date.now() - start, reason: e.message });
        } else {
          resolve({ ok: false, uncertain: true, ms: Date.now() - start, reason: e.message });
        }
      });
  });
}

// 通用并发池
async function pool(items, worker, size) {
  const results = new Array(items.length);
  let idx = 0;
  async function run() {
    while (idx < items.length) {
      const cur = idx++;
      results[cur] = await worker(items[cur]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, () => run()));
  return results;
}

(async () => {
  const t0 = Date.now();
  const report = [];
  report.push('智能直播源聚合报告（云端自动更新）');
  report.push('时间：' + new Date().toLocaleString('zh-CN'));
  report.push('========================================');

  // 1. 拉取上游源
  const all = [];
  for (const s of UPSTREAM) {
    try {
      const text = await fetchText(s.url);
      const parsed = parseM3U(text, s.name);
      all.push(...parsed);
      report.push(`[拉取] ${s.name} | ${parsed.length} 频道 | ${s.url}`);
    } catch (e) {
      report.push(`[拉取失败] ${s.name} | ${e.message}`);
    }
  }

  // 2. 按归一化频道名分组（同名多流合并），先剔除 IPv6/黑名单/垃圾台
  const groups = new Map();
  let filtered6 = 0, filteredBlock = 0, filteredKw = 0, filteredCtv = 0;
  for (const ch of all) {
    if (isIPv6(ch.url, ch.display)) { filtered6++; continue; }
    if (isBlockedHost(ch.url)) { filteredBlock++; continue; }
    if (isJunkStream(ch.url)) { filteredCtv++; continue; }
    if (BLOCKED_NAME_KW.some((k) => (ch.display || '').toLowerCase().includes(k.toLowerCase()))) { filteredKw++; continue; }
    const key = normName(ch.display);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ch);
  }
  report.push(`[解析] 上游条目 ${all.length} 条 → 剔除 IPv6 ${filtered6} 条、黑名单域名 ${filteredBlock} 条、.ctv推广流 ${filteredCtv} 条、关键词 ${filteredKw} 条 → 合并为 ${groups.size} 个频道名`);

  // 3. 并发探测：每个频道挑最快的可用流；探测超时/不确定的也保留（国内电视可能能播）
  const tasks = [...groups.entries()];
  const picked = [];
  const dead = [];
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const cur = tasks[idx++];
      const [key, chans] = cur;
      const cands = chans.slice(0, MAX_CANDIDATES);
      const results = await pool(cands, async (c) => {
        const r = await probe(c.url);
        return Object.assign({}, c, r);
      }, Math.min(MAX_CANDIDATES, cands.length));
      const okList = results.filter((r) => r.ok).sort((a, b) => a.ms - b.ms);
      const uncertainList = results.filter((r) => !r.ok && r.uncertain).sort((a, b) => a.ms - b.ms);
      if (okList.length > 0) {
        picked.push({ key, ch: okList[0], uncertain: false });
      } else if (uncertainList.length > 0) {
        picked.push({ key, ch: uncertainList[0], uncertain: true });
      } else if (HK_KEEP_RE.test(chans[0].display)) {
        // 香港重点台：探测全失败也强制保留（国内电视可能能播），标记 hkKeep
        picked.push({ key, ch: chans[0], uncertain: true, hkKeep: true });
      } else {
        dead.push({ key, display: chans[0].display });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, () => worker()));

  const probeMs = Date.now() - t0;
  const uncertainCount = picked.filter((p) => p.uncertain).length;
  const hkKeepCount = picked.filter((p) => p.hkKeep).length;
  report.push(`[探测] 可用频道 ${picked.length} 个（其中云端探测超时/待定 ${uncertainCount} 个，香港强制保留 ${hkKeepCount} 个），失效频道 ${dead.length} 个，耗时 ${(probeMs / 1000).toFixed(1)}s`);
  if (dead.length > 0) {
    const sample = dead.slice(0, 20).map((d) => d.display).join('、');
    report.push(`[失效示例] ${sample}${dead.length > 20 ? ' 等' + dead.length + ' 个' : ''}`);
  }

  // 4. 生成聚合 M3U（香港台并入"未分组"并排最前，电视端打开直播即可见翡翠台等，无需分类导航）
  const byGroup = {};
  for (const p of picked) {
    const isHK = !!(p.hkKeep || HK_KEEP_RE.test(p.ch.display));
    const g = isHK ? '未分组' : (p.ch.group || '未分组');
    if (!byGroup[g]) byGroup[g] = [];
    byGroup[g].push(Object.assign({}, p.ch, { _hk: isHK }));
  }
  const lines = ['#EXTM3U'];
  let written = 0;
  for (const g of Object.keys(byGroup).sort((a, b) => a.localeCompare(b, 'zh'))) {
    const arr = byGroup[g];
    if (g === '未分组') arr.sort((a, b) => (b._hk ? 1 : 0) - (a._hk ? 1 : 0) || a.display.localeCompare(b.display, 'zh'));
    else arr.sort((a, b) => a.display.localeCompare(b.display, 'zh'));
    for (const ch of arr) {
      const attrs = [];
      if (ch.tvgId) attrs.push(`tvg-id="${ch.tvgId}"`);
      if (ch.tvgLogo) attrs.push(`tvg-logo="${ch.tvgLogo}"`);
      attrs.push(`group-title="${g}"`);
      lines.push(`#EXTINF:-1 ${attrs.join(' ')} ,${ch.display}`);
      lines.push(ch.url);
      written++;
    }
  }
  fs.writeFileSync(OUT, lines.join('\r\n') + '\r\n', 'utf8');
  report.push(`[输出] 已生成 ${OUT}（${written} 个可用频道）`);
  report.push('========================================');
  report.push(`汇总：聚合 ${written} 个可用频道（原 ${all.length} 条），耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const reportText = report.join('\r\n');
  fs.writeFileSync(REPORT, reportText, 'utf8');
  console.log(reportText);
  console.log('');
  console.log('报告已写入: ' + REPORT);
})().catch((e) => {
  console.error('聚合脚本运行失败:', e);
  process.exit(1);
});

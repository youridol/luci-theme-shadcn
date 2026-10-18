// SPDX-License-Identifier: Apache-2.0
//
// luci-theme-shadcn 的 rpcd 对象：为“在线主机”详情页提供逐条连接明细，
// 并为概览看板提供 fast / slow 两条数据通道。
//
// 独立于 luci-app-trafficctl —— 那个包只给每主机汇总，没有逐条连接，
// 而本主题需要的是「某台主机的实时连接」与「一眼能诊断的看板」。这里只读
// 内核数据，不改任何配置，也不依赖 trafficctl 的内部结构。
//
// 对外方法：
//   connections { ip, limit? }  该主机的连接明细，含应用指纹与本次速率
//   resolve     { ips }        批量把地址反查成域名（只查本地已知的）
//   dashboard   { sections? }  看板数据（见 .dev/docs/dashboard.md）
//
// dashboard 的成本差两个数量级（真机实测，x86_64 / LEDE 24.10.5，约 1000
// 条连接）：
//   fast ≈  13 ms  只读 /proc 与 /sys 的常量级文件
//   slow ≈ 740 ms  解析整张连接表并聚合
// 所以前端按 1 s 拉 fast、按 60 s 拉 slow。把 slow 放进快周期就是灾难 ——
// 这正是 .dev/docs/adr/0005 里快慢分离的理由。
//
// 速率靠两次采样的字节差算，所以按地址缓存上一轮的采样。

'use strict';

import { readfile, writefile, popen } from 'fs';
// ucode 没有全局 Math，取整必须从 math 模块拿。
import { round } from 'math';
// 阈值可选配置：/etc/config/shadcn-dashboard 不存在时全用默认值。
import { cursor } from 'uci';
import { parseConntrack, appFor, connKey } from 'shadcn.conntrack';
import { caps as probeCaps, fastSample, cpuUsage, cpuUsagePer } from 'shadcn.probe';
import { readAndSummarize, compact } from 'shadcn.aggregate';

// 回看文件由 sampler.uc 写入（procd 托管），见 adr/0005。
const HISTORY_PATH = '/tmp/shadcn-dashboard/history.json';

// rpcd 在独立进程里持有本对象，这份缓存随进程存活；连接消失后下一轮
// 调用会顺手覆盖，因此不会随连接数无限增长。
const lastSample = {};

// 快路径的上一轮采样，用于算 CPU 使用率与网口速率。
// 1 s 一次的调用间隔足够短，所以只留最近一份。
let lastFast = null;

// 一次最多返回多少条连接。连接表可达数百条，全量吐给前端没有意义。
const DEFAULT_LIMIT = 300;

// 单调时钟，单位秒。ucode 的 clock(true) 返回 [秒, 纳秒]，不是浮点数。
function monotonic() {
	const c = clock(true);

	if (type(c) == 'array')
		return c[0] + (c[1] / 1000000000.0);

	return +(c ?? 0);
}

// 读连接表。失败时返回 ok=false —— 让调用方区分「读失败」和「没有连接」，
// 不把错误伪装成空结果。
function readConnections() {
	try {
		const text = readfile('/proc/net/nf_conntrack');

		if (text == null)
			return { ok: false, error: '无法读取连接表', list: [] };

		return { ok: true, list: parseConntrack(text) };
	}
	catch (e) {
		return { ok: false, error: `${e}`, list: [] };
	}
}

// 只要该地址发起的连接。用源地址判定，避免同一条内网互连在两个主机上
// 各出现一次。
function forHost(list, ip) {
	const out = [];

	for (let c in list)
		if (c.src == ip)
			push(out, c);

	return out;
}

// 读本机 LAN 的 IPv4 地址（完整地址，例如 192.168.3.254）。
//
// 只认 /etc/config/network 里 lan 段的 ipaddr —— 这是静态配置的权威来源。
// 取不到就返回 null，由调用方退化处理，而不是猜一个地址出来。
function lanAddress() {
	const text = readfile('/etc/config/network');

	if (text == null)
		return null;

	let inLan = false;

	for (let raw in split(text, '\n')) {
		const line = trim(raw);

		// match() 返回的是数组（或 null），不是布尔值。直接把它当条件用会
		// 在“匹配到”时得到 [""]，虽然为真，但赋值给 inLan 后再参与逻辑
		// 容易出错（空匹配的结果是 null，看起来像没匹配到）。统一转成布尔。
		if (match(line, /^config\s+interface\s+/)) {
			inLan = match(line, /^config\s+interface\s+'lan'$/) != null;
			continue;
		}

		if (inLan && match(line, /^config\s+/))
			break;

		if (inLan) {
			const m = match(line, /^option\s+ipaddr\s+'([0-9.]+)'$/);

			if (m != null && m[1] != null)
				return m[1];
		}
	}

	return null;
}

// 读本机 LAN 的 IPv4 网段（形如 192.168.3），用于区分连接的对端是内网还是
// 公网，避免前端为拿网段额外申请 network 接口的权限。
function lanPrefix() {
	const addr = lanAddress();

	if (addr == null)
		return null;

	const p = split(addr, '.');

	return length(p) == 4 ? `${p[0]}.${p[1]}.${p[2]}` : null;
}

// 地址 -> 名称。来源是 dnsmasq 租约里 DHCP 客户端上报的主机名。
//
// 只反查本地已知的：公网地址在这里查不到，前端据此显示 “—”。要显示
// 公网域名得做主动 DNS 反查，那会引入联网与延迟，不在本方法的职责内。
function loadLeases() {
	const map = {};
	const text = readfile('/tmp/dhcp.leases');

	if (text == null)
		return map;

	for (let line in split(text, '\n')) {
		const f = split(trim(line), ' ');
		const ip = f[2];
		const name = f[3];

		// 丢掉通配名 "*"：它表示客户端没上报主机名，显示地址更有用
		if (length(f) >= 4 && ip != '' && name != '' && name != '*')
			map[ip] = name;
	}

	return map;
}

// 用 dnsmasq 反查一个 IPv4 地址对应的名字，取不到返回 null。
//
// 只认 127.0.0.1 的回答：那是本机 dnsmasq，覆盖静态租约、/etc/hosts 和
// 本机地址。公网地址通常返回 NXDOMAIN（上游没开反查），此时如实返回
// null，由前端显示地址本身。
//
// 结果形如 "vivo-Y52s.lan"，去掉 .lan 后缀更好读。
function reverseLookup(ip) {
	if (ip == null || match(ip, /^[0-9.]+$/) == null)
		return null;

	let out = null;

	try {
		out = popen(`nslookup ${ip} 127.0.0.1 2>/dev/null`, 'r');

		if (out == null)
			return null;

		const text = out.read('all') ?? '';
		out.close();

		// 只取 "name = xxx" 那一行，避免把 "Address: 127.0.0.1" 当成结果；
		// 顺手去掉 dnsmasq 加的 .lan 后缀，表格里更好读。
		//
		// 字符类必须显式列出空白：ucode 的 [^\s] 连字面字母 s 一起排除，
		// 会把 "vivo-Y52s.lan" 截成 "vivo-Y52"。
		const m = match(text, /name[ \t]*=[ \t]*([^ \t\r\n]+)/);

		if (m == null || m[1] == null)
			return null;

		const name = replace(m[1], /\.lan$/, '');

		return name != '' ? name : null;
	} catch (e) {
		// 反查失败不该影响连接列表
		return null;
	}
}

// 由两次 fastSample 的网口累计字节差求每个接口的收发速率（B/s）。
//
// 增量算不出来时（计数器回落 = 网口重连、dt <= 0）该接口置 null，而不是
// 把负数或 0 当成真实速率。
function netRates(prev, cur, dt) {
	if (prev == null || cur == null)
		return null;

	if (!(dt > 0))
		return null;

	const out = {};

	for (let name in cur) {
		const before = prev[name];

		out[name] = {
			rx: (before != null && cur[name].rx >= before.rx)
				? (cur[name].rx - before.rx) / dt
				: null,
			tx: (before != null && cur[name].tx >= before.tx)
				? (cur[name].tx - before.tx) / dt
				: null,
		};
	}

	return out;
}

// 读采样器写下的回看。
//
// 没装采样器、或刚重启过（tmpfs 清空）时返回 available:false 并说明原因；
// 前端据此显示「无历史 / 回看自 <时间> 起」，不把空数组画成一条平线。
function loadHistory() {
	const raw = readfile(HISTORY_PATH);

	if (raw == null)
		return {
			available: false,
			reason: '回看为空（采样器未运行或刚重启过）',
			points: [],
			started: null,
		};

	let parsed = null;

	try {
		parsed = json(raw);
	}
	catch (e) {
		return {
			available: false,
			reason: '回看文件损坏',
			points: [],
			started: null,
		};
	}

	if (type(parsed) != 'object' || type(parsed.points) != 'array')
		return {
			available: false,
			reason: '回看文件格式不符',
			points: [],
			started: null,
		};

	return {
		available: true,
		started: parsed.started ?? null,
		step: parsed.step ?? null,
		points: parsed.points,
	};
}

// 慢路径：解析整张连接表并汇总。这条路径约 740 ms，只能慢周期调用。
//
// 解析失败时返回 available:false —— 让前端区分「读失败」和「没有连接」，
// 不把错误伪装成空结果。
function slowSummary() {
	let text = null;

	try {
		text = readfile('/proc/net/nf_conntrack');
	}
	catch (e) {
		return { available: false, error: `${e}` };
	}

	if (text == null)
		return { available: false, error: '无法读取连接表' };

	const summary = readAndSummarize(text, { limit: 10 });

	return {
		available: true,
		// compact() 只留图表要用的 key 与字节数，排行榜不把明细塞进 60 秒
		// 一次的响应体
		compact: compact(summary),
		// 状态分布给「异常横幅」用：offloaded / uncounted 能解释为什么
		// 某些连接测不出速率
		states: summary.states,
		offloaded: summary.offloaded,
		uncounted: summary.uncounted,
		total: summary.total,
	};
}

// ── 阈值 ──────────────────────────────────────────────────────────────
//
// 默认值在这里，被 /etc/config/shadcn-dashboard 的同名 option 逐项覆盖。
// 判定留在后端而不是前端：后端才握有原始数值（conntrack 的 count/max、
// 内存的字节数），前端只拿到四舍五入后的百分比，用取整后的数去比阈值会
// 在边界上错判。
//
// 配置文件是可选的：不存在时 get() 返回 null，一律落回默认值，不报错。
const ALERT_DEFAULTS = {
	// conntrack 占用百分比，两档。
	conntrack_warn: 80,
	conntrack_crit: 95,
	// 内存已用百分比。
	mem_used: 90,
	// 摄氏温度，两档。
	temp_warn: 80,
	temp_crit: 90,
	// 无字节计数连接占比（硬件转发），超过则提示速率不可测。
	uncounted_share: 50,
};

// 读一项阈值。非数字或缺失都落回默认值 —— 一个打错字的配置项不该让
// 整个告警系统失效，也不该把阈值变成 0 而满屏报警。
//
// 不能用 isNaN：ucode 没有它（`isNaN('5')` 抛 "left-hand side is not a
// function"）。而这里的 try/catch 会把这个错误吞掉并回退默认值，于是
// 「配置写了但永远不生效」且毫无提示 —— 真机上就是这样静默失效的。
// 改用 `n == n`：NaN 是唯一不等于自身的值。
function alertConfig(name) {
	const fallback = ALERT_DEFAULTS[name];

	try {
		const c = cursor();
		const raw = c.get('shadcn-dashboard', 'alert', name);

		if (raw == null)
			return fallback;

		const n = +raw;

		if (n != n)          // NaN：配置项写的不是数字
			return fallback;

		if (n < 0)           // 负数阈值没有意义
			return fallback;

		return n;
	}
	catch (e) {
		return fallback;
	}
}

// 当前生效的全部阈值 + 每项的来源，让前端能显示「默认」还是「已覆盖」。
function alertConfigAll() {
	const out = {};

	for (let name in ALERT_DEFAULTS) {
		const value = alertConfig(name);
		out[name] = {
			value: value,
			// 只有真的读到配置且与默认不同才标 custom，否则看不出哪项被改过。
			source: value == ALERT_DEFAULTS[name] ? 'default' : 'config',
		};
	}

	return out;
}

// 保留一位小数的百分比。
//
// `round(x)` 返回 int，`int / 10` 又走整数除法向零截断 —— 0.55% 会显示成
// 「0%」。第二个参数 true 让它返回 double，除法才保留小数。
function pct1(v) {
	return round(v * 10, true) / 10;
}

// 把一次采样变成「持续状态」列表。只输出真的成立的条件，空数组表示健康。
//
// 每条带 `limit`：前端据此显示「80%」这个数字，不必自己再存一份阈值。
// cpus 从 caps 传进来：它在 probe.uc 的 caps() 里，不在 fast 采样里。
function buildAlerts(fast, slow, thresholds, cpus) {
	const out = [];
	const t = thresholds ?? {};

	const thr = function(name) {
		const item = t[name];

		return (item != null && item.value != null) ? item.value : ALERT_DEFAULTS[name];
	};

	const ct = fast?.conntrack;

	if (ct != null && ct.available && ct.percent != null) {
		const warn = thr('conntrack_warn');
		const crit = thr('conntrack_crit');

		if (ct.percent > warn)
			push(out, {
				key: 'conntrack',
				tone: ct.percent > crit ? 'danger' : 'warning',
				title: '连接表接近上限',
				detail: `${ct.count} / ${ct.max}（${pct1(ct.percent)}%）`,
				limit: `${warn}%`,
			});
	}

	if (fast?.mem != null) {
		const limit = thr('mem_used');

		if (fast.mem.percent > limit)
			push(out, {
				key: 'mem',
				tone: 'warning',
				title: '可用内存不足',
				detail: `已用 ${pct1(fast.mem.percent)}%`,
				limit: `${limit}%`,
			});
	}

	if (fast?.temp != null && fast.temp.available) {
		const warn = thr('temp_warn');
		const crit = thr('temp_crit');

		if (fast.temp.max > warn)
			push(out, {
				key: 'temp',
				tone: fast.temp.max > crit ? 'danger' : 'warning',
				title: '温度偏高',
				detail: `${round(fast.temp.max)} °C`,
				limit: `${warn} °C`,
			});
	}

	// 负载按「1 分钟负载 > 核数」判，核数来自 caps（见 probe.uc 的注释）。
	if (fast?.load != null && cpus != null && cpus > 0 && fast.load.one > cpus)
		push(out, {
			key: 'load',
			tone: 'warning',
			title: '负载超过核数',
			detail: `1 分钟负载 ${fast.load.one} · ${cpus} 核`,
			limit: `${cpus} 核`,
		});

	const conns = slow?.conns;

	if (conns != null && conns.available && conns.total > 0) {
		const limit = thr('uncounted_share');
		const share = (conns.uncounted / (conns.total + 0.0)) * 100;

		// 不是故障：硬件转发的连接本来就不带字节计数。说一次，免得把
		// 某一行的「— B/s」当成 bug。
		if (share > limit)
			push(out, {
				key: 'uncounted',
				tone: 'info',
				title: '多数连接由硬件转发',
				detail: `${conns.uncounted} / ${conns.total} 条无字节计数，速率不可测`,
				limit: `${limit}%`,
			});
	}

	// 严重度排序：danger → warning → info。前端据此顺序渲染，不必再排。
	const rank = { danger: 0, warning: 1, info: 2 };

	return sort(out, function(a, b) {
		const ra = rank[a.tone] ?? 9;
		const rb = rank[b.tone] ?? 9;

		return ra - rb;
	});
}

// ── 一键诊断 ──────────────────────────────────────────────────────────
//
// 与「异常」的区别：异常是持续状态，随数据自动出现消失；诊断是一次性检查，
// 由用户点击触发，跑完即结束。它的价值在于把「现在到底哪一段断了」变成
// 逐项结论，而不是让人对着数字猜。
//
// 三条约束：
//   · 总时限：任何一项都不能拖住整个请求。ping 用 -c 1 -W 2，DNS 用 nslookup
//     的默认超时，整体目标 ≤ 3 s；
//   · 失败要如实说失败。这台设备上 192.168.3.1 就 ping 不通，把它写成
//     「通过」等于骗人；
//   · 不猜地址。网关从默认路由读，公网探针用固定 IP（不依赖 DNS 是否正常），
//     DNS 检查才用域名。

// 默认网关的 IP。从 /proc/net/route 读，比解析 ip route 的输出更稳。
function defaultGateway() {
	const text = readfile('/proc/net/route');

	if (text == null)
		return null;

	// 每行：Iface Destination Gateway Flags RefCnt Use Metric Mask ...
	// 目标为 00000000 的那行就是默认路由，网关是十六进制、小端序。
	for (let line in split(text, '\n')) {
		const f = split(trim(replace(line, /[ \t]+/g, ' ')), ' ');

		if (length(f) < 3 || f[1] != '00000000')
			continue;

		const hex = f[2];

		if (hex == null || length(hex) != 8)
			continue;

		const a = int(hex, 16);
		// 小端序：最低字节是第一个八位组
		const b0 = a & 0xff;
		const b1 = (a >> 8) & 0xff;
		const b2 = (a >> 16) & 0xff;
		const b3 = (a >> 24) & 0xff;

		if (a == 0)
			continue;

		return `${b0}.${b1}.${b2}.${b3}`;
	}

	return null;
}

// 跑一条命令并读回全部输出。失败时把原因带回去，而不是静默 null ——
// 诊断这个功能的意义就是把失败说清楚，吞掉错误等于自相矛盾。
function runCommand(cmd) {
	try {
		const proc = popen(cmd, 'r');

		if (proc == null)
			return { ok: false, error: '无法启动命令' };

		const text = proc.read('all') ?? '';
		proc.close();

		return { ok: true, text: text };
	}
	catch (e) {
		return { ok: false, error: `${e}` };
	}
}

// ping 一个地址，返回 { ok, loss, rtt }。rtt 单位 ms，取不到时为 null。
//
// 只发 1 个包：诊断的总预算 ≤ 3 s，而丢包时每个包要等满 -W 的秒数。
// 3 个包在 100% 丢包的线路上就是 6 s（实测 6016 ms），直接超预算。
// 单包判定不损失信息 —— 我们要回答的是「通不通」，不是统计质量。
function pingHost(ip) {
	if (ip == null)
		return { ok: false, error: '没有可探测的地址' };

	const run = runCommand(`ping -c 1 -W 2 ${ip} 2>&1`);

	if (!run.ok)
		return { ok: false, error: run.error };

	const text = run.text;
	const lossM = match(text, /([0-9]+)% packet loss/);
	const rttM = match(text, /round-trip[^=]*=[ \t]*([0-9.]+)\/([0-9.]+)\/([0-9.]+)/);

	const loss = lossM != null ? +lossM[1] : null;

	return {
		ok: loss != null && loss < 100,
		loss: loss,
		rtt: rttM != null ? +rttM[2] : null,
	};
}

// 解析一个域名，返回 { ok, ms, addrs }。
//
// 用 nslookup 而不是自己发 DNS 包：设备上一定有它（dnsmasq 自带的工具集），
// 而手写 DNS 报文会把一个诊断按钮变成协议实现。
function resolveHost(name) {
	if (name == null)
		return { ok: false, error: '没有可解析的域名' };

	const started = monotonic();
	const run = runCommand(`nslookup ${name} 2>&1`);
	const ms = (monotonic() - started) * 1000;

	if (!run.ok)
		return { ok: false, error: run.error, ms: ms };

	const text = run.text;

	// busybox 的输出分两段，前一段是本机用的 DNS 服务器：
	//
	//   Server:         202.103.225.68
	//   Address:        202.103.225.68:53     ← 这是服务器，不是答案
	//
	//   Non-authoritative answer:
	//   Name:   www.a.shifen.com
	//   Address: 183.2.172.177                ← 这才是解析结果
	//
	// 所以只能在 "Non-authoritative answer" 之后取 Address，否则会把 DNS
	// 服务器地址当成解析结果（实测就取成了 202.103.225.68:53）。
	//
	// 用 split 定位而不是 /Non-authoritative answer:([\s\S]*)/：ucode 的
	// 正则不支持 [\s\S] 这类字符类组合，匹配会静默失败，DNS 就永远显示未通过。
	const parts = split(text, 'Non-authoritative answer:');
	const body = (type(parts) == 'array' && length(parts) > 1)
		? parts[1]
		: '';

	// 可能有多个地址（含 IPv6），取第一个即可 —— 诊断要回答的是「能不能解出
	// 地址」，不是枚举全部记录。
	const m = match(body, /Address[ \t]*:[ \t]*([0-9a-fA-F.]+)/);

	if (m == null)
		return {
			ok: false,
			ms: ms,
			error: trim(split(text, '\n')[0] ?? '无结果'),
		};

	return { ok: true, ms: ms, addrs: m[1] };
}

// 对外：跑一次完整诊断。顺序是「就近到远」，这样失败点本身就能定位问题：
// 网关不通 = 局域网问题；网关通而公网不通 = 上行问题；两者都通而 DNS 不通
// = 解析问题。
function diagnose() {
	const started = monotonic();
	const gateway = defaultGateway();

	// 公网探针用 223.5.5.5（阿里公共 DNS）而不是 8.8.8.8。理由是实测：这台
	// 设备所在线路对 8.8.8.8 是 100% 丢包，对 223.5.5.5 是 21.8 ms 正常。
	// 用 8.8.8.8 会把「线路屏蔽了 Google DNS」报成「公网不通」，那是误诊 ——
	// 诊断的每一条结论都必须真的能推出设备有问题。
	//
	// 用 IP 而非域名，这一步就是要绕开 DNS 单独验证纯连通性。
	const probe = '223.5.5.5';

	const gw = gateway != null
		? pingHost(gateway)
		: { ok: false, error: '读不到默认路由' };

	const inet = pingHost(probe);
	const dns = resolveHost('www.baidu.com');

	const checks = [
		{
			key: 'gateway',
			label: '到网关',
			detail: gateway ?? '未找到默认网关',
			status: gw.ok ? 'pass' : 'fail',
			value: gw.rtt != null ? `${gw.rtt} ms` : null,
			loss: gw.loss,
			error: gw.error ?? null,
		},
		{
			key: 'internet',
			label: `到公网 ${probe}`,
			detail: 'ICMP，不依赖 DNS',
			status: inet.ok ? 'pass' : 'fail',
			value: inet.rtt != null ? `${inet.rtt} ms` : null,
			loss: inet.loss,
			error: inet.error ?? null,
		},
		{
			key: 'dns',
			label: 'DNS 解析',
			detail: 'www.baidu.com',
			// 解析不通但网关与公网都通，是「警告」而不是「失败」：网络能用，
			// 只是某些域名可能打不开。
			status: dns.ok ? 'pass' : (gw.ok && inet.ok ? 'warn' : 'fail'),
			value: dns.ok ? `${round(dns.ms)} ms` : null,
			addrs: dns.addrs ?? null,
			error: dns.error ?? null,
		},
	];

	// 丢包不是 0 也不是 100 时单独提出来：这类「通但抖」最难察觉。
	//
	// 用 `for (x in arr)` 而不是 `for (const c of arr)`：ucode 不支持 for...of，
	// 整个文件会因此在加载期失败 —— 而 rpcd 只会表现为「对象不存在」，
	// 看起来像 ACL 或安装问题，排查成本很高。
	for (let c in checks)
		if (c.status == 'pass' && c.loss != null && c.loss > 0) {
			c.status = 'warn';
			c.error = `丢包 ${c.loss}%`;
		}

	// 同理，ucode 的 filter 是全局函数 filter(arr, fn)，不是数组方法。
	const failed = length(filter(checks, function(c) { return c.status == 'fail'; }));
	const warned = length(filter(checks, function(c) { return c.status == 'warn'; }));

	return {
		ok: failed == 0,
		at: time(),
		elapsedMs: round((monotonic() - started) * 1000),
		gateway: gateway,
		checks: checks,
		// 一句话结论，前端直接显示，不用自己拼。
		verdict: failed > 0
			? `${failed} 项未通过`
			: (warned > 0 ? `${warned} 项需注意` : '全部通过'),
	};
}

const methods = {
	connections: {
		// rpcd 需要显式声明参数模式，否则 req.args 永远为空 —— 参数根本
		// 不会解析进来。类型名用 ucode 的类型标识（String），写成变量名
		// 虽然签名看着对，实际传参会被丢掉。
		args: { ip: 'String', limit: 'String' },
		call: function(req) {
			const ip = req?.args?.ip;

			if (type(ip) != 'string' || length(ip) == 0)
				return { result: 'ip 必填' };

			const limit = +(req?.args?.limit ?? DEFAULT_LIMIT);
			const read = readConnections();

			if (!read.ok)
				return { available: false, error: read.error, connections: [] };

			const mine = forHost(read.list, ip);
			const t = monotonic();
			const prev = lastSample[ip];
			const elapsed = prev != null ? t - prev.t : 0;

			// 按本次字节数从大到小排，保证 limit 截断后留下的是最活跃的连接，
			// 而不是连接表里恰好靠前的几条。
			sort(mine, function(a, b) {
				return (b.bytes_out + b.bytes_in) - (a.bytes_out + a.bytes_in);
			});

			const picked = length(mine) > limit ? slice(mine, 0, limit) : mine;
			const out = [];

			for (let c in picked) {
				const p = prev != null ? prev.byKey[connKey(c)] : null;
				let up = null;
				let down = null;

				if (p != null && elapsed > 0) {
					const dUp = c.bytes_out - p.out;
					const dDown = c.bytes_in - p.in;

					// 字节回落说明连接被复用，这时的差值不可信
					if (dUp >= 0)
						up = dUp / elapsed;

					if (dDown >= 0)
						down = dDown / elapsed;
				}

				push(out, {
					proto: c.proto,
					app: appFor(c.proto, c.dport, c.sport),
					state: c.state,
					family: c.family,
					src: c.src,
					sport: c.sport,
					dst: c.dst,
					dport: c.dport,
					bytes_out: c.bytes_out,
					bytes_in: c.bytes_in,
					up: up,
					down: down,
					// 内核没记账的连接，速率不可测，前端应显示“—”
					counted: c.counted,
				});
			}

			// 记住本轮采样；只存 ip 自己的连接，够下一轮算差分
			const byKey = {};

			for (let c in mine)
				byKey[connKey(c)] = { out: c.bytes_out, in: c.bytes_in };

			lastSample[ip] = { t: t, byKey: byKey };

			return {
				available: true,
				ip: ip,
				total: length(mine),
				shown: length(out),
				// LAN 网段，前端据此把“外网地址”列与内网对端区分开
				lan: lanPrefix(),
				// 首次调用没有上一轮采样，速率为 null，前端应显示“—”
				sampled: prev != null,
				connections: out,
			};
		}
	},

	resolve: {
		// 用逗号分隔的字符串而不是数组：rpcd 的 args 模式对复杂类型的
		// 支持随版本而异，String 在各版本上都可靠。
		args: { ips: 'String' },
		call: function(req) {
			const raw = req?.args?.ips;

			if (type(raw) != 'string' || length(raw) == 0)
				return { result: 'ips 必填（逗号分隔的地址列表）' };

			const ips = split(raw, ',');
			const leases = loadLeases();
			const names = {};

			for (let ip in ips) {
				if (leases[ip] != null)
					names[ip] = leases[ip];
			}

			// 租约没覆盖的地址再问一次 dnsmasq。它能给出静态租约、/etc/hosts
			// 和本机地址的名字（形如 vivo-Y52s.lan），而这些都不在
			// /tmp/dhcp.leases 里。反查走本机 127.0.0.1，实测 <1ms；
			// 只补空缺，不覆盖已有结果。
			const missing = [];

			for (let ip in ips)
				if (names[ip] == null && match(ip, /^[0-9.]+$/))
					push(missing, ip);

			// 一次最多查 16 个，避免一屏几百条连接时 fork 太多进程
			for (let ip in (length(missing) > 16 ? slice(missing, 0, 16) : missing)) {
				const name = reverseLookup(ip);

				if (name != null)
					names[ip] = name;
			}

			return { names: names };
		}
	},

	dashboard: {
		// sections 用逗号分隔的字符串而不是数组：与 resolve 的 ips 同理，
		// String 在各版本 rpcd 上都可靠。缺省 = "fast,slow,caps"。
		args: { sections: 'String' },		call: function(req) {
			const raw = req?.args?.sections;
			const want = (type(raw) == 'string' && length(raw) > 0)
				? raw
				: 'fast,slow,caps';
			const out = { available: true, at: monotonic() };

			if (index(want, 'caps') >= 0 || index(want, 'all') >= 0)
				out.caps = probeCaps();

			if (index(want, 'fast') >= 0 || index(want, 'all') >= 0) {
				const sample = fastSample();

				// CPU 与速率都是差分，必须有上一轮才有意义。
				// 首轮如实返回 null，前端显示“—”，不伪造 0。
				if (lastFast != null) {
					out.fast = {
						cpu: cpuUsage(lastFast.cpu, sample.cpu),
						cpuPer: cpuUsagePer(lastFast.cpu, sample.cpu),
						net: netRates(lastFast.net, sample.net, sample.at - lastFast.at),
						load: sample.load,
						uptime: sample.uptime,
						mem: sample.mem,
						temp: sample.temp,
						conntrack: sample.conntrack,
						sampled: true,
					};
				}
				else {
					out.fast = {
						cpu: null,
						cpuPer: null,
						net: null,
						load: sample.load,
						uptime: sample.uptime,
						mem: sample.mem,
						temp: sample.temp,
						conntrack: sample.conntrack,
						sampled: false,
					};
				}

				lastFast = sample;
			}

			if (index(want, 'slow') >= 0 || index(want, 'all') >= 0) {
				const state = loadHistory();

				out.slow = {
					// 回看：采样器累积的历史。没跑采样器时如实为空。
					history: state,
					// 连接表汇总：这是那 740 ms 的部分。
					conns: slowSummary(),
				};
			}

			// 阈值判定放这里统一做，并把当前生效的阈值一起回传：
			// 前端要能显示「这条用的是 80% 还是配置里的 92%」，否则用户
			// 改了配置看不出生效没有。
			//
			// 必须写成一行且不留尾随逗号：ucode 的解析器在两处都不接受，
			// 而报错位置指向 `);` 那行，看起来像别的问题。
			out.thresholds = alertConfigAll();
			const cpus = (out.caps != null) ? out.caps.cpus : null;

			out.alerts = buildAlerts(out.fast, out.slow, out.thresholds, cpus);

			return out;
		}
	},

	// 一键诊断：由按钮触发的一次性检查，跑完即结束，不参与后续刷新。
	// 无参数 —— 探针目标由后端决定（网关从路由表读，公网用固定 IP，
	// DNS 用域名），前端不该知道这些细节。
	diagnose: {
		call: function() {
			// 包一层：rpcd 会把未捕获异常变成 rc=247「Unknown error」，
			// 在设备上什么都查不到。把异常当成普通数据返回，前端（和调试时
			// 的 ubus call）就能直接看到原因。
			try {
				return diagnose();
			}
			catch (e) {
				return {
					ok: false,
					at: time(),
					elapsedMs: 0,
					gateway: null,
					checks: [],
					verdict: `诊断出错：${e}`,
					error: `${e}`,
				};
			}
		}
	},

	// 建立阈值配置文件。
	//
	// 存在的理由：UCI 的 ubus 接口在配置文件不存在时对 `add`/`set` 一律返回
	// 「Not found」，uci CLI 也一样（真机验证过），所以设置页没法自己造出这个
	// 文件。而配置文件是可选的，用户删掉它之后设置页必须还能恢复 —— 只有
	// rpcd 这个进程能直接写 /etc/config。
	//
	// 只写默认值，不写用户输入：写完之后前端重新 load 一次，表单就正常了。
	createConfig: {
		call: function() {
			const PATH = '/etc/config/shadcn-dashboard';

			try {
				// 已存在就不动，避免覆盖用户的编辑。
				if (readfile(PATH) != null)
					return { ok: true, created: false };

				const body = `# Thresholds for the Overview dashboard's anomaly banner.
#
# Created by the settings page (System -> Dashboard Alerts). Tracked as a
# conffile, so edits survive an upgrade. Deleting this file is supported: the
# dashboard falls back to the defaults written here.

config alert 'alert'
\toption conntrack_warn '${ALERT_DEFAULTS.conntrack_warn}'
\toption conntrack_crit '${ALERT_DEFAULTS.conntrack_crit}'
\toption mem_used '${ALERT_DEFAULTS.mem_used}'
\toption temp_warn '${ALERT_DEFAULTS.temp_warn}'
\toption temp_crit '${ALERT_DEFAULTS.temp_crit}'
\toption uncounted_share '${ALERT_DEFAULTS.uncounted_share}'
`;

				if (writefile(PATH, body) == null)
					return { ok: false, created: false, error: '写文件失败' };

				return { ok: true, created: true };
			}
			catch (e) {
				return { ok: false, created: false, error: `${e}` };
			}
		}
	},
};
return { shadcn: methods };

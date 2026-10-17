// SPDX-License-Identifier: Apache-2.0
//
// luci-theme-shadcn 的 rpcd 对象：为“在线主机”详情页提供逐条连接明细。
//
// 独立于 luci-app-trafficctl —— 那个包只给每主机汇总，没有逐条连接，
// 而本主题需要的是「某台主机的实时连接」。这里只读内核连接表，
// 不改任何配置，也不依赖 trafficctl 的内部结构。
//
// 对外方法：
//   connections { ip, limit? }  该主机的连接明细，含应用指纹与本次速率
//   resolve     { ips }        批量把地址反查成域名（只查本地已知的）
//
// 速率靠两次采样的字节差算，所以按地址缓存上一轮的采样。

'use strict';

import { readfile, popen } from 'fs';
import { parseConntrack, appFor, connKey } from 'shadcn.conntrack';

// rpcd 在独立进程里持有本对象，这份缓存随进程存活；连接消失后下一轮
// 调用会顺手覆盖，因此不会随连接数无限增长。
const lastSample = {};

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
};

return { shadcn: methods };

// SPDX-License-Identifier: Apache-2.0
//
// 主机连接数据采集：解析 conntrack 输出，为“在线主机”详情页提供逐条连接。
//
// 为什么不改 luci-app-trafficctl：那是独立的上游包，本模块只读内核数据，
// 与它零耦合。数据来源是 /proc/net/nf_conntrack（连接表）与 conntrack 命令。
//
// 硬件 offload 的连接在内核里不计字节（bytes 恒为 0）。这类连接仍然列出，
// 但速率与累计标记为不可用，而不是显示成 0 误导用户。

'use strict';

// 端口到应用的指纹。只做有把握的映射：未命中返回 null，前端回落到
// “协议/端口”，不做猜测。键必须是带引号的字符串 —— ucode 不接受裸数字键。
const PORT_APPS = {
	'20': 'FTP-DATA', '21': 'FTP', '22': 'SSH', '23': 'Telnet', '25': 'SMTP',
	'53': 'DNS', '67': 'DHCP', '68': 'DHCP', '69': 'TFTP', '80': 'HTTP',
	'110': 'POP3', '123': 'NTP', '137': 'NetBIOS', '138': 'NetBIOS',
	'139': 'SMB', '143': 'IMAP', '161': 'SNMP', '389': 'LDAP', '443': 'HTTPS',
	'445': 'SMB', '465': 'SMTPS', '514': 'Syslog', '587': 'SMTP',
	'636': 'LDAPS', '853': 'DoT', '993': 'IMAPS', '995': 'POP3S',
	'1080': 'SOCKS', '1194': 'OpenVPN', '1883': 'MQTT', '1900': 'SSDP',
	'3306': 'MySQL', '3389': 'RDP', '3478': 'STUN', '5353': 'mDNS',
	'5432': 'PostgreSQL', '6379': 'Redis', '8080': 'HTTP', '8443': 'HTTPS',
	'8888': 'HTTP-Proxy', '9090': 'HTTP', '27017': 'MongoDB',
};

// 应用名：先按目的端口判定，再看源端口（服务端方向的连接）。
export function appFor(proto, dport, sport) {
	const byDport = PORT_APPS[dport];

	if (byDport != null)
		return byDport;

	const bySport = PORT_APPS[sport];

	return bySport != null ? bySport : null;
}

// 按空白切分一行。ucode 的 split 用固定分隔符更可靠，所以先统一成空格。
function words(line) {
	return split(replace(line, /[ \t]+/g, ' '), ' ');
}

// 从一行里按出现顺序取出所有 key=value 对。
//
// ucode 的 match(s, /re/g) 一次返回全部匹配，每个元素是
// [整段, 分组1, 分组2, ...]，与 JS 里 exec 的循环结果同形。
function pairsOf(line) {
	const out = [];

	for (let m in match(line, /\b(src|dst|sport|dport|packets|bytes)=([0-9a-fA-F.:]+)/g) ?? [])
		push(out, { key: m[1], val: m[2] });

	return out;
}

// 解析 conntrack 的一行。无法识别时返回 null。
//
// 形如（ipv4 前缀与协议族编号是可选的）：
//   ipv4 2 tcp 6 431999 ESTABLISHED src=A dst=B sport=C dport=D \
//     packets=N bytes=M src=B dst=A sport=D dport=C packets=N bytes=M \
//     [ASSURED] mark=0 use=1
export function parseConnLine(line) {
	if (line == null)
		return null;

	const text = trim(line);

	if (length(text) == 0)
		return null;

	const f = words(text);

	// tcp 行至少要有：tcp 6 <state-ish> src=... 四段以上
	if (length(f) < 5)
		return null;

	let i = 0;
	let family = null;

	if (f[i] == 'ipv4' || f[i] == 'ipv6') {
		family = f[i];
		i++;

		// 紧随其后的协议族编号
		if (match(f[i], /^[0-9]+$/))
			i++;
	}

	const proto = f[i];

	if (proto != 'tcp' && proto != 'udp' && proto != 'icmp' && proto != 'sctp')
		return null;

	i++;					// 跳过协议名
	if (match(f[i], /^[0-9]+$/))
		i++;				// 跳过协议号

	let timeout = null;

	// TCP/UDP 在协议号之后是剩余超时秒数
	if (match(f[i] ?? '', /^[0-9]+$/)) {
		timeout = +f[i];
		i++;
	}

	// 状态是裸词，出现在 src= 之前；[ASSURED] / [OFFLOAD] 这类标记却写在
	// 行尾（在两条元组之后）。因此状态在头部扫描，标记在整行上找 —— 两者
	// 不能用同一个循环，否则标记永远扫不到。
	let state = null;
	let assured = false;
	let offloaded = false;

	for (; i < length(f); i++) {
		const tok = f[i];

		if (length(tok) == 0)
			continue;

		// 走到第一个 key=value 就说明头部结束
		if (match(tok, /=/))
			break;

		if (match(tok, /^[A-Z][A-Z0-9_]*$/))
			state = tok;
	}

	if (index(text, '[ASSURED]') >= 0)
		assured = true;

	if (index(text, '[OFFLOAD]') >= 0)
		offloaded = true;

	const pairs = pairsOf(text);

	if (length(pairs) < 4)
		return null;

	// 一行里有两条完整元组，各自由 src/dst/sport/dport/packets/bytes 组成：
	//   <orig...> <reply...> [标记]
	// 不能按“前 4 项 / 后 4 项”切 —— 每组是 6 个键，按 4 切会把 packets
	// 和 bytes 错配到另一个方向（表现为 bytes_out 恒为 0）。
	//
	// 第二次出现的 src= 就是应答方向的起点，用它的位置切开两组。
	const orig = {};
	const reply = {};
	let seenSrc = 0;

	for (let p in pairs) {
		if (p.key == 'src')
			seenSrc++;

		if (seenSrc <= 1)
			orig[p.key] = p.val;
		else
			reply[p.key] = p.val;
	}

	if (orig.src == null || orig.dst == null)
		return null;

	const bytesOut = +(orig.bytes ?? 0);
	const bytesIn = +(reply.bytes ?? 0);

	// 没有状态词时给出诚实的兜底：OFFLOAD 连接在连接表里本来就不带
	// TCP 状态，这不是解析失败。
	if (state == null)
		state = offloaded ? 'OFFLOADED' : (assured ? 'ASSURED' : 'UNKNOWN');

	return {
		family: family != null ? family : (index(orig.src, ':') >= 0 ? 'ipv6' : 'ipv4'),
		proto,
		state,
		assured,
		offloaded,
		timeout,
		src: orig.src,
		dst: orig.dst,
		sport: +(orig.sport ?? 0),
		dport: +(orig.dport ?? 0),
		bytes_out: bytesOut,
		bytes_in: bytesIn,
		packets_out: +(orig.packets ?? 0),
		packets_in: +(reply.packets ?? 0),
		// offload 连接并不代表字节数为 0：内核照样记账，只是转发不走软件
		// 路径。所以以字节计数为准，只有字节确为 0 才标记“不可测”。
		counted: (bytesOut + bytesIn) > 0,
	};
}

// 把 conntrack 全文解析成连接数组，跳过无法识别的行。
export function parseConntrack(text) {
	const out = [];

	for (let line in split(text ?? '', '\n')) {
		const rec = parseConnLine(line);

		if (rec != null)
			push(out, rec);
	}

	return out;
}

// 一条连接的唯一键：单向五元组。用于跨两次采样对齐以计算速率。
export function connKey(c) {
	return `${c.proto}|${c.src}|${c.sport}|${c.dst}|${c.dport}`;
}

// 用两次采样算每条连接的上下行速率（字节/秒）。
//
// 只对两次都出现、字节数没有回落的连接计算；新连接与 offload 连接记为
// null —— 前端据此显示“—”，不伪造 0。
export function rateFor(current, prev, elapsedSec) {
	if (prev == null || !(elapsedSec > 0) || !current.counted)
		return { up: null, down: null };

	const dUp = current.bytes_out - prev.bytes_out;
	const dDown = current.bytes_in - prev.bytes_in;

	// 字节回落说明连接被复用，增量不可信
	return {
		up: dUp >= 0 ? dUp / elapsedSec : null,
		down: dDown >= 0 ? dDown / elapsedSec : null,
	};
}

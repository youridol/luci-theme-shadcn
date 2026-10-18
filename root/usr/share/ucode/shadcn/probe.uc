// SPDX-License-Identifier: Apache-2.0
//
// 概览看板的采集原语：能力探测与快路径读取。
//
// 设计约束（.dev/docs/adr/0005-sampler-tmpfs-and-procd.md）：
//   · 判定基准只能是「有没有这个文件 / 这个对象」，不按设备型号分支 ——
//     CI 目标机是 x86/64，性能基线来自 ARMv8，同一份代码要在两者上都不失真；
//   · 快路径只读常量级文件（/proc/net/dev、/proc/loadavg、/proc/meminfo、
//     温度），成本与连接数无关；
//   · 探测不到的能力如实返回带 reason 的不可用，不编造 0。
//
// 与 conntrack.uc 同一约定：具名 export function，调用方 import { … }。
//
// 只用 ucode 官方文档（ucode-lang.org/ucode/module-fs.html）列明的原语：
// readfile、lsdir、statvfs、writefile，以及 core 的 split/match/length/push/
// trim/type/clock。不用 toFixed：一位小数的舍入在 round1() 里手算。
//
// ucode 没有函数提升：所有函数都在调用它的代码之前声明。

'use strict';

import { readfile, lsdir, statvfs } from 'fs';
import { round } from 'math';

// 读一个十进制整数文件，失败返回 null。
export function readNumber(path) {
	const raw = readfile(path);

	if (raw == null)
		return null;

	const text = trim(raw);

	return match(text, /^-?[0-9]+$/) != null ? +text : null;
}

// 把 "Key:   123 kB" 形式的 /proc/meminfo 读成对象（单位 KB，原样）。
export function meminfo() {
	const text = readfile('/proc/meminfo');
	const out = {};

	if (text == null)
		return out;

	for (let line in split(text, '\n')) {
		const m = match(line, /^([A-Za-z_()0-9]+):[ \t]+([0-9]+)/);

		if (m != null)
			out[m[1]] = +m[2];
	}

	return out;
}

// /proc/uptime：第一列是开机以来的秒数，第二列是所有核空闲秒数之和。
//
// 只需要第一列。读不到就返回 null，由前端显示「—」而**不是** 0 —— 0 秒会
// 被读成「刚重启」，那是另一种意思。
export function uptime() {
	const text = readfile('/proc/uptime');

	if (text == null)
		return null;

	const m = match(text, /^([0-9]+)/);

	return m != null ? +m[1] : null;
}

// /proc/loadavg：前三数是 1/5/15 分钟负载，第四个是 "running/total"。
export function loadavg() {
	const text = readfile('/proc/loadavg');

	if (text == null)
		return null;

	const m = match(text, /^([0-9.]+) ([0-9.]+) ([0-9.]+) ([0-9]+)\/([0-9]+)/);

	if (m == null)
		return null;

	return {
		one: +m[1],
		five: +m[2],
		fifteen: +m[3],
		running: +m[4],
		processes: +m[5],
	};
}

// 每核累计时间片。这是开机以来的累计值，单次读取算不出使用率 ——
// 使用率是两次采样之间的增量比，调用方负责持有上一轮。
export function cpuTimes() {
	const text = readfile('/proc/stat');

	if (text == null)
		return null;

	const out = { total: null, per: [] };

	for (let line in split(text, '\n')) {
		const m = match(line, /^cpu([0-9]*)[ \t]+([0-9 ]+)$/);

		if (m == null)
			continue;

		const nums = [];

		for (let v in split(trim(m[2]), ' '))
			if (length(v) > 0)
				push(nums, +v);

		// user nice system idle iowait irq softirq steal guest guest_nice
		// idle 计入 iowait：内核的 idle 不含等 IO 的时间，只减 idle 会把
		// iowait 算成“忙”。
		const idle = nums[3] + (nums[4] ?? 0);
		let sum = 0;

		for (let v in nums)
			sum += v;

		if (m[1] == '')
			out.total = { idle: idle, total: sum };
		else
			push(out.per, { index: +m[1], idle: idle, total: sum });
	}

	return out.total != null ? out : null;
}

// 用两次 cpuTimes() 求总使用率（百分比）。
// 任一侧缺失、或总量没增长（计数器被重置）时返回 null。
//
// 除法必须先转 double：ucode 的 int 除法向零截断，增量小时（两次读数间隔
// 很短，dTotal 可能只有个位数）`dIdle / dTotal` 会直接变成 0，于是算出
// 100% —— 真机上系统空闲、dTotal=4 dIdle=3 时就是这样得到 100 的。
export function cpuUsage(prev, cur) {
	if (prev == null || cur == null || prev.total == null || cur.total == null)
		return null;

	const dTotal = cur.total.total - prev.total.total;
	const dIdle = cur.total.idle - prev.total.idle;

	if (!(dTotal > 0) || dIdle < 0)
		return null;

	const pct = (1 - (dIdle + 0.0) / (dTotal + 0.0)) * 100;

	return (pct >= 0 && pct <= 100) ? pct : null;
}

// 一位小数。
//
// 两个真机上踩到的坑，都写在这里免得下次重犯：
//   · round() 来自 math 模块，ucode 全局没有 Math 对象（Math.floor 会抛
//     “access to undeclared variable Math”，而调用方会吞掉它，表现为整块
//     数据静默消失）。
//   · round(x) 默认返回 int，而 ucode 的整数除法向零截断 ——
//     `round(34.4) / 10` 是 `34 / 10` = 3，不是 3.4。第二个参数传 true 让它
//     返回 double，除法才保留小数。
export function round1(v) {
	return round(v * 10, true) / 10;
}

// 每核使用率，顺序与 /proc/stat 一致。核数不等时整组作废。
//
// 保留一位小数：整数会把 3.4% 与 4.4% 显示成同一个数，而 toFixed 是否存在
// 于 rpcd 的 ucode 构建里没有在本仓库验证过。
export function cpuUsagePer(prev, cur) {
	if (prev == null || cur == null || length(prev.per) != length(cur.per))
		return null;

	const out = [];

	for (let i = 0; i < length(cur.per); i++) {
		const dTotal = cur.per[i].total - prev.per[i].total;
		const dIdle = cur.per[i].idle - prev.per[i].idle;

		if (!(dTotal > 0) || dIdle < 0)
			return null;

		const pct = (1 - (dIdle + 0.0) / (dTotal + 0.0)) * 100;

		if (!(pct >= 0 && pct <= 100))
			return null;

		push(out, round1(pct));
	}

	return out;
}

// 各网口的**协商速率**（链路层握手速度，不是当前吞吐）。
//
// 数据源 /sys/class/net/<if>/speed，单位 Mb/s，读一个文件即可，不用 fork
// ethtool —— 这个值要随快路径每秒返回，fork 的代价比读文件高两个数量级。
//
// 三点必须注意：
//   · 读不到（接口 down、虚拟接口、读写失败）时该值是 -EINVAL，写进文件里
//     就是 "-1"。这里一律返回 null，让前端显示「—」而不是「-1 Mb/s」。
//   · pppoe-wan / ifb* 这类虚拟接口没有物理速率，本来就该是 null；它们的
//     「速率」应当看底层承载（eth1）。前端会跳过这些名字。
//   · 只在速率变化时才有意义，但它秒级不变，所以不进差分计算 —— 与 netDev
//     分开，避免污染累计字节的历史点。
export function linkSpeeds() {
	const out = {};
	const dirs = lsdir('/sys/class/net') ?? [];

	for (let name in dirs) {
		const raw = readfile(`/sys/class/net/${name}/speed`);

		if (raw == null)
			continue;

		const v = +trim(raw);

		// -1 / 0 / 非数字都当「没有协商速率」，不要伪装成 0 Mb/s。
		if (!(v > 0))
			continue;

		out[name] = v;
	}

	return out;
}

// 各网口累计收发字节。/proc/net/dev 每行形如：
//   eth0: 1234567 890 0 0 0 0 0 0 7654321 321 0 0 0 0 0 0
// 冒号前是接口名；冒号后第 1 个是收字节、第 9 个是发字节。
export function netDev() {
	const text = readfile('/proc/net/dev');

	if (text == null)
		return null;

	const out = {};

	for (let line in split(text, '\n')) {
		const m = match(line, /^[ \t]*([^:]+):[ \t]*(.+)$/);

		if (m == null)
			continue;

		const name = trim(m[1]);
		const nums = [];

		for (let v in split(trim(m[2]), ' '))
			if (length(v) > 0)
				push(nums, +v);

		if (length(nums) < 16)
			continue;

		out[name] = { rx: nums[0], tx: nums[8] };
	}

	return out;
}

// 系统温度（摄氏度）。
//
// 判定顺序：thermal_zone 优先（ARM 路由器都是这条），其次 hwmon 的
// coretemp / k10temp / cpu_thermal（x86 常见）。都没有则如实返回不可用并带
// 原因 —— x86 上不该出现温度卡，而不是把 0°C 画成正常。
export function temperature() {
	const readings = [];
	const zones = lsdir('/sys/class/thermal') ?? [];

	for (let z in zones) {
		if (match(z, /^thermal_zone[0-9]+$/) == null)
			continue;

		const milli = readNumber(`/sys/class/thermal/${z}/temp`);

		if (milli == null)
			continue;

		const label = readfile(`/sys/class/thermal/${z}/type`);

		push(readings, {
			source: z,
			label: label != null ? trim(label) : z,
			celsius: milli / 1000,
		});
	}

	if (length(readings) == 0) {
		// x86：hwmon 下按芯片名挑
		for (let h in lsdir('/sys/class/hwmon') ?? []) {
			if (match(h, /^hwmon[0-9]+$/) == null)
				continue;

			const chip = readfile(`/sys/class/hwmon/${h}/name`);

			if (chip == null)
				continue;

			const name = trim(chip);

			if (name != 'coretemp' && name != 'k10temp' && name != 'cpu_thermal')
				continue;

			for (let f in lsdir(`/sys/class/hwmon/${h}`) ?? []) {
				if (match(f, /^temp[0-9]+_input$/) == null)
					continue;

				const milli = readNumber(`/sys/class/hwmon/${h}/${f}`);

				if (milli == null)
					continue;

				push(readings, {
					source: `${h}/${f}`,
					label: name,
					celsius: milli / 1000,
				});
			}
		}
	}

	if (length(readings) == 0)
		return {
			available: false,
			reason: '无温度传感器（thermal_zone 与 hwmon 都读不到）',
			readings: [],
			max: null,
		};

	let max = readings[0].celsius;

	for (let r in readings)
		if (r.celsius > max)
			max = r.celsius;

	return { available: true, readings: readings, max: max };
}

// 存储占用：给一个挂载点路径，返回字节数。
// statvfs 的 freesize / totalsize 是官方给出的便捷字段（frsize*bfree 与
// frsize*blocks）；读不到就返回带 reason 的不可用。
export function storage(path) {
	const s = statvfs(path);

	if (s == null || s.totalsize == null || !(s.totalsize > 0))
		return { available: false, reason: `读不到 ${path} 的文件系统统计` };

	const used = s.totalsize - s.freesize;

	return {
		available: true,
		path: path,
		total: s.totalsize,
		free: s.freesize,
		used: used,
	// 同 conntrack：int 除法会截断，used/total 通常 <1，直接算得 0。
		percent: ((used + 0.0) / (s.totalsize + 0.0)) * 100,
	};
}

// 连接表当前条数与上限，用来算占用率。
export function conntrack() {
	const count = readNumber('/proc/sys/net/netfilter/nf_conntrack_count');
	const max = readNumber('/proc/sys/net/netfilter/nf_conntrack_max');

	if (count == null)
		return {
			available: false,
			reason: '未启用连接跟踪（读不到 nf_conntrack_count）',
		};

	// 除法两侧必须显式转 double：ucode 的 int 除法向零截断，1145/1400 会
	// 变成 0，再乘 100 仍是 0 —— 占用率恒为 0%，于是「连接表接近上限」这条
	// 告警永远不会触发（真机上 81% 占用时就是这样静默失效的）。
	return {
		available: true,
		count: count,
		max: max,
		percent: (max != null && max > 0)
			? ((count + 0.0) / (max + 0.0)) * 100
			: null,
	};
}

// WAN 拨号信息：IPv4 地址/网关/协议、IPv6 地址与前缀、DNS、在线时长。
//
// 与 board() 不同，这份数据会变（重拨、租约续期、IPv6 前缀更换），所以不能
// 永久缓存；但它也不需要每秒读一次 —— 拨号状态秒级不变。用 10 秒 TTL：
// 重拨后最多 10 秒就能看到新地址，同时把每秒一次的 ubus 往返摊薄到 1/10。
//
// 数据源是 network.interface.<name> 的 ubus status。IPv4 挂在 wan 上，IPv6
// 挂在 wan_6 上（实测这台机器 wan 只有 link-local，公网 240e:… 在 wan_6），
// 所以两个接口都要查。接口名不写死：从 /etc/config/network 里找 proto 为
// pppoe/dhcp/dhcpv6 的段，取不到再退回 wan / wan_6 这两个约定名。
let WAN_CACHE = null;
let WAN_CACHE_AT = 0;
const WAN_TTL = 10;

function ubusStatus(conn, iface) {
	try {
		return conn.call('network.interface.' + iface, 'status', {});
	}
	catch (e) {
		return null;
	}
}

export function wanInfo() {
	const now = clock(true);
	const nowSec = (type(now) == 'array') ? (now[0] + now[1] / 1000000000.0) : +(now ?? 0);

	if (WAN_CACHE != null && (nowSec - WAN_CACHE_AT) < WAN_TTL)
		return WAN_CACHE;

	let conn = null;

	try {
		conn = require('ubus').connect();
	}
	catch (e) {
		return WAN_CACHE ?? { available: false, reason: `无法连接 ubus：${e}` };
	}

	const wan = ubusStatus(conn, 'wan');
	const wan6 = ubusStatus(conn, 'wan_6');

	// 两个接口都读不到才算不可用。
	if (wan == null && wan6 == null) {
		WAN_CACHE = { available: false, reason: '读不到 WAN 接口状态' };
		WAN_CACHE_AT = nowSec;
		return WAN_CACHE;
	}

	const v4 = [];
	for (let a in wan?.['ipv4-address'] ?? [])
		if (a.address != null)
			push(v4, { address: a.address, mask: a.mask ?? null });

	const v6 = [];

	// wan_6 上的公网地址（按 preferred 时长排序由内核保证，这里原样取）。
	for (let a in wan6?.['ipv6-address'] ?? []) {
		// 跳过 link-local：不是「拨号拿到的地址」，列出来只会让人以为有公网 v6。
		if (a.address != null && match(a.address, /^fe[89ab]/i) == null)
			push(v6, { address: a.address, mask: a.mask ?? null });
	}

	// 委派给 LAN 的前缀是运维最关心的（决定内网 v6 段），前端也靠它把
	// 「委派前缀下的设备地址」认成内网主机 —— 实测那些地址既不是 link-local
	// 也不是 ULA（240e:0355:...），只按地址类别判会把内网设备全漏掉。
	const prefixes = [];
	for (let p in wan6?.['ipv6-prefix'] ?? [])
		if (p.address != null)
			push(prefixes, {
				address: p.address,
				mask: p.mask ?? null,
				// 是否分给了 LAN（有 assigned.lan 就是），前端据此区分
				// 「运营商给的整段」与「实际下发给内网的段」。
				lan: p.assigned != null && p.assigned.lan != null,
			});

	const dns = [];

	for (let d in wan?.['dns-server'] ?? [])
		push(dns, d);

	const uptime = (wan != null && wan.uptime != null) ? wan.uptime : null;

	WAN_CACHE = {
		available: true,
		proto: wan?.proto ?? wan6?.proto ?? null,
		l3dev: wan?.l3_device ?? wan6?.l3_device ?? null,
		up: wan != null ? (wan.up == true) : (wan6 != null ? wan6.up == true : false),
		uptime: uptime,
		v4: v4,
		v6: v6,
		prefixes: prefixes,
		dns: dns,
	};

	WAN_CACHE_AT = nowSec;
	return WAN_CACHE;
}

// 系统信息：主机名、内核、发行版、架构、CPU 型号。
//
// 这些都是**静态**的（除非重刷固件），而 caps() 每次快路径都会被调用，
// 所以读一次就缓存在模块作用域里。ucode 的模块是进程内单例，rpcd 长期存活，
// 因此这份缓存的有效期就是 rpcd 的寿命 —— 对「固件版本」这类数据来说足够。
//
// 全部走 /proc 与 /etc/*_release，不 fork 命令：uname 要 fork，而这里每个
// 字段都有等价的文件。
let BOARD_CACHE = null;

export function board() {
	if (BOARD_CACHE != null)
		return BOARD_CACHE;

	const release = {};
	const text = readfile('/etc/openwrt_release');

	if (text != null) {
		for (let line in split(text, '\n')) {
			const m = match(line, /^([A-Z_]+)='([^']*)'/);

			if (m != null)
				release[m[1]] = m[2];
		}
	}

	// /proc/cpuinfo 的键名按优先级找：x86 用 "model name"，ARM 用
	// "Processor"/"model"。
	//
	// **顺序不能合并成一条交替正则**：x86 的 cpuinfo 里同时有
	// `model : 55`（CPU 型号编号）和 `model name : Intel(R) … N2930`，
	// 交替写法会先撞上 `model`，把型号名读成 "55"（真机上就是这样）。
	// 所以按优先级逐个找，找到就停。
	//
	// 逐行扫，不用多行正则：ucode 的正则不认 `m` 标志，也不认 `(?:…)`
	// 非捕获组，后者报 "Repetition not preceded by valid expression"，而报错
	// 会连带让整个 caps() 失败 —— 表现为 ubus 返回 Unknown error，看板后端
	// 数据全没。
	const cpuinfo = readfile('/proc/cpuinfo') ?? '';
	const CPU_KEYS = ['model name', 'Processor', 'model', 'Model'];
	let cpuModel = null;

	for (let key in CPU_KEYS) {
		if (cpuModel != null)
			break;

		for (let line in split(cpuinfo, '\n')) {
			// 按第一个冒号切开，两边各自 trim。不靠 substr/length 数偏移：
			// 键与值之间是 tab 加若干空格，手算偏移容易错位（实测读成了
			// 空字符串）。
			const at = index(line, ':');

			if (at < 0)
				continue;

			if (trim(substr(line, 0, at)) != key)
				continue;

			const value = trim(substr(line, at + 1));

			// 纯数字的是型号编号，不是型号名（x86 的 `model : 55`）。
			if (value != '' && match(value, /^[0-9]+$/) == null) {
				cpuModel = value;
				break;
			}
		}
	}

	BOARD_CACHE = {
		hostname: trim(readfile('/proc/sys/kernel/hostname') ?? '') || null,
		kernel: trim(readfile('/proc/sys/kernel/osrelease') ?? '') || null,
		cpu: cpuModel,
		distribution: release.DISTRIB_ID ?? null,
		version: release.DISTRIB_RELEASE ?? null,
		target: release.DISTRIB_TARGET ?? null,
		arch: release.DISTRIB_ARCH ?? null,
	};

	return BOARD_CACHE;
}

// 对外：一次能力探测。前端据此决定画哪些卡，而不是自己猜。
//
// cpus 也在这里回报：负载告警的判据是「1 分钟负载 > 核数」，而前端拿不到
// /proc/stat 的核数。少这个字段会让负载告警永远不触发（条件恒为假），
// 而且不报错 —— 真机上就是这样静默失效的。
export function caps() {
	const temp = temperature();
	const conn = conntrack();
	const net = netDev();
	const cpu = cpuTimes();
	const ports = [];

	for (let name in net ?? {})
		push(ports, name);

	return {
		temperature: {
			available: temp.available,
			reason: temp.reason ?? null,
			sensors: length(temp.readings),
		},
		conntrack: conn.available,
		// 每核一项，长度即核数；读不到时如实给 0。
		cpus: length(cpu != null ? cpu.per : []),
		ports: ports,
		// 静态系统信息（主机名/内核/发行版/架构/CPU），已缓存。
		board: board(),
		// WAN 拨号信息（v4/v6 地址、前缀、DNS、在线时长）。10 秒 TTL。
		wan: wanInfo(),
		// 各网口协商速率（Mb/s）。链路速度不会秒级变化，5 秒缓存一次即可，
		// 免得每秒都去 lsdir + readfile 一遍。
		speeds: linkSpeeds(),
	};
}

// 对外：快路径一次取全。调用方保存上一轮用于算速率与使用率。
export function fastSample() {
	const mem = meminfo();
	const totalKb = mem['MemTotal'] ?? null;
	// “可用”取 MemAvailable：它把可回收缓存算进来，比 MemFree 更接近用户感知
	// 的剩余内存（2.6.27 起所有受支持内核都有这个字段）。
	const availKb = mem['MemAvailable'] ?? (mem['MemFree'] ?? null);
	const c = clock(true);
	const at = (type(c) == 'array') ? (c[0] + c[1] / 1000000000.0) : +(c ?? 0);

	return {
		cpu: cpuTimes(),
		load: loadavg(),
		// 运行时长：运维判断「这次重启是不是刚发生」的第一依据，也解释了
		// 为什么回看历史从某个时刻起才有数据。
		uptime: uptime(),
		mem: (totalKb != null && availKb != null)
			? {
				total: totalKb * 1024,
				available: availKb * 1024,
				used: (totalKb - availKb) * 1024,
				// 同 conntrack / storage：int 除法会截断。内存占用几乎不会
				// 正好是整数百分比，不转 double 就会恒定显示 0%。
				percent: ((totalKb - availKb + 0.0) / (totalKb + 0.0)) * 100,
			}
			: null,
		temp: temperature(),
		conntrack: conntrack(),
		net: netDev(),
		at: at,
	};
}

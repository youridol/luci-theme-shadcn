#!/usr/bin/ucode
// SPDX-License-Identifier: Apache-2.0
//
// 看板采样器：按固定粒度把「线路收发字节」与「资源占用」记进 tmpfs 上的
// 环形文件，供慢路径回看（今日流量、24 小时柱状图）。
//
// 为什么是独立进程而不是放进 rpcd：
//   rpcd 是请求驱动的，浏览器关掉之后没人调用它，采样就断了；而「今日总流量」
//   本来就要在没人看的时候也在累积。这是 .dev/docs/adr/0005 里 procd 方案
//   的理由。
//
// 三条硬纪律（同 ADR 0005）：
//   · 只写 /tmp（tmpfs），不磨 Flash；重启后清零，界面要能表达「自 <时间> 起」；
//   · 粒度 1 分钟、只留 24 小时（1440 点），单线路几十 KB；
//   · 只做常量级读取 + 一次写：一次 /proc/net/dev 与一次 /proc/meminfo，
//     不碰连接表（那条路径真机实测约 740 ms，属于慢路径的活）。
//
// ucode 没有函数提升：所有函数在调用它的代码之前声明。

'use strict';

import { readfile, writefile, mkdir, access, popen } from 'fs';

// 与 shadcn.uc 保持一致的时间源：clock(true) 返回 [秒, 纳秒]。
function monotonic() {
	const c = clock(true);

	if (type(c) == 'array')
		return c[0] + (c[1] / 1000000000.0);

	return +(c ?? 0);
}

// 墙钟秒。环形文件里存的是绝对时间，重启后前端要能算出「自何时起」。
function epoch() {
	const c = clock();

	if (type(c) == 'array')
		return c[0];

	return +(c ?? 0);
}

function readNumber(path) {
	const raw = readfile(path);

	if (raw == null)
		return null;

	const text = trim(raw);

	return match(text, /^-?[0-9]+$/) != null ? +text : null;
}

// 各网口累计收字节。只要 rx / tx 两个数，其余字段不解析。
function netCounters() {
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

// 一次采样记录里的资源部分。只留看板要画的那几个数，不整块搬 meminfo。
function resources() {
	const mem = {};
	const text = readfile('/proc/meminfo');

	if (text != null) {
		for (let line in split(text, '\n')) {
			const m = match(line, /^([A-Za-z_()0-9]+):[ \t]+([0-9]+)/);

			if (m != null)
				mem[m[1]] = +m[2];
		}
	}

	const totalKb = mem['MemTotal'] ?? null;
	const availKb = mem['MemAvailable'] ?? (mem['MemFree'] ?? null);

	const loadText = readfile('/proc/loadavg');
	let load = null;

	if (loadText != null) {
		const m = match(loadText, /^([0-9.]+) ([0-9.]+) ([0-9.]+)/);

		if (m != null)
			load = { one: +m[1], five: +m[2], fifteen: +m[3] };
	}

	let conntrack = null;

	const ctCount = readNumber('/proc/sys/net/netfilter/nf_conntrack_count');
	const ctMax = readNumber('/proc/sys/net/netfilter/nf_conntrack_max');

	if (ctCount != null)
		conntrack = { count: ctCount, max: ctMax };

	// 温度取所有 thermal_zone 的最大值：看板只画一个仪表，不需要逐个列。
	let temp = null;

	for (let i = 0; i < 8; i++) {
		const milli = readNumber(`/sys/class/thermal/thermal_zone${i}/temp`);

		if (milli == null)
			continue;

		const celsius = milli / 1000;

		if (temp == null || celsius > temp)
			temp = celsius;
	}

	return {
		mem: (totalKb != null && availKb != null)
			? { total: totalKb * 1024, available: availKb * 1024 }
			: null,
		load: load,
		conntrack: conntrack,
		temp: temp,
	};
}

// 环形文件：{ v, started, step, points: [ {t, net:{if:{rx,tx}}, res:{…}} ] }
//
// 读失败或格式不符时返回空骨架 —— 采样器宁可从头开始，也不要把损坏的
// 历史混进新数据。
const STATE_PATH = '/tmp/shadcn-dashboard/history.json';
const STEP_SEC = 60;
const MAX_POINTS = 1440;		// 24 小时 × 60 分钟

function loadState() {
	const raw = readfile(STATE_PATH);

	if (raw == null)
		return { v: 1, started: null, step: STEP_SEC, points: [] };

	let parsed = null;

	try {
		parsed = json(raw);
	}
	catch (e) {
		return { v: 1, started: null, step: STEP_SEC, points: [] };
	}

	if (type(parsed) != 'object' || type(parsed.points) != 'array')
		return { v: 1, started: null, step: STEP_SEC, points: [] };

	// 步长变了（用户改了配置）就丢弃旧序列：混着两种粒度的时间轴画不出
	// 正确的柱状图。
	if (parsed.step != STEP_SEC)
		return { v: 1, started: null, step: STEP_SEC, points: [] };

	return parsed;
}

function saveState(state) {
	// 目录可能不存在（首次运行，或 tmpfs 被清空）。
	// access(path, 'f') 测「存在」；mkdir 对已存在的目录会失败，所以先测。
	if (access('/tmp/shadcn-dashboard', 'f') != true)
		mkdir('/tmp/shadcn-dashboard');

	// writefile 把对象按 JSON 序列化写入，正好是这里需要的。
	writefile(STATE_PATH, state);
}

// 采一个点。net 存的是「累计字节」，前端用相邻两点求差分算速率；
// 存速率会让「漏采一个点」变成永久性错误。
function sampleOnce(state) {
	const net = netCounters();

	if (net == null)
		return false;

	const point = {
		t: epoch(),
		net: net,
		res: resources(),
	};

	push(state.points, point);

	// 只留最近 MAX_POINTS 个点
	if (length(state.points) > MAX_POINTS)
		state.points = slice(state.points, length(state.points) - MAX_POINTS);

	if (state.started == null)
		state.started = point.t;

	saveState(state);

	return true;
}

// ── 丢包率采样 ─────────────────────────────────────────────────────────────
//
// 为什么要单独一份、为什么放在采样器里：
//
//   · 丢包率必须靠 ping 统计，而 ping 是阻塞的（-c 5 就是实打实的 5 秒，
//     全丢时还要加上每个包的 -W 等待）。放进 rpcd 的请求路径会直接把这轮
//     快路径拖到秒级，看板 1 秒的节奏就废了。
//   · 所以丢包率不进 ubus 请求，改由采样器在后台周期性测，结果写进 tmpfs，
//     接口只读一份现成的数。前端拿到的是「最近一次测出来的值 + 测的时间」，
//     和「实时速率」那种差分指标性质不同，脚注里会标出来。
//
// 成本控制：每个周期只 ping 一个目标（内网/外网轮流），因此每 60 秒只多一次
// ping，而不是每次两个。两轮之间同一个目标的数据会「旧」60 秒，所以每份记录
// 都带 t，前端据此显示「N 秒前」。
const LOSS_PATH = '/tmp/shadcn-dashboard/loss.json';
const LOSS_COUNT = 5;      // 每轮发几个包
const LOSS_TIMEOUT = 2;    // 单包等待秒数

// 跑一条命令并取回 stdout+stderr。失败返回 null。
//
// 采样器里原先只有 system()（只关心退出码），这里需要输出内容，所以用 popen
// 自己读一遍。popen 是同步的，调用方都是本进程的后台循环，不阻塞任何请求。
function run(cmd) {
	try {
		const proc = popen(cmd, 'r');

		if (proc == null)
			return null;

		const text = proc.read('all') ?? '';
		proc.close();

		return text;
	}
	catch (e) {
		return null;
	}
}

// ping 一个目标，返回 { loss, rtt, at }。
//
// 解析 "N% packet loss" 与 round-trip 行的 avg 值；解析不出来时 loss 为 null，
// 表示「没测出来」而不是「零丢包」—— 两者含义完全不同，不能混。
// 目标是否真的在链路上（有 ARP 应答）。
//
// 判据是邻居表里有没有 lladdr（MAC）：
//   · 有 lladdr（REACHABLE / STALE / DELAY）→ 这台机器存在，只是可能不回应
//     ICMP 或真的在丢包；
//   · FAILED / 无条目 → ARP 都解析不到，机器不在这个网段或已关机。
//
// **为什么不能用 ping 的报错文本**：busybox 的 ping 在目标不存在时**什么额外
// 信息都不打**，只输出「5 packets transmitted, 0 received, 100% packet loss」。
// 实测 192.168.99.99（网段里没有这个地址）就是这个输出，和「目标在线但丢包」
// 完全一样。所以只能从邻居表这一侧判断取目标是否可信。
function hasNeighbour(ip) {
	const out = run(`ip neigh show ${ip} 2>&1`);

	if (out == null)
		return false;

	// 必须有 lladdr 才算「解析到了 MAC」；FAILED 行只有 IP 和状态，没有 lladdr。
	return match(out, /lladdr[ \t]+\S+/) != null;
}

// ping 一个目标，返回 { loss, rtt, at, unreachable, target }。
//
// unreachable 的语义是「目标主机不在这个网段 / 已下线」，此时 loss 为 null。
// 判定分两步，缺一不可：
//
//   1. ping 拿到 100% 丢包；
//   2. 邻居表里查不到它的 MAC。
//
// 只有 1 时不能断言离线 —— 机器在线但防火墙丢 ICMP 的情况很常见（0% 之外
// 的丢包也可能是真的拥塞）。两步都成立才认为「这台机器不在了」。
function pingLoss(target) {
	const out = run(`ping -c ${LOSS_COUNT} -W ${LOSS_TIMEOUT} ${target} 2>&1`);

	if (out == null)
		return { loss: null, rtt: null, at: epoch(), unreachable: false, target: target };

	const lossM = match(out, /([0-9]+)% packet loss/);
	const rttM = match(out, /round-trip[^=]*=[ \t]*([0-9.]+)\/([0-9.]+)\/([0-9.]+)/);

	const loss = lossM != null ? +lossM[1] : null;
	const rtt = rttM != null ? +rttM[2] : null;

	// 100% 丢包时再查邻居表：没有 MAC 才判离线。
	if (loss == 100 && !hasNeighbour(target))
		return { loss: null, rtt: null, at: epoch(), unreachable: true, target: target };

	return { loss: loss, rtt: rtt, at: epoch(), unreachable: false, target: target };
}

// 读默认网关（外网探针）与本机 LAN 地址（内网探针）。
//
// 外网用默认网关而不是 8.8.8.8：目标是「这条上行通不通」，网关是最短的
// 一跳，也避免把「国际出口被墙」误判成「线路丢包」。
function defaultGateway() {
	const out = run('ip route show default 2>&1');

	if (out == null)
		return null;

	const m = match(out, /default[ \t]+via[ \t]+([0-9.]+)/);

	return m != null ? m[1] : null;
}

// 内网探针目标：从 br-lan 的邻居表里挑一台**刚刚通过信**的设备。
//
// 为什么不能猜网关 .1：实测这台设备的 192.168.3.1 是 PERMANENT 静态表项
// （有 lladdr 但 ping 100% 不通），与 .2 一样。按「网关 = .1」的惯例取目标，
// 会把一个不存在的地址测成 100% 丢包，看板显示成「内网全丢」—— 明明是探针
// 选错，却像线路故障。
//
// 状态只认 REACHABLE：它是「最近一次 ARP 交互成功」的确切证据。
//   · STALE / DELAY / PROBE 只说明曾经有过 lladdr，不代表现在还活着 ——
//     一台刚拔网线的设备会长时间停在 STALE，拿它当探针会继续报 100% 丢包；
//   · FAILED / INCOMPLETE 是解析失败，本就该排除；
//   · PERMANENT 是静态表项（管理员手工加的），与实际可达性无关，也排除。
//
// 优先取 IP 小的（通常是常开的设备），但不依赖这一点 —— 上层会在 ping 不通时
// 换下一个候选（见 pickInnerTarget）。
function lanCandidates() {
	const out = run('ip neigh show dev br-lan 2>&1');

	if (out == null)
		return [];

	const hits = [];

	for (let line in split(out, '\n')) {
		const m = match(line, /^([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)[ \t]+lladdr[ \t]+\S+[ \t]+REACHABLE/);

		if (m != null)
			push(hits, m[1]);
	}

	// 稳定的顺序：同一个网段里 IP 小的通常更常在线（网关、NAS、AP）。
	sort(hits, function (a, b) {
		const pa = split(a, '.');
		const pb = split(b, '.');

		for (let i = 0; i < 4; i++) {
			const d = +pa[i] - +pb[i];

			if (d != 0)
				return d;
		}

		return 0;
	});

	return hits;
}

/* 挑内网探针并处理「主机离线」。

   核心问题：邻居表只能证明「不久前有过 lladdr」，不能保证此刻还在线。
   一台设备关机后，邻居表可能还留着它的条目，于是下一轮 ping 得到 100% 丢包，
   看板显示「内网丢包 100%」—— 而内网其实好好的，只是那台机器关了。

   所以这里做两件事：
     1. 优先用上一轮测成功的地址（store.inner.target）：连通的探针才有可比性，
        每轮换目标会让丢包率曲线毫无意义；
     2. 如果它不可达（unreachable），换下一个候选重测一次。换过之后若仍然
        不可达，说明整个候选池都不可信，如实返回 unreachable，不输出假数字。

   只重试一次：采样器是后台循环，多试几个候选会把单轮时间拉长到十几秒，
   反而影响每分钟一次的节奏。 */
function pickInnerTarget(store) {
	const candidates = lanCandidates();

	if (length(candidates) == 0)
		return null;

	// 先把上一轮成功的目标提到最前。
	const prev = (store.inner != null) ? store.inner.target : null;
	const ordered = [];

	if (prev != null) {
		for (let c in candidates)
			if (c == prev)
				push(ordered, c);

		if (length(ordered) == 0 && match(prev, /^[0-9.]+$/) != null)
			push(ordered, prev);
	}

	for (let c in candidates)
		if (c != prev)
			push(ordered, c);

	for (let target in ordered) {
		const rec = pingLoss(target);

		if (!rec.unreachable) {
			rec.target = target;
			return rec;
		}
	}

	// 全部候选都不可达：带上最后一个目标，让前端能说明「探的是谁、它离线」。
	return {
		loss: null,
		rtt: null,
		at: epoch(),
		unreachable: true,
		target: ordered[0],
	};
}

function sampleLoss(state) {
	let store = null;

	try {
		const raw = readfile(LOSS_PATH);

		if (raw != null)
			store = json(raw);
	}
	catch (e) {
		store = null;
	}

	if (type(store) != 'object')
		store = {};

	/* 轮流测：这一轮内网、下一轮外网，由 store.turn 记着上次测了谁。
	   每轮只 ping 一个目标，所以每分钟的成本上限是一次 ping（内网那轮可能
	   重试一次，见 pickInnerTarget）。 */
	const turn = store.turn == 'outer' ? 'inner' : 'outer';

	if (turn == 'inner') {
		// pickInnerTarget 自己完成 ping（含离线换目标），返回值直接落盘。
		const rec = pickInnerTarget(store);

		if (rec == null) {
			// 邻居表里一台 REACHABLE 都没有：如实说没有探针，不硬编地址。
			store.inner = null;
			store.innerReason = '内网没有刚通信过的设备可作探针';
		}
		else {
			store.inner = rec;
			store.innerReason = null;
		}

		store.turn = 'inner';
	}
	else {
		const outer = defaultGateway();

		if (outer == null) {
			store.outer = null;
			store.outerReason = '读不到默认网关';
		}
		else {
			const rec = pingLoss(outer);
			rec.target = outer;
			store.outer = rec;
			store.outerReason = null;
		}

		store.turn = 'outer';
	}

	try {
		if (access('/tmp/shadcn-dashboard', 'f') != true)
			mkdir('/tmp/shadcn-dashboard');

		// 与 saveState 一样直接写对象：writefile 会做 JSON 序列化。
		writefile(LOSS_PATH, store);
	}
	catch (e) {
		return false;
	}

	return true;
}

// 主循环：先用单调时钟对齐到整分钟边界，之后每 STEP_SEC 采一次。
//
// 用单调时钟算间隔，因为墙钟会被 NTP 拨动；用墙钟记时间戳，因为回看要
// 跨重启对比真实日期。
//
// 等待用 system('sleep N')：这台设备的 ucode 构建里没有 uloop 模块
// （import 会报 “Unable to resolve path for module 'uloop'”），所以没有
// 事件循环可挂。代价是每分钟 fork 一个 /bin/sh —— 对 60 秒一次的粒度可以
// 接受，但不要把它用在更密的周期上。
function main() {
	const state = loadState();
	let next = monotonic();

	while (true) {
		sampleOnce(state);

		/* 丢包率每轮只测一个目标（内网/外网交替），因此这里是每 60 秒多一次
		   ping。失败不影响主采样 —— 丢包率是附加信息，不该拖累历史回看。 */
		try {
			sampleLoss(state);
		}
		catch (e) {
			/* 忽略：下一轮会重试。 */
		}

		next += STEP_SEC;

		const wait = next - monotonic();

		// 被挂起或系统时间跳变导致落后太多时，重新对齐，不补采（补采会把
		// 同一秒内的字节差摊到多个点上，画出来是假的尖峰）。
		if (wait > 0)
			system('sleep ' + int(wait));
		else
			next = monotonic();
	}
}

main();

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

import { readfile, writefile, mkdir, access } from 'fs';

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

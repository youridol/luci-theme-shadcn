// SPDX-License-Identifier: Apache-2.0
//
// 慢路径聚合：把连接表压成看板需要的几种视图。
//
// 与 conntrack.uc 的关系：它负责「一条连接怎么解析」，这里负责「一批连接
// 怎么汇总」。解析结果复用它的 parseConntrack()，不重复实现。
//
// 成本（真机实测，x86_64 / LEDE 24.10.5 / 约 1000 条连接）：
//   readfile + parseConntrack  ≈ 740 ms（瓶颈在逐行正则）
//   纯聚合                    ≈ 15 ms
// 所以这条路径只能按慢周期（60 s）调用，不能进 1 s 快路径 —— 这正是
// .dev/docs/adr/0005 里快慢分离的原因。
//
// ucode 没有函数提升：所有函数在调用它的代码之前声明。

'use strict';

import { parseConntrack } from 'shadcn.conntrack';

// 把 [key, value] 数组按 value 降序排，用于排行榜。
// ucode 的 sort() 接受比较函数，与 conntrack.uc 里用法一致。
function byWeightDesc(a, b) {
	return (b.bytes ?? 0) - (a.bytes ?? 0);
}

// 按某个维度聚合连接。keyOf 由调用方给，返回 null 表示跳过这条连接。
//
// 返回的每一项：{ key, bytes, up, down, conns }，按总字节降序。
function aggregate(list, keyOf) {
	const map = {};

	for (let c in list) {
		const key = keyOf(c);

		if (key == null || key == '')
			continue;

		if (map[key] == null)
			map[key] = { key: key, bytes: 0, up: 0, down: 0, conns: 0 };

		const rec = map[key];

		rec.bytes += c.bytes_out + c.bytes_in;
		rec.up += c.bytes_out;
		rec.down += c.bytes_in;
		rec.conns += 1;
	}

	const out = [];

	for (let k in map)
		push(out, map[k]);

	sort(out, byWeightDesc);

	return out;
}

// 取前 n 项。负数或缺失时按 10 处理，避免把整表吐给前端。
function top(list, n) {
	const want = (n != null && n > 0) ? n : 10;

	return length(list) > want ? slice(list, 0, want) : list;
}

// 对外：一次慢路径汇总。
//
// options：
//   limit      排行榜返回多少项，默认 10
//   conntrack  parseConntrack() 的结果；调用方可以复用自己刚解析的那一份，
//              避免同一次请求里解析两遍（那是 740 ms 的区别）
export function summarize(list, options) {
	const o = options ?? {};
	const rows = list ?? [];

	const byHost = aggregate(rows, function(c) { return c.src; });
	const byApp = aggregate(rows, function(c) {
		// 目的端口是应用的指纹来源；没有端口（如 ICMP）就归到协议名下，
		// 不硬造一个应用名。
		//
		// uc() 而不是 .toUpperCase()：ucode 的字符串没有 JS 那套原型方法，
		// 真机上 .toUpperCase() 抛 “left-hand side expression is not an
		// array or object”。
		return c.dport > 0
			? `${uc(c.proto)}/${c.dport}`
			: uc(c.proto);
	});
	const byProto = aggregate(rows, function(c) { return c.proto; });
	const byDst = aggregate(rows, function(c) { return c.dst; });

	// 连接状态分布：state 在 offload 连接上可能是 OFFLOADED/ASSURED，
	// 原样统计，不归类。
	const states = {};
	let offloaded = 0;
	let uncounted = 0;

	for (let c in rows) {
		const st = c.state ?? 'UNKNOWN';

		states[st] = (states[st] ?? 0) + 1;

		if (c.offloaded)
			offloaded += 1;

		if (!c.counted)
			uncounted += 1;
	}

	return {
		total: length(rows),
		offloaded: offloaded,
		// 内核没记账的连接数：这些连接画不出速率，前端应能说明原因
		uncounted: uncounted,
		states: states,
		hosts: top(byHost, o.limit),
		apps: top(byApp, o.limit),
		protos: byProto,
		dsts: top(byDst, o.limit),
	};
}

// 对外：读一次连接表并汇总。调用方负责决定何时调用（慢周期）。
export function readAndSummarize(text, options) {
	const list = parseConntrack(text ?? '');

	return summarize(list, options);
}

// 对外：把汇总结果压成前端最小可用的形状。
//
// 排行榜条目只保留 key 与字节数：图表只需要这两个，连接数与上下行拆分
// 留在 summarize() 里给需要明细的地方用。这样 60 秒一次的响应体不会因为
// 排行榜而膨胀。
export function compact(summary) {
	const rows = function(list) {
		const out = [];

		for (let it in list)
			push(out, { k: it.key, b: it.bytes });

		return out;
	};

	return {
		total: summary.total,
		offloaded: summary.offloaded,
		uncounted: summary.uncounted,
		hosts: rows(summary.hosts),
		apps: rows(summary.apps),
		protos: rows(summary.protos),
	};
}

import { reviewMetrics } from '../protocol/blind-review.mjs';

const cell = (value) => String(value ?? '—').replace(/[\r\n]+/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\|`*_\[\]]/g, (char) => `\\${char}`);
const num = (value, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : '—';
const diff = (a, b) => Number.isFinite(a) && Number.isFinite(b) ? a - b : null;
const delta = (value, digits = 1) => Number.isFinite(value) ? `${value > 0 ? '+' : ''}${value.toFixed(digits)}` : '—';
const pairLabel = (pair) => `${cell(pair.name)} · ${pair.duration ?? '—'} 秒 · Seed ${cell(pair.seed)} · ${cell(pair.key.slice(0, 10))}`;
const table = (labels, rows) => [
  `| ${labels.join(' | ')} |`,
  `| ${labels.map(() => '---').join(' | ')} |`,
  ...rows.map((row) => `| ${row.join(' | ')} |`),
].join('\n');

export function experimentMarkdown(pairs, { hourlyRate, now = new Date() } = {}) {
  if (!Array.isArray(pairs) || !pairs.length) throw new Error('还没有可导出的对照组。');
  const at = now.toISOString();
  const rate = hourlyRate !== '' && hourlyRate != null && Number.isFinite(Number(hourlyRate)) && Number(hourlyRate) >= 0 ? Number(hourlyRate) : null;
  const cost = (wan) => rate != null && Number.isFinite(wan) ? `¥${(wan * rate / 3600).toFixed(3)}` : '—';
  const performance = pairs.filter((pair) => pair.method === 'independent');
  const shared = pairs.filter((pair) => pair.method === 'shared-first-round');
  const sections = [
    '# MarketFilm 对照实验快照',
    `导出时间（UTC）：${at}。含 ${pairs.length} 个对照组。`,
    `GPU 折算单价：${rate == null ? '未填写，成本列留空' : `${rate} 元/小时`}。成本 = Wan 调用时间 × 折算单价；调用含等待及传输，不代表实际 GPU 使用量、电费或账单。`,
    '## 独立运行：耗时与成本',
    '基线和闭环冻结相同分镜与输入。「生成及交付」扣除任务中单独记录的自动分镜时间；总耗时不含本地排队。分开运行的回顾对照要与同期 A/B 分开解读；相同 Seed 也不保证两次视频生成逐帧一致。',
    performance.length ? table(['对照', '质检规则', '运行安排', '总耗时 / 秒（基线 → 闭环）', '生成及交付 / 秒（基线 → 闭环；差值）', 'Wan 次数（基线 → 闭环）', 'Wan / 秒（基线 → 闭环）', '费用折算（基线 → 闭环）'], performance.map((p) => {
      const { baseline: b, audit: a } = p;
      return [pairLabel(p), cell(p.revisionPolicy || '早期规则'), p.pairedSubmission ? '同期提交' : '分开运行', `${num(b.wallSeconds)} → ${num(a.wallSeconds)}`, `${num(b.afterPlanSeconds)} → ${num(a.afterPlanSeconds)}；${delta(diff(a.afterPlanSeconds, b.afterPlanSeconds))}`, `${num(b.wanCalls, 0)} → ${num(a.wanCalls, 0)}`, `${num(b.wanSeconds)} → ${num(a.wanSeconds)}`, `${cost(b.wanSeconds)} → ${cost(a.wanSeconds)}`];
    })) : '暂无独立运行对照。',
    '## 人工盲评：逐组报告',
    '只统计已提交或导入的人工盲评，三项评分均为 1–5 分。下面是每组的均分和偏好票数，差值为闭环减首轮或基线。没有评分的组不产生分数；少量分数只描述这些样片。',
    ...[['同源画质：同次生成的首轮 vs 闭环选片', shared], ['独立运行画质：单向基线 vs 闭环', performance]].flatMap(([title, group]) => [
      `### ${title}`,
      group.length ? table(['对照', '票数', ...reviewMetrics.map(([, label]) => `${label}（首轮/基线 → 闭环；差值）`), '偏好（首轮/基线 / 闭环 / 无明显差别）'], group.map((p) => {
        const n = p.votes || 0;
        return [pairLabel(p), n, ...reviewMetrics.map(([key]) => {
          const a = p.audit.means?.[key], b = p.baseline.means?.[key];
          return n ? `${num(b, 2)} → ${num(a, 2)}；${delta(diff(a, b), 2)}` : '—';
        }), n ? `${p.winners.baseline} / ${p.winners.audit} / ${p.winners.tie}` : '待评分'];
      })) : '暂未生成这类对照。',
    ]),
  ];
  return `${sections.join('\n\n')}\n`;
}

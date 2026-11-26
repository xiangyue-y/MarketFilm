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
  const creative = pairs.filter((pair) => pair.method === 'creative');
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
    ...creative.flatMap((pair) => {
      const { baseline, audit } = pair;
      const responses = pair.recallResponses ?? [];
      return [
        `## 创意流程对照 · ${pairLabel(pair)}`,
        `选用提案「${cell(pair.proposal.title)}」。两组使用同一 8 秒结构、参考图、H3 参数、Seed、配音配置与 GPT 质检策略。固定双镜组直接生成分镜，选案组在分镜前从三个创意中选一案。`,
        `评阅顺序随机。每条先看 2 秒并答续看意愿，然后看全片做自由复述。完成两条复述后才显示确认卖点。`,
        `确认卖点为「${cell(pair.facts.join('、'))}」。复述准确须覆盖核心信息，允许同义表达。统计分母为已判读人数，两组均保留原始作答和盲评顺序。`,
        table(['指标', '固定双镜', '选案版'], [
          ['前两秒愿意续看', ...[baseline, audit].map((arm) => pair.votes ? `${arm.continueCount}/${pair.votes}` : '待盲评')],
          ['准确复述卖点', ...[baseline, audit].map((arm) => arm.recallGraded ? `${arm.recallCorrect}/${arm.recallGraded}` : '待判读')],
          ['提案生成（秒）', num(baseline.proposalSeconds), num(audit.proposalSeconds)],
          ['分镜策划（秒）', num(baseline.storyboardSeconds), num(audit.storyboardSeconds)],
          ['生成及交付（秒）', num(baseline.afterPlanSeconds), num(audit.afterPlanSeconds)],
          ['H3 生成含返工（秒）', num(baseline.wanSeconds), num(audit.wanSeconds)],
          ['返工重拍（次数 / 秒）', ...[baseline, audit].map((arm) => `${num(arm.retries, 0)} / ${num(arm.retrySeconds)}`)],
          ['返工指令（秒）', num(baseline.rewriteSeconds), num(audit.rewriteSeconds)],
        ]),
        '耗时不含排队与用户选案时间。单商品、单 Seed 的成片用于检验这组素材，两版可能受视频生成随机性和观看顺序影响。',
        '### 逐份作答',
        responses.length ? table(['回执', '观看位置', '版本', '愿意续看', '卖点复述原文', '判读'], responses.flatMap((review, index) =>
          review.answers.map((answer, slot) => [
            index + 1,
            ['A', 'B'][slot],
            ({ baseline: '固定双镜', audit: '选案版' })[review.order?.[slot]] ?? '—',
            ({ yes: '是', no: '否' })[review.continueWatching?.[slot]] ?? '—',
            cell(answer),
            ({ correct: '准确', incorrect: '不准确' })[review.grading?.[slot]] ?? '待判读',
          ])
        )) : '当前有效回执 0 份。',
      ];
    }),
  ];
  return `${sections.join('\n\n')}\n`;
}

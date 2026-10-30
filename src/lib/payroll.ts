// Payroll: schedules, lines, paid records and reports. All numbers come from the database
// (pay_periods, payroll_lines, payroll_runs), so the page, reminders, payslips and PDFs always agree.
import { supabase } from './supabase';
import { DAY_LONG, money, rangeTitle } from './time';

export type PayFrequency = 'weekly' | 'biweekly' | 'monthly';
export interface PaySettings {
  pay_frequency: PayFrequency; pay_anchor: string; pay_weekday: number; pay_month_day: number; pay_month_offset: number; overtime: boolean;
}
export interface Period { period_start: string; period_end: string; pay_date: string }
export interface PayLine {
  employee_id: string; name: string; rate: number; hours: number; regular_hours: number; overtime_hours: number;
  regular_pay: number; overtime_pay: number; bonus: number; deduction: number; gross: number; net: number; open_entries?: number;
}
export interface PayRun {
  id: string; location_id: string; location_name: string; frequency: PayFrequency; period_start: string; period_end: string; pay_date: string;
  status: 'paid' | 'reopened'; lines: PayLine[]; employees: number; hours: number; total_gross: number; total_net: number;
  paid_at: string; reopened_at: string | null; reopen_reason: string | null;
}
export interface DashRow {
  location_id: string; name: string; type: string; frequency: PayFrequency; cur_start: string; cur_end: string;
  next_start: string; next_end: string; next_pay_date: string; next_paid: boolean; employees: number; hours: number; payable: number;
  pending: number; completed: number;
}
export interface MyPay {
  location_id: string; location_name: string; cur_start: string; cur_end: string; cur_pay_date: string; cur_hours: number; cur_gross: number;
  next_start: string; next_end: string; next_pay_date: string; next_hours: number; next_gross: number; next_net: number; next_paid: boolean;
}

const num = <T,>(rows: T[], keys: (keyof T)[]) => rows.map((r) => { const o = { ...r }; for (const k of keys) (o[k] as unknown) = Number(r[k] ?? 0); return o; });
const LINE_NUMS: (keyof PayLine)[] = ['rate', 'hours', 'regular_hours', 'overtime_hours', 'regular_pay', 'overtime_pay', 'bonus', 'deduction', 'gross', 'net', 'open_entries'];
const day = (d: string) => String(d).slice(0, 10);
const fixDates = <T extends object>(r: T) => { const o = { ...r } as Record<string, unknown>; for (const k in o) if (/(_start|_end|_date)$/.test(k) && o[k]) o[k] = day(o[k] as string); return o as T; };

export async function payPeriods(locId: string, around: string, before: number, after: number): Promise<Period[]> {
  const { data, error } = await supabase.rpc('pay_periods', { p_loc: locId, p_around: around, p_before: before, p_after: after });
  if (error) throw error;
  return (data as Period[]).map(fixDates);
}
export async function payLines(locId: string, p: Period): Promise<PayLine[]> {
  const { data, error } = await supabase.rpc('payroll_lines', { p_loc: locId, p_start: p.period_start, p_end: p.period_end });
  if (error) throw error;
  return num(data as PayLine[], LINE_NUMS);
}
export async function payRuns(orgId: string): Promise<PayRun[]> {
  const { data, error } = await supabase.from('payroll_runs').select('*').eq('org_id', orgId).order('period_start', { ascending: false });
  if (error) throw error;
  return (data as PayRun[]).map((r) => ({ ...fixDates(r), lines: num(r.lines, LINE_NUMS), hours: +r.hours, total_gross: +r.total_gross, total_net: +r.total_net }));
}
export async function payDashboard(orgId: string): Promise<DashRow[]> {
  const { data, error } = await supabase.rpc('payroll_dashboard', { p_org: orgId });
  if (error) throw error;
  return num((data as DashRow[]).map(fixDates), ['hours', 'payable', 'employees', 'pending', 'completed']);
}
export async function myPay(empId: string): Promise<MyPay[]> {
  const { data, error } = await supabase.rpc('my_pay', { p_emp: empId });
  if (error) throw error;
  return num((data as MyPay[]).map(fixDates), ['cur_hours', 'cur_gross', 'next_hours', 'next_gross', 'next_net']);
}
export async function markPaid(locId: string, start: string) {
  const { error } = await supabase.rpc('mark_payroll_paid', { p_loc: locId, p_start: start });
  if (error) throw error;
}
export async function reopenRun(runId: string, reason: string) {
  const { error } = await supabase.rpc('reopen_payroll', { p_run: runId, p_reason: reason });
  if (error) throw error;
}
/** Bonus or deduction for one worker and period; 0 removes it. */
export async function setAdjustment(orgId: string, locId: string, empId: string, start: string, kind: 'bonus' | 'deduction', amount: number) {
  const q = supabase.from('payroll_adjustments');
  const { error } = amount > 0
    ? await q.upsert({ org_id: orgId, location_id: locId, employee_id: empId, period_start: start, kind, amount }, { onConflict: 'location_id,employee_id,period_start,kind' })
    : await q.delete().eq('location_id', locId).eq('employee_id', empId).eq('period_start', start).eq('kind', kind);
  if (error) throw error;
}

// ---------------------------------------------------------------- labels

export const FREQ_LABEL: Record<PayFrequency, string> = { weekly: 'Weekly', biweekly: 'Every 2 weeks', monthly: 'Monthly' };
export const dateLong = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
export const dateShort = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'numeric', day: 'numeric' });
export const periodTitle = (p: { period_start: string; period_end: string }) => rangeTitle(p.period_start, p.period_end);
export const hrs = (n: number) => (Math.round(n * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
export function scheduleText(s: PaySettings) {
  if (s.pay_frequency === 'monthly') {
    const d = s.pay_month_day >= 31 ? 'the last day' : `day ${s.pay_month_day}`;
    return `Monthly · paid on ${d} of ${s.pay_month_offset ? 'the next month' : 'the same month'}`;
  }
  const start = DAY_LONG[(new Date(s.pay_anchor + 'T00:00:00Z').getUTCDay() + 6) % 7];
  return `${FREQ_LABEL[s.pay_frequency]} · ${start} to ${DAY_LONG[(new Date(s.pay_anchor + 'T00:00:00Z').getUTCDay() + 5) % 7]} · paid the next ${DAY_LONG[s.pay_weekday]}`;
}
export const totals = (lines: PayLine[]) => lines.reduce((t, l) => ({
  hours: t.hours + l.hours, ot: t.ot + l.overtime_hours, reg: t.reg + l.regular_pay, otPay: t.otPay + l.overtime_pay,
  bonus: t.bonus + l.bonus, ded: t.ded + l.deduction, gross: t.gross + l.gross, net: t.net + l.net,
}), { hours: 0, ot: 0, reg: 0, otPay: 0, bonus: 0, ded: 0, gross: 0, net: 0 });

// ---------------------------------------------------------------- reports (print + PDF, US Letter)

export interface Report { business: string; location: string; period: Period; status: 'Paid' | 'Pending'; paidAt?: string; lines: PayLine[] }

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const PRINT_CSS = `@page { size: letter; margin: 0.5in; }
* { box-sizing: border-box; } body { font: 11px/1.4 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #18202b; margin: 0; }
h1 { font-size: 20px; margin: 0 0 2px; color: #12324a; } .sub { color: #5d6978; margin-bottom: 14px; }
.meta { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 14px; }
.meta div { border: 1px solid #d5dbe2; border-radius: 6px; padding: 6px 8px; } .meta b { display: block; font-size: 9px; text-transform: uppercase; color: #5d6978; letter-spacing: .04em; }
table { width: 100%; border-collapse: collapse; } th, td { padding: 5px 6px; border-bottom: 1px solid #d5dbe2; text-align: right; } th:first-child, td:first-child { text-align: left; }
th { font-size: 9px; text-transform: uppercase; color: #5d6978; letter-spacing: .04em; background: #f6f8fa; } tfoot td { font-weight: 700; border-top: 2px solid #18202b; }
.slip { page-break-after: always; } .slip:last-child { page-break-after: auto; } .slip table { margin-top: 6px; } .slip td:first-child { width: 60%; }
.net { font-size: 16px; font-weight: 700; } .foot { margin-top: 18px; color: #5d6978; font-size: 9px; }`;

function summaryHtml(r: Report) {
  const t = totals(r.lines);
  const rows = r.lines.map((l) => `<tr><td>${esc(l.name)}</td><td>${hrs(l.regular_hours)}</td><td>${hrs(l.overtime_hours)}</td><td>${money(l.rate)}</td><td>${money(l.regular_pay)}</td><td>${money(l.overtime_pay)}</td><td>${money(l.bonus)}</td><td>${money(l.deduction)}</td><td>${money(l.gross)}</td><td><b>${money(l.net)}</b></td></tr>`).join('');
  return `<h1>Payroll summary</h1><div class="sub">${esc(r.business)} · ${esc(r.location)}</div>
  <div class="meta"><div><b>Pay period</b>${periodTitle(r.period)}</div><div><b>Pay date</b>${dateLong(r.period.pay_date)}</div><div><b>Status</b>${r.status}${r.paidAt ? ` · ${new Date(r.paidAt).toLocaleDateString('en-US')}` : ''}</div><div><b>Total payroll</b>${money(t.net)}</div></div>
  <table><thead><tr><th>Employee</th><th>Regular h</th><th>Overtime h</th><th>Rate</th><th>Regular pay</th><th>Overtime pay</th><th>Bonus</th><th>Deduction</th><th>Gross</th><th>Net</th></tr></thead>
  <tbody>${rows}</tbody><tfoot><tr><td>Total · ${r.lines.length} employees</td><td>${hrs(t.hours - t.ot)}</td><td>${hrs(t.ot)}</td><td></td><td>${money(t.reg)}</td><td>${money(t.otPay)}</td><td>${money(t.bonus)}</td><td>${money(t.ded)}</td><td>${money(t.gross)}</td><td>${money(t.net)}</td></tr></tfoot></table>
  <div class="foot">Gross pay from clocked hours. Taxes are not included unless entered as deductions. Made with SplitYourShift.</div>`;
}
function slipHtml(r: Report, l: PayLine) {
  const row = (k: string, v: string) => `<tr><td>${k}</td><td>${v}</td></tr>`;
  return `<div class="slip"><h1>Payslip</h1><div class="sub">${esc(r.business)} · ${esc(r.location)}</div>
  <div class="meta"><div><b>Employee</b>${esc(l.name)}</div><div><b>Pay period</b>${periodTitle(r.period)}</div><div><b>Pay date</b>${dateLong(r.period.pay_date)}</div><div><b>Status</b>${r.status}</div></div>
  <table><tbody>${row('Regular hours', hrs(l.regular_hours))}${row('Overtime hours', hrs(l.overtime_hours))}${row('Hourly rate', money(l.rate))}
  ${row('Regular pay', money(l.regular_pay))}${row('Overtime pay (1.5×)', money(l.overtime_pay))}${row('Bonus', money(l.bonus))}
  ${row('Gross pay', `<b>${money(l.gross)}</b>`)}${row('Deductions', money(l.deduction))}<tr><td class="net">Net pay</td><td class="net">${money(l.net)}</td></tr></tbody></table>
  <div class="foot">Gross pay from clocked hours. Taxes are not included unless entered as deductions. Made with SplitYourShift.</div></div>`;
}

/** Prints through a hidden frame so the app itself isn't affected. */
export function printReport(r: Report, kind: 'summary' | 'slips', only?: string) {
  const body = kind === 'summary' ? summaryHtml(r) : r.lines.filter((l) => !only || l.employee_id === only).map((l) => slipHtml(r, l)).join('');
  const f = document.createElement('iframe');
  f.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0';
  document.body.appendChild(f);
  const d = f.contentDocument!;
  d.open(); d.write(`<!doctype html><html><head><meta charset="utf-8"><title>${kind === 'summary' ? 'Payroll' : 'Payslip'} ${esc(r.location)} ${r.period.period_start}</title><style>${PRINT_CSS}</style></head><body>${body}</body></html>`); d.close();
  setTimeout(() => { f.contentWindow!.focus(); f.contentWindow!.print(); setTimeout(() => f.remove(), 1000); }, 50);
}

/** Downloads a US Letter PDF of the summary or payslip(s). */
export async function downloadPdf(r: Report, kind: 'summary' | 'slips', only?: string) {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'pt', format: 'letter', orientation: 'portrait' });
  const W = 612, M = 36;
  const head = (title: string) => {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.setTextColor('#12324a'); doc.text(title, M, M + 14);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor('#5d6978'); doc.text(`${r.business} · ${r.location}`, M, M + 30);
    doc.setTextColor('#18202b');
  };
  const meta = (pairs: [string, string][], y: number) => {
    const w = (W - 2 * M) / pairs.length;
    pairs.forEach(([k, v], i) => {
      doc.setDrawColor('#d5dbe2'); doc.roundedRect(M + i * w, y, w - 6, 34, 3, 3);
      doc.setFontSize(7); doc.setTextColor('#5d6978'); doc.text(k.toUpperCase(), M + i * w + 6, y + 12);
      doc.setFontSize(9.5); doc.setTextColor('#18202b'); doc.text(v, M + i * w + 6, y + 26, { maxWidth: w - 16 });
    });
  };
  const foot = () => { doc.setFontSize(7.5); doc.setTextColor('#5d6978'); doc.text('Gross pay from clocked hours. Taxes are not included unless entered as deductions. Made with SplitYourShift.', M, 792 - M); doc.setTextColor('#18202b'); };
  if (kind === 'summary') {
    const t = totals(r.lines);
    head('Payroll summary');
    meta([['Pay period', periodTitle(r.period)], ['Pay date', dateLong(r.period.pay_date)], ['Status', r.status], ['Total payroll', money(t.net)]], M + 42);
    const cols = ['Employee', 'Reg h', 'OT h', 'Rate', 'Regular', 'Overtime', 'Bonus', 'Deduct.', 'Gross', 'Net'];
    const xs = [M, 168, 210, 252, 304, 364, 420, 472, 528, W - M];
    const row = (cells: string[], y: number, bold = false) => {
      doc.setFont('helvetica', bold ? 'bold' : 'normal');
      cells.forEach((c, i) => i === 0 ? doc.text(c, xs[0], y, { maxWidth: 125 }) : doc.text(c, xs[i], y, { align: 'right' }));
    };
    let y = M + 100;
    doc.setFontSize(7.5); doc.setTextColor('#5d6978'); row(cols.map((c) => c.toUpperCase()), y, true); doc.setTextColor('#18202b');
    doc.setDrawColor('#d5dbe2'); doc.line(M, y + 5, W - M, y + 5); y += 18; doc.setFontSize(9);
    for (const l of r.lines) {
      if (y > 792 - M - 40) { foot(); doc.addPage(); y = M + 20; }
      row([l.name, hrs(l.regular_hours), hrs(l.overtime_hours), money(l.rate), money(l.regular_pay), money(l.overtime_pay), money(l.bonus), money(l.deduction), money(l.gross), money(l.net)], y);
      doc.line(M, y + 5, W - M, y + 5); y += 17;
    }
    doc.setDrawColor('#18202b'); doc.line(M, y - 9, W - M, y - 9); y += 4;
    row([`Total · ${r.lines.length}`, hrs(t.hours - t.ot), hrs(t.ot), '', money(t.reg), money(t.otPay), money(t.bonus), money(t.ded), money(t.gross), money(t.net)], y, true);
    foot();
  } else {
    r.lines.filter((l) => !only || l.employee_id === only).forEach((l, i) => {
      if (i) doc.addPage();
      head('Payslip');
      meta([['Employee', l.name], ['Pay period', periodTitle(r.period)], ['Pay date', dateLong(r.period.pay_date)], ['Status', r.status]], M + 42);
      const items: [string, string, boolean?][] = [['Regular hours', hrs(l.regular_hours)], ['Overtime hours', hrs(l.overtime_hours)], ['Hourly rate', money(l.rate)],
        ['Regular pay', money(l.regular_pay)], ['Overtime pay (1.5×)', money(l.overtime_pay)], ['Bonus', money(l.bonus)], ['Gross pay', money(l.gross), true],
        ['Deductions', money(l.deduction)], ['Net pay', money(l.net), true]];
      let y = M + 104; doc.setFontSize(11); doc.setDrawColor('#d5dbe2');
      for (const [k, v, b] of items) { doc.setFont('helvetica', b ? 'bold' : 'normal'); doc.text(k, M, y); doc.text(v, W - M, y, { align: 'right' }); doc.line(M, y + 7, W - M, y + 7); y += 24; }
      foot();
    });
  }
  const who = kind === 'slips' && only ? `-${r.lines.find((l) => l.employee_id === only)?.name.replace(/\W+/g, '-')}` : '';
  doc.save(`${kind === 'summary' ? 'payroll' : 'payslip'}-${r.location.replace(/\W+/g, '-')}-${r.period.period_start}${who}.pdf`);
}

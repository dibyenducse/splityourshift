import { useEffect, useState } from 'react';
import { errText } from '../lib/supabase';
import { money } from '../lib/time';
import { dateShort, downloadPdf, hrs, myPayslips, periodTitle, printReport, slipReport, type Payslip } from '../lib/payroll';

/** Every paid payday of one worker, newest first, with payslip print and PDF. Used by the worker and by the owner. */
export function PayslipList({ business, empId, limit }: { business: string; empId: string; limit?: number }) {
  const [rows, setRows] = useState<Payslip[] | null>(null);
  const [err, setErr] = useState('');
  const [all, setAll] = useState(false);
  useEffect(() => { myPayslips(empId).then(setRows, (e) => setErr(errText(e))); }, [empId]);
  if (err) return <p className="empty-note">{err}</p>;
  if (!rows) return <p className="empty-note">Loading…</p>;
  if (!rows.length) return <p className="empty-note">No paid payday yet. A payslip shows up here once the owner marks that payroll paid.</p>;
  const shown = limit && !all ? rows.slice(0, limit) : rows;
  return (<>
    <div className="table-wrap"><table className="data slips"><thead><tr><th>Pay date</th><th>Business</th><th>Pay period</th><th className="num">Hours</th><th className="num">Gross</th><th className="num">Net paid</th><th>Payslip</th></tr></thead>
      <tbody>{shown.map((p) => (
        <tr key={p.run_id}><td><b>{dateShort(p.pay_date)}</b></td><td>{p.location_name}</td><td>{periodTitle(p)}</td>
          <td className="num">{hrs(p.line.hours)}{p.line.overtime_hours > 0 && <div className="hint" style={{ margin: 0 }}>{hrs(p.line.overtime_hours)} OT</div>}</td>
          <td className="num">{money(p.line.gross)}</td><td className="num"><b>{money(p.line.net)}</b></td>
          <td><div className="actions" style={{ margin: 0, flexWrap: 'nowrap' }}>
            <button className="btn small" onClick={() => printReport(slipReport(business, p), 'slips')}>Print</button>
            <button className="btn small" onClick={() => downloadPdf(slipReport(business, p), 'slips')}>PDF</button></div></td></tr>))}</tbody></table></div>
    {limit && rows.length > limit && <div className="actions"><button className="btn small" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${rows.length}`}</button></div>}
  </>);
}

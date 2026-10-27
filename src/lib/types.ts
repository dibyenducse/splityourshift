export type LocType = 'hotel' | 'gas';
export type LoginStatus = 'active' | 'invited' | 'expired' | 'none';

export interface Org {
  id: string; owner_id: string; name: string; owner_name: string | null;
  pay_period: 'weekly' | 'biweekly'; pay_anchor: string; overtime: boolean;
  status: string; created_at: string; last_active_at: string | null;
}
export interface Loc { id: string; org_id: string; name: string; type: LocType; sort: number }
export interface Slot { id: string; org_id: string; location_id: string; start_hour: number; hours: number; sort: number; active: boolean }
export interface Avail { dow: number; mode: 'any' | 'hours' | 'off'; from_hour: number; to_hour: number }
export interface Emp {
  id: string; org_id: string; user_id: string | null; name: string; email: string | null; phone: string | null;
  max_shifts: number; rate: number; hue: number; lang: string; invited_at: string | null;
  locs: string[]; avail: Avail[]; status: LoginStatus;
}
export interface Req {
  id: string; org_id: string; employee_id: string; slot_id: string | null; work_date: string;
  label: string; reason: string | null; status: 'pending' | 'approved' | 'denied' | 'cancelled'; created_at: string; decided_at: string | null;
}
export interface LedgerRow {
  id: string; org_id: string; debtor_id: string; creditor_id: string; slot_id: string | null;
  work_date: string; label: string; status: 'open' | 'settled'; created_at: string;
}
export interface Note { id: string; text: string; request_id: string | null; read_at: string | null; created_at: string }

/** Everything needed to draw and check one business's schedule. assign maps "slotId|YYYY-MM-DD" → employee id. */
export interface Bundle {
  org: Org; locs: Loc[]; slots: Slot[]; emps: Emp[];
  assign: Record<string, string>; reqs: Req[]; ledger: LedgerRow[];
}

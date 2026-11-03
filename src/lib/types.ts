export type LocType = 'hotel' | 'gas' | 'shop';
export type LoginStatus = 'active' | 'invited' | 'expired' | 'none';

export interface Org {
  id: string; owner_id: string; name: string; owner_name: string | null;
  pay_period: 'weekly' | 'biweekly'; pay_anchor: string; pay_weekday?: number; overtime: boolean;
  status: string; created_at: string; last_active_at: string | null; time_zone: string;
  /** How names show on the schedule. */
  name_display?: 'first' | 'last' | 'first_initial' | 'custom';
}
export interface Loc {
  id: string; org_id: string; name: string; type: LocType; sort: number;
  // payroll schedule for this business (see src/lib/payroll.ts)
  pay_frequency?: 'weekly' | 'biweekly' | 'monthly'; pay_anchor?: string; pay_weekday?: number; pay_month_day?: number; pay_month_offset?: number; overtime?: boolean;
  ot_after?: number; ot_mode?: 'multiplier' | 'fixed'; ot_multiplier?: number; ot_fixed_rate?: number;
  grace_minutes?: number; mutual_approval?: boolean; pay_method?: 'actual' | 'grace'; pay_grace_minutes?: number;
}
export interface Slot { id: string; org_id: string; location_id: string; start_hour: number; hours: number; sort: number; active: boolean }
export interface Avail { dow: number; mode: 'any' | 'hours' | 'off'; from_hour: number; to_hour: number }
export interface Emp {
  id: string; org_id: string; user_id: string | null; name: string; email: string | null; phone: string | null;
  max_shifts: number; rate: number; hue: number; lang: string; invited_at: string | null;
  /** Owner-set short name for the schedule (used when the business shows custom short names). */
  short_name?: string | null;
  locs: string[]; avail: Avail[]; status: LoginStatus;
}
export interface Req {
  id: string; org_id: string; employee_id: string; slot_id: string | null; work_date: string;
  label: string; reason: string | null; status: 'pending' | 'approved' | 'denied' | 'cancelled'; created_at: string; decided_at: string | null;
  /** Worker who took over an approved time-off shift. */
  covered_by?: string | null;
}
export interface LedgerRow {
  id: string; org_id: string; debtor_id: string; creditor_id: string; slot_id: string | null;
  work_date: string; label: string; status: 'open' | 'settled'; created_at: string;
}
export interface Note { id: string; text: string; request_id: string | null; read_at: string | null; created_at: string }

export interface TimeEntry {
  id: string; org_id: string; employee_id: string; slot_id: string | null; work_date: string;
  clock_in: string; clock_out: string | null; source: 'clock' | 'owner' | 'request'; note: string | null;
  /** Business of a clock-in without a shift. */
  location_id?: string | null;
  /** Start time the worker says they began (late clock-in), waiting for the owner. */
  claimed_in?: string | null;
}
export interface TimeFix {
  id: string; org_id: string; employee_id: string; slot_id: string | null; work_date: string;
  clock_in: string; clock_out: string; reason: string | null; status: 'pending' | 'approved' | 'denied' | 'cancelled'; created_at: string;
}

/** Everything needed to draw and check one business's schedule. assign maps "slotId|YYYY-MM-DD" → employee id. */
export interface Bundle {
  org: Org; locs: Loc[]; slots: Slot[]; emps: Emp[];
  assign: Record<string, string>; reqs: Req[]; ledger: LedgerRow[];
  entries: TimeEntry[]; fixes: TimeFix[];
  /** Accepted swaps / takeovers on shifts in the loaded weeks (to mark swapped shifts). */
  swaps?: Adjustment[];
}

/** A takeover, swap, extra shift or late-arrival agreement between workers (see shift_adjustments). */
export interface Adjustment {
  id: string; org_id: string; location_id: string | null;
  kind: 'takeover' | 'swap' | 'extra' | 'late_ignore' | 'late_swap' | 'late_payroll' | 'proposal' | 'future_swap';
  from_emp: string; to_emp: string | null; slot_id: string | null; work_date: string | null; label: string | null; minutes: number | null;
  entry_id: string | null; status: 'pending' | 'awaiting_owner' | 'accepted' | 'declined' | 'recorded' | 'completed' | 'cancelled';
  note: string | null; created_at: string; decided_at: string | null; completed_at: string | null;
}

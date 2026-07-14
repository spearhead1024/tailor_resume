/* The person behind a call.
 *
 * Opened from the eye on the board's Profile cell. A caller is about to be on a call AS this person, so
 * what they need is who they are: contact details, where they live, what they claim to know, where they
 * have worked. Not the résumé template or the generation settings — those belong to the Profiles tab.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api/client';
import { contractText, salaryText } from './profile-terms';

export type BoardProfile = {
  id: string; name: string; region: string; label: string;
  email?: string; phone?: string; location?: string; address?: string; zip_code?: string;
  linkedin?: string; github?: string; portfolio?: string;
  summary_seed?: string;
  technical_skills?: string[];
  total_years_of_experience?: number;
  date_of_birth?: string;
  contract_types?: string[];
  b2b_country?: string;
  expected_salary?: { min?: number; max?: number; currency?: string; period?: string };
  work_history?: { company_name?: string; duration?: string; location?: string; legacy_role?: string; bullets?: string[] }[];
  education_history?: { university?: string; degree?: string; duration?: string; location?: string }[];
};

/** DOB, plus the age it implies. On a call you are asked your age, not your birth year. */
function dobText(iso?: string): string {
  const s = String(iso || '').trim();
  if (!s) return '';
  const d = new Date(`${s}T00:00:00Z`);
  if (isNaN(d.getTime())) return s;
  const now = new Date();
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) age -= 1;   // birthday not reached yet
  const pretty = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  return age >= 0 && age < 120 ? `${pretty}  (${age})` : pretty;
}

/** A row of the contact block. Renders nothing at all when there is no value — an empty row labelled
 *  "Phone" tells you less than no row, and makes a sparse profile look broken rather than sparse. */
function Line({ label, value, href }: { label: string; value?: string; href?: string }) {
  const v = String(value || '').trim();
  if (!v) return null;
  return (
    <div className="pc-line">
      <span className="pc-line-l">{label}</span>
      {href
        ? <a className="pc-line-v" href={href} target="_blank" rel="noreferrer noopener">{v}</a>
        : <span className="pc-line-v">{v}</span>}
    </div>
  );
}

export default function ProfileCard({ profileId, onClose }: { profileId: string; onClose: () => void }) {
  const [p, setP] = useState<BoardProfile | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    setP(null); setErr('');
    api.get<BoardProfile>(`/api/interviews/profiles/${encodeURIComponent(profileId)}`)
      .then((d) => { if (alive) setP(d); })
      .catch((e: any) => {
        if (!alive) return;
        // Say WHY. A caller can only open a profile that is on one of their own calls, and a bare
        // "failed to load" would send them hunting for a bug that isn't there.
        setErr(e?.response?.data?.detail || 'Could not load this profile.');
      });
    return () => { alive = false; };
  }, [profileId]);

  // Capture, and swallow everything except Escape — the board's grid listens on `document` for Delete,
  // Ctrl+V, Ctrl+Z and every printable key. Reading a profile must not type into the cell behind it.
  // (The board also gates on this card being open; belt and braces, exactly like the other overlays.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      e.stopPropagation();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const url = (u?: string) => {
    const s = String(u || '').trim();
    if (!s) return undefined;
    return /^https?:\/\//i.test(s) ? s : `https://${s}`;
  };

  return createPortal(
    <div className="cal-modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cal-modal pc-modal" role="dialog" aria-label="Profile">
        <header className="cal-modal-h">
          <h3>{p ? p.label : 'Profile'}</h3>
          <button className="ghost cal-modal-x" onClick={onClose} title="Close (Esc)">✕</button>
        </header>

        <div className="cal-modal-b pc-body">
          {!p && !err && <p className="muted"><span className="spinner" /> Loading…</p>}
          {err && <p className="pc-err">{err}</p>}

          {p && (
            <>
              <section className="pc-sec">
                <h4 className="pc-h">Contact</h4>
                <Line label="Email"     value={p.email} href={p.email ? `mailto:${p.email}` : undefined} />
                <Line label="Phone"     value={p.phone} href={p.phone ? `tel:${p.phone}` : undefined} />
                <Line label="Date of birth" value={dobText(p.date_of_birth)} />
                <Line label="Location"  value={[p.location, p.address, p.zip_code].filter(Boolean).join(' · ')} />
                <Line label="Region"    value={p.region} />
                <Line label="LinkedIn"  value={p.linkedin}  href={url(p.linkedin)} />
                <Line label="GitHub"    value={p.github}    href={url(p.github)} />
                <Line label="Portfolio" value={p.portfolio} href={url(p.portfolio)} />
                {!!p.total_years_of_experience && (
                  <Line label="Experience" value={`${p.total_years_of_experience} years`} />
                )}
              </section>

              {/* What a recruiter asks in the first five minutes, and what a caller must be able to
                  answer without leaving the board. */}
              {(!!(p.contract_types || []).length || !!salaryText(p.expected_salary)) && (
                <section className="pc-sec">
                  <h4 className="pc-h">Terms</h4>
                  <Line label="Can work as" value={contractText(p.contract_types, p.b2b_country)} />
                  <Line label="Expected"    value={salaryText(p.expected_salary)} />
                </section>
              )}

              {!!String(p.summary_seed || '').trim() && (
                <section className="pc-sec">
                  <h4 className="pc-h">Summary</h4>
                  <p className="pc-text">{p.summary_seed}</p>
                </section>
              )}

              {!!(p.technical_skills || []).length && (
                <section className="pc-sec">
                  <h4 className="pc-h">Skills</h4>
                  <div className="pc-tags">
                    {(p.technical_skills || []).map((s) => <span key={s} className="pc-tag">{s}</span>)}
                  </div>
                </section>
              )}

              {!!(p.work_history || []).length && (
                <section className="pc-sec">
                  <h4 className="pc-h">Work history</h4>
                  {(p.work_history || []).map((w, i) => (
                    <div key={i} className="pc-job">
                      <div className="pc-job-h">
                        <b>{w.legacy_role || 'Role'}</b>
                        {w.company_name ? <span className="pc-job-c"> · {w.company_name}</span> : null}
                      </div>
                      <div className="pc-job-m">{[w.duration, w.location].filter(Boolean).join(' · ')}</div>
                      {!!(w.bullets || []).length && (
                        <ul className="pc-bullets">
                          {(w.bullets || []).map((b, k) => <li key={k}>{b}</li>)}
                        </ul>
                      )}
                    </div>
                  ))}
                </section>
              )}

              {!!(p.education_history || []).length && (
                <section className="pc-sec">
                  <h4 className="pc-h">Education</h4>
                  {(p.education_history || []).map((e, i) => (
                    <div key={i} className="pc-job">
                      <div className="pc-job-h"><b>{e.degree || 'Degree'}</b>
                        {e.university ? <span className="pc-job-c"> · {e.university}</span> : null}</div>
                      <div className="pc-job-m">{[e.duration, e.location].filter(Boolean).join(' · ')}</div>
                    </div>
                  ))}
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

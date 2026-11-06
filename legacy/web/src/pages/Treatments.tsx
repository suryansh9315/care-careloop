import { useEffect, useState } from 'react';
import {
  getCondition,
  getModules,
  reloadConditions,
  saveCondition,
  type ModuleSummary,
} from '../bridge';
import { Badge, Card, Empty, Icon, MetricStrip } from '../ui';

/**
 * Treatments admin.
 *
 * A condition module is the entire extension point for a new treatment, so it
 * has to be editable without a deploy. Saving writes a FHIR PlanDefinition and
 * hot-reloads the bridge registry — the next call uses the new flow.
 *
 * The editor is raw JSON on purpose. A module carries RxNorm-coded orders and
 * band thresholds; a form that silently coerces those would be more dangerous
 * than a text area that fails loudly against the server's validator.
 */
export function TreatmentsPage(): JSX.Element {
  const [modules, setModules] = useState<ModuleSummary[]>([]);
  const [selected, setSelected] = useState<string>();
  const [draft, setDraft] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error' | 'info'; text: string }>();

  async function refreshList(): Promise<void> {
    try {
      const list = await getModules();
      setModules(list);
      if (!selected && list[0]) setSelected(list[0].id);
    } catch {
      setMessage({ kind: 'error', text: 'Could not reach the CareLoop bridge.' });
    }
  }

  useEffect(() => { void refreshList(); }, []);

  useEffect(() => {
    if (!selected) return;
    setDirty(false);
    setMessage(undefined);
    getCondition(selected)
      .then((module) => setDraft(JSON.stringify(module, null, 2)))
      .catch(() => setMessage({ kind: 'error', text: 'Could not load that module.' }));
  }, [selected]);

  async function save(): Promise<void> {
    if (!selected) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft);
    } catch (error) {
      setMessage({ kind: 'error', text: `Not valid JSON: ${(error as Error).message}` });
      return;
    }

    setBusy(true);
    setMessage(undefined);
    try {
      const result = await saveCondition(selected, parsed);
      setDirty(false);
      setMessage({
        kind: 'ok',
        text: `Saved. The bridge now serves ${result.modules} modules — no restart needed.`,
      });
      void refreshList();
    } catch (error) {
      setMessage({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Save failed.',
      });
    } finally {
      setBusy(false);
    }
  }

  async function reload(): Promise<void> {
    setBusy(true);
    try {
      const result = await reloadConditions();
      setMessage({
        kind: 'info',
        text: `Reloaded: ${result.stored} stored, ${result.total} total.`,
      });
      void refreshList();
    } catch {
      setMessage({ kind: 'error', text: 'Reload failed.' });
    } finally {
      setBusy(false);
    }
  }

  const active = modules.find((m) => m.id === selected);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Treatments</h1>
          <p className="sub">
            The condition modules the engine can run. Adding one needs no engine changes.
          </p>
        </div>
        <div className="spacer" />
        <button className="btn" onClick={reload} disabled={busy}>{Icon.trend()} Reload registry</button>
      </header>

      {modules.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <MetricStrip
            items={[
              { label: 'Modules registered', value: modules.length, tone: 'brand' },
              { label: 'Instrument items', value: modules.reduce((n, m) => n + (m.items ?? 0), 0), tone: 'info' },
              { label: 'Risk questions', value: modules.reduce((n, m) => n + (m.riskQuestions ?? 0), 0), tone: 'info' },
              { label: 'Drafted orders', value: modules.reduce((n, m) => n + (m.medications ?? 0), 0), tone: 'ok' },
            ]}
          />
        </div>
      )}

      <div className="grid-review">
        <Card title="Modules" subtitle={`${modules.length} registered`}>
          {modules.length === 0 ? (
            <Empty>Loading…</Empty>
          ) : (
            modules.map((module) => (
              <button
                key={module.id}
                className={`row ${module.id === selected ? 'selected' : ''}`}
                onClick={() => setSelected(module.id)}
              >
                <span className="grow">
                  <span className="name">{module.display}</span>
                  <span className="meta">{module.instrument}</span>
                </span>
                <span className="chev">{Icon.chevron()}</span>
              </button>
            ))
          )}
        </Card>

        {active && (
          <div className="stack">
            <Card padded>
              <h2 style={{ fontSize: 19 }}>{active.display}</h2>
              <p className="small muted" style={{ marginTop: 4 }}>{active.instrument}</p>
              <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
                <Badge tone="brand">{active.items} items</Badge>
                {active.riskQuestions !== undefined && (
                  <Badge tone="info">{active.riskQuestions} risk questions</Badge>
                )}
                {active.bands !== undefined && <Badge tone="routine">{active.bands} bands</Badge>}
                {active.medications !== undefined && (
                  <Badge tone="routine">{active.medications} drafted orders</Badge>
                )}
                {active.icd10 && <Badge tone="routine">ICD-10 {active.icd10}</Badge>}
              </div>
            </Card>

            <Card
              title="Module definition"
              subtitle="Saving publishes a PlanDefinition and hot-reloads the bridge"
              action={
                <button className="btn primary" onClick={save} disabled={!dirty || busy}>
                  {busy ? 'Saving…' : 'Save and reload'}
                </button>
              }
              padded
            >
              {message && (
                <div className={`notice ${message.kind}`} style={{ marginBottom: 14 }}>
                  {message.text}
                </div>
              )}
              <textarea
                value={draft}
                onChange={(e) => { setDraft(e.target.value); setDirty(true); }}
                spellCheck={false}
                rows={26}
                className="mono"
                style={{ resize: 'vertical', lineHeight: 1.55 }}
                aria-label="Module definition JSON"
              />
              <p className="small muted" style={{ marginTop: 12 }}>
                Bands must be contiguous and cover the whole instrument range, every band needs a
                protocol step, and one expert must be the safety reviewer. The server rejects a
                module that fails any of these rather than accepting it partially.
              </p>
            </Card>
          </div>
        )}
      </div>
    </>
  );
}

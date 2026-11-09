import { Modal, Setting, type App } from 'obsidian';
import { buildVisits, type TargetVisit } from '../core/activityVisits';
import { draftForVisit } from '../core/recordEditing';
import { formatLocalFull } from '../core/time';
import { t } from '../core/i18n';
import type { HistoryStore } from '../data/historyStore';
import { RecordEditingService } from '../services/RecordEditingService';
import { RecordEditModal } from './RecordEditModal';
import { visitNodes } from './processList';
import { renderTimelineList } from './timelineList';

export function editVisitRecord(app: App, history: HistoryStore, visit: TargetVisit, changed: () => void): void {
  new RecordEditModal(app, { draft: draftForVisit(visit, history.getRevision()), save: draft => new RecordEditingService(history).save(draft), onSaved: changed }).open();
}

/** Select the actual interval rather than silently editing a file's aggregate total. */
export function chooseFileInterval(app: App, history: HistoryStore, target: string, day: string, nowMs: number, changed: () => void): void {
  const picker = new Modal(app);
  picker.titleEl.setText(t('editRecord'));
  picker.modalEl.addClass('rtt-interval-picker');
  let currentDay = day;
  const render = (): void => {
    picker.contentEl.empty();
    new Setting(picker.contentEl).setName(t('editDay')).addText(input => input.setValue(currentDay).onChange(value => { currentDay = value; }))
      .addButton(button => button.setButtonText(t('editShowIntervals')).onClick(render));
    const start = currentDay + ' 00:00:00';
    const next = new Date(currentDay + 'T00:00:00');
    if (!Number.isFinite(next.getTime())) { picker.contentEl.createDiv({ cls: 'rtt-list-empty', text: t('noDay') }); return; }
    next.setDate(next.getDate() + 1);
    const end = [formatLocalFull(next), formatLocalFull(new Date(nowMs))].sort()[0];
    const visits = buildVisits(history.getEvents(), start, end, true).filter(visit => visit.target === target);
    if (!visits.length) { picker.contentEl.createDiv({ cls: 'rtt-list-empty', text: t('noDay') }); return; }
    renderTimelineList(picker.contentEl, visitNodes(visits, true, undefined, visit => editVisitRecord(app, history, visit, () => { changed(); render(); })));
  };
  picker.onOpen = render;
  picker.onClose = () => picker.contentEl.empty();
  picker.open();
}

import { buildVisits } from '../core/activityVisits';
import { editedSession, latestRecordEdits, recordKeyOf, sessionFingerprint, timestampMs, validateVisitDraft, visitSourceFingerprint } from '../core/recordEditing';
import type { RecordEdit, RecordEditDraft } from '../core/recordEditing';
import type { CountdownSession } from '../core/types';
import type { HistoryStore } from '../data/historyStore';
import { newRecordId } from './recordId';

/** 所有编辑入口共用的验证及保存服务 / shared validation and persistence for every editor. */
export class RecordEditingService {
  constructor(private readonly history: HistoryStore) {}

  async save(draft: RecordEditDraft): Promise<void> {
    if (!this.history.isReady()) throw new Error('记录存储尚未就绪。');
    if (draft.baseEditVersion === undefined && this.history.getRevision() !== draft.baseRevision) throw new Error('记录已发生变化，请重新打开后编辑。');
    const recordKey = recordKeyOf(draft);
    const previous = latestRecordEdits(this.history.getRecordEdits()).find(edit => edit.recordKey === recordKey);
    if (draft.baseEditVersion !== undefined && draft.baseEditVersion !== (previous?.version ?? 0)) throw new Error('这条记录已被修改，请重新打开后编辑。');
    const metadata = { recordKey, editId: newRecordId('edit'), version: (previous?.version ?? 0) + 1, updatedAt: new Date().toISOString(), sourceFingerprint: draft.sourceFingerprint };
    let edit: RecordEdit;
    if (draft.kind === 'manual' || draft.kind === 'countdown') {
      const original = (draft.kind === 'manual' ? this.history.getManualSessions() : this.history.getCountdownSessions()).find(session => session.id === draft.id);
      if (!original) throw new Error('找不到该轮记录，可能已被删除。');
      if (draft.sourceFingerprint && draft.sourceFingerprint !== sessionFingerprint(original)) throw new Error('原始记录已发生变化，请重新打开后编辑。');
      const session = editedSession(draft, original);
      edit = draft.kind === 'manual' ? { ...metadata, kind: 'manual', session }
        : { ...metadata, kind: 'countdown', session: { ...original as CountdownSession, ...session } };
    } else {
      if (draft.open) throw new Error('此时段仍在计时，请先停止或切换目标后再编辑。');
      validateVisitDraft(draft);
      if (previous && (previous.kind === 'document' || previous.kind === 'view')) {
        if (draft.originalFrom !== previous.visit.originalFrom || draft.originalTo !== previous.visit.originalTo || draft.target !== previous.visit.target) throw new Error('原始时段不可修改，请重新打开记录。');
      } else {
        const visits = buildVisits([...this.history.getEvents()], draft.originalFrom, draft.originalTo, true);
        const originalVisit = visits.find(visit => visit.target === draft.target && timestampMs(visit.to) > timestampMs(draft.originalFrom) && timestampMs(visit.from) < timestampMs(draft.originalTo));
        if (!originalVisit) throw new Error('找不到原始活动时段，请重新打开记录。');
        if (draft.sourceFingerprint && draft.sourceFingerprint !== visitSourceFingerprint(this.history.getEvents(), draft.target, draft.originalFrom, draft.originalTo)) throw new Error('原始活动时段已发生变化，请重新打开后编辑。');
      }
      edit = { ...metadata, kind: draft.kind, visit: { ...draft, note: draft.note.trim() } };
    }
    await this.history.commitRecordEdit(edit);
  }
}

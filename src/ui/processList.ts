import type { TargetVisit } from '../core/activityVisits';
import { groupRapidVisits, visitSeconds } from '../core/processPreview';
import { isPluginViewKey, pluginViewLabel } from '../core/activePath';
import { t } from '../core/i18n';
import { formatDurationParts } from '../core/time';
import { renderTimelineList, type TimelineNode, type TimelineDisclosureState } from './timelineList';

export function visitNodes(visits: readonly TargetVisit[], group = true, state?: TimelineDisclosureState, editVisit?: (visit: TargetVisit) => void): TimelineNode[] {
  const groups = group ? groupRapidVisits(visits) : visits.map(visit => [visit]);
  return groups.map(items => {
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const timeRange = first.from.slice(11, 19) + ' – ' + last.to.slice(11, 19);
    if (items.length > 1) return {
      icon: 'arrow-right-left', kind: 'switch', timeRange, key: 'rapid:' + first.from + ':' + first.target,
      title: t('rapidSwitchSummary').replace('{seconds}', String(Math.round(items.reduce((sum, visit) => sum + visitSeconds(visit), 0)))).replace('{count}', String(items.length)),
      renderDetail: container => renderTimelineList(container, visitNodes(items, false, state, editVisit), state),
    };
    const isView = isPluginViewKey(first.target);
    return {
      icon: isView ? 'app-window' : 'file-text', kind: isView ? 'view' : 'document', timeRange, key: first.from + ':' + first.target + ':' + (first.title ?? ''),
      title: first.note || first.title || (isView ? pluginViewLabel(first.target) : first.target.split('/').pop() ?? first.target),
      lines: first.disposition === 'ignored' ? [t('policyIgnored')]
        : first.disposition === 'paused' ? [t('evPause'), formatDurationParts(Math.round(first.pausedSeconds))]
          : [formatDurationParts(Math.round(first.activeSeconds + first.unfocusedSeconds))],
      onEdit: editVisit ? () => editVisit(first) : undefined,
    };
  });
}

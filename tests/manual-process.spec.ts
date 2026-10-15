import { it, expect } from 'bun:test';
import { buildManualProcess, manualFlagActiveRanges } from '../src/core/manualProcess';
import type { ManualSession } from '../src/core/types';
const session: ManualSession = {
  id:'one',startTime:'2026-10-14 09:50:00',endTime:'2026-10-14 10:20:00',durationSeconds:1500,note:'完整一轮',
  pauses:[{from:'2026-10-14 10:00:00',to:'2026-10-14 10:05:00'}],
  flags:[{atTime:'2026-10-14 09:55:00',atSeconds:300,label:'第一段'},{atTime:'2026-10-14 10:02:00',atSeconds:600,label:''},{atTime:'2026-10-14 10:10:00',atSeconds:900,label:''}],
};
it('complete round contains start, pauses, flags and stop in chronological order',()=>{
 const steps=buildManualProcess(session);
 expect(steps.map(s=>s.kind)).toEqual(['start','flag','pause','flag','resume','flag','stop']);
 expect(steps.filter(s=>s.kind==='flag').map(s=>s.intervalSeconds)).toEqual([300,300,300]);
 expect(steps.find(s=>s.kind==='pause')?.durationSeconds).toBe(300);
 expect(steps.find(s=>s.kind==='resume')?.recordedSeconds).toBe(600);
 expect(steps[steps.length-1]?.recordedSeconds).toBe(1500);
});
it('independent adjacent rounds retain independent process boundaries',()=>{
 const next={...session,id:'two',startTime:session.endTime,endTime:'2026-10-14 10:30:00',durationSeconds:600,flags:[],pauses:[]};
 expect(buildManualProcess(next).map(s=>s.kind)).toEqual(['start','stop']);
 const first=buildManualProcess(session);
 expect(first[first.length-1]?.time).toBe(buildManualProcess(next)[0].time);
});
it('flag at stop remains inside its own round',()=>{
 const steps=buildManualProcess({...session,flags:[{atTime:session.endTime,atSeconds:session.durationSeconds,label:''}]});
 expect(steps.slice(-2).map(s=>s.kind)).toEqual(['flag','stop']);
});

it('stopping while paused closes the pause without inventing a resume action',()=>{
 const steps=buildManualProcess({...session,pauses:[{from:'2026-10-14 10:00:00',to:session.endTime}]});
 expect(steps.filter(s=>s.kind==='resume')).toHaveLength(0);
 expect(steps[steps.length-1].kind).toBe('stop');
});

it('flag intervals exclude pauses, including flags placed during a pause',()=>{
 expect(manualFlagActiveRanges(session,1)).toEqual([{from:'2026-10-14 09:55:00',to:'2026-10-14 10:00:00'}]);
 expect(manualFlagActiveRanges(session,2)).toEqual([{from:'2026-10-14 10:05:00',to:'2026-10-14 10:10:00'}]);
});

it('a pause inside a flag interval splits it into multiple precise ranges',()=>{
 const record={...session,flags:[{atTime:'2026-10-14 10:10:00',atSeconds:900,label:''}]};
 expect(manualFlagActiveRanges(record,0)).toEqual([
  {from:'2026-10-14 09:50:00',to:'2026-10-14 10:00:00'},
  {from:'2026-10-14 10:05:00',to:'2026-10-14 10:10:00'},
 ]);
});

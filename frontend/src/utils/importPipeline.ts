/**
 * 离线包合并入库流水线（可恢复）。
 *
 * 背景：两个标定组在野外各自登记，离线包合并后同一仪器的标定记录会重复，
 * 仪器状态与更换提醒也跟着乱。本模块把「追加导入」做成分阶段的入库流程：
 *
 *   解析 → 核对 → 重建 → 写入 → 完成
 *
 * - 核对：按「台站码 + 序列号 + 标定日期」对账。相同记录只留一条（重复跳过）；
 *   数值不同则两边都保留，入库项挂起为「冲突待确认」，由人工确认采用哪一边。
 * - 重建：写入前从「最终有效标定记录」（台账 + 本批次已接受项，不含待确认冲突）
 *   推导仪器状态补丁与更换提醒计划，先落库再回放。
 * - 写入：逐入库项一个事务（确定性 id，put 幂等），每项落检查点；
 *   中途失败后重跑 runImportBatch 即可从检查点继续，已成功项不重复。
 * - 原台账只在写入阶段按核对结论改动；未完成批次与冲突双边都保留在暂存表中。
 */
import { createId, db, type BackupPayload } from '@/utils/db';
import { judgeCalibration, RESPONSE_VERDICTS, type Calibration, type ResponseVerdict } from '@/types/calibration';
import {
  CALIBRATION_CYCLE_DAYS,
  daysUntilDue,
  INSTRUMENT_TYPES,
  type Instrument,
  type InstrumentState,
  type InstrumentType,
} from '@/types/instrument';
import type { Replace } from '@/types/replace';
import {
  dedupeKeyOf,
  isBatchResumable,
  sameCalibrationValues,
  stageOrder,
  type ConflictSnapshot,
  type ImportBatch,
  type ImportItem,
  type InstrumentStatePatch,
  type ReminderPlanItem,
} from '@/types/importBatch';

/** 稳定散列（cyrb53）：为核对键生成确定性 id，保证重试幂等 */
export function hashText(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return ((h2 >>> 0).toString(36) + (h1 >>> 0).toString(36)).slice(0, 14);
}

/** 入库标定记录的确定性 id：同一核对键重复写入只会覆盖同一行 */
export function deterministicCalibrationId(dedupeKey: string): string {
  return `cal_imp_${hashText(`cal|${dedupeKey}`)}`;
}

/** 自动登记仪器的确定性 id */
function deterministicInstrumentId(serialNo: string): string {
  return `ins_imp_${hashText(`ins|${serialNo.trim()}`)}`;
}

/** 自动重建更换提醒的确定性 id */
function deterministicReminderId(instrumentId: string): string {
  return `rpl_imp_${hashText(`rpl|${instrumentId}`)}`;
}

export interface StartImportOptions {
  fileName: string;
  /** 来源标识（标定组），用于冲突双边对比展示 */
  source: string;
  /** 原始文件文本，用于内容指纹（同一离线包重复选择时续传原批次） */
  fileText: string;
}

export interface ImportRunHooks {
  /** 测试钩子：写入某个入库项之前触发，可抛错模拟中途失败 */
  beforeApplyItem?: (item: ImportItem) => void | Promise<void>;
}

/* ------------------------------ 解析 ------------------------------ */

function coerceNumber(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : NaN;
}

function coerceVerdict(raw: unknown, type: string, sensitivity: number, selfNoise: number): ResponseVerdict {
  return RESPONSE_VERDICTS.includes(raw as ResponseVerdict)
    ? (raw as ResponseVerdict)
    : judgeCalibration(type, sensitivity, selfNoise);
}

function coerceInstrumentType(raw: unknown): InstrumentType {
  return INSTRUMENT_TYPES.includes(raw as InstrumentType) ? (raw as InstrumentType) : '宽频带';
}

/**
 * 解析离线包并创建入库批次（含全部入库项暂存行）。
 * 同一文件重复导入且原批次未完成时，直接返回原批次以便续传。
 */
export async function startImportBatch(
  payload: BackupPayload,
  options: StartImportOptions
): Promise<ImportBatch> {
  const fingerprint = hashText(options.fileText);
  const existing = await db.importBatches.where('fingerprint').equals(fingerprint).first();
  if (existing && existing.status !== '已完成') return existing;

  const now = Date.now();
  const batchId = createId('imp');
  const source = options.source.trim() || options.fileName || '离线包';

  const stationById = new Map(payload.stations.map((row) => [row.id, row]));
  const instrumentById = new Map(payload.instruments.map((row) => [row.id, row]));

  const normalized = payload.calibrations.map((row, index) => {
    const instrument = instrumentById.get(row.instrumentId);
    const station = instrument ? stationById.get(instrument.stationId) : undefined;
    const stationCode = station?.code.trim() ?? '';
    const serialNo = instrument?.serialNo.trim() ?? '';
    const date = String(row.date ?? '').slice(0, 10);
    const sensitivity = coerceNumber(row.sensitivity);
    const selfNoise = coerceNumber(row.selfNoise);
    const type = coerceInstrumentType(instrument?.type);
    return {
      row,
      index,
      stationCode,
      serialNo,
      date,
      sensitivity,
      selfNoise,
      responseVerdict: coerceVerdict(row.responseVerdict, type, sensitivity, selfNoise),
      draft: instrument
        ? {
            stationCode,
            stationId: '',
            type,
            model: String(instrument.model ?? ''),
            installDate: String(instrument.installDate ?? '').slice(0, 10) || date,
          }
        : null,
      referable: Boolean(instrument && station),
    };
  });

  // 稳定排序：核对键 → 原文件顺序，保证同一离线包多次解析结果一致
  normalized.sort(
    (a, b) =>
      dedupeKeyOf(a.stationCode, a.serialNo, a.date).localeCompare(
        dedupeKeyOf(b.stationCode, b.serialNo, b.date)
      ) || a.index - b.index
  );

  const items: ImportItem[] = normalized.map((entry, seq) => ({
    id: createId('itm'),
    batchId,
    seq,
    dedupeKey: dedupeKeyOf(entry.stationCode, entry.serialNo, entry.date),
    stationCode: entry.stationCode,
    serialNo: entry.serialNo,
    date: entry.date,
    sensitivity: entry.sensitivity,
    selfNoise: entry.selfNoise,
    responseVerdict: entry.responseVerdict,
    operator: String(entry.row.operator ?? ''),
    agency: String(entry.row.agency ?? ''),
    remark: String(entry.row.remark ?? ''),
    source,
    instrumentId: '',
    instrumentPlan: entry.referable ? '匹配台账' : '未解析',
    instrumentDraft: entry.draft,
    resolution: '待核对',
    status: entry.referable ? '待写入' : '失败',
    conflictWith: null,
    error: entry.referable ? '' : '离线包缺少仪器或台站参照，无法核对',
    createdAt: now,
    updatedAt: now,
  }));

  const batch: ImportBatch = {
    id: batchId,
    fingerprint,
    fileName: options.fileName,
    source,
    status: '待入库',
    stage: '核对',
    cursor: 0,
    totalItems: items.length,
    insertedCount: 0,
    skippedCount: 0,
    conflictCount: 0,
    failedCount: items.filter((item) => item.status === '失败').length,
    statePatches: [],
    reminders: [],
    rebuiltInstrumentCount: 0,
    createdReminderCount: 0,
    error: '',
    createdAt: now,
    updatedAt: now,
  };

  await db.transaction('rw', [db.importBatches, db.importItems], async () => {
    await db.importBatches.put(batch);
    await db.importItems.bulkPut(items);
  });
  return batch;
}

/* ------------------------------ 核对 ------------------------------ */

interface EffectiveCalib {
  calibrationId: string;
  sensitivity: number;
  selfNoise: number;
  responseVerdict: ResponseVerdict;
  operator: string;
  agency: string;
  source: string;
}

/** 核对阶段：逐入库项与台账（及本批次先到项）比对，产出核对结论 */
async function reconcileStage(batchId: string): Promise<void> {
  const items = (await db.importItems.where('batchId').equals(batchId).toArray()).sort(
    (a, b) => a.seq - b.seq
  );
  const [stations, instruments, calibrations] = await Promise.all([
    db.stations.toArray(),
    db.instruments.toArray(),
    db.calibrations.toArray(),
  ]);

  const stationByCode = new Map(stations.map((row) => [row.code.trim(), row]));
  const instrumentBySerial = new Map(instruments.map((row) => [row.serialNo.trim(), row]));
  // 有效视图：先装台账，随核对推进补入本批次已接受项，使批次内重复也能被核对
  const effective = new Map<string, EffectiveCalib>();
  calibrations.forEach((row) => {
    effective.set(`${row.instrumentId}|${row.date}`, {
      calibrationId: row.id,
      sensitivity: row.sensitivity,
      selfNoise: row.selfNoise,
      responseVerdict: row.responseVerdict,
      operator: row.operator,
      agency: row.agency,
      source: '台账',
    });
  });

  const now = Date.now();
  for (const item of items) {
    if (item.status === '失败') continue;
    const station = stationByCode.get(item.stationCode);
    if (!station) {
      item.status = '失败';
      item.error = `台站码「${item.stationCode}」在台账中不存在`;
      item.updatedAt = now;
      continue;
    }
    const instrument = instrumentBySerial.get(item.serialNo);
    if (instrument) {
      item.instrumentPlan = '匹配台账';
      item.instrumentId = instrument.id;
    } else {
      item.instrumentPlan = '新登记';
      item.instrumentId = deterministicInstrumentId(item.serialNo);
      if (item.instrumentDraft) item.instrumentDraft.stationId = station.id;
    }

    const key = `${item.instrumentId}|${item.date}`;
    const existing = effective.get(key);
    if (!existing) {
      item.resolution = '新增';
      item.status = '待写入';
      effective.set(key, {
        calibrationId: deterministicCalibrationId(item.dedupeKey),
        sensitivity: item.sensitivity,
        selfNoise: item.selfNoise,
        responseVerdict: item.responseVerdict,
        operator: item.operator,
        agency: item.agency,
        source: item.source,
      });
    } else if (sameCalibrationValues(existing, item)) {
      item.resolution = '重复跳过';
      item.status = '已跳过';
    } else {
      item.resolution = '冲突待确认';
      item.status = '待确认';
      const snapshot: ConflictSnapshot = {
        calibrationId: existing.calibrationId,
        sensitivity: existing.sensitivity,
        selfNoise: existing.selfNoise,
        responseVerdict: existing.responseVerdict,
        operator: existing.operator,
        agency: existing.agency,
        source: existing.source,
      };
      item.conflictWith = snapshot;
    }
    item.updatedAt = now;
  }

  await db.transaction('rw', [db.importItems, db.importBatches], async () => {
    await db.importItems.bulkPut(items);
    await db.importBatches.update(batchId, { stage: '重建', updatedAt: now });
  });
}

/* ------------------------------ 重建 ------------------------------ */

interface RebuildOutcome {
  statePatches: InstrumentStatePatch[];
  reminders: ReminderPlanItem[];
  rebuiltInstrumentCount: number;
}

/**
 * 由最终有效标定记录推导单台仪器的状态补丁与更换提醒。
 * 已停用仪器不改动状态、不生成提醒。
 */
function planInstrument(
  instrument: Pick<Instrument, 'id' | 'serialNo' | 'installDate' | 'state'>,
  stationCode: string,
  effectiveCals: Array<Pick<Calibration, 'date' | 'responseVerdict'>>,
  hasOpenReminder: boolean,
  today: string
): { patch: InstrumentStatePatch | null; reminder: ReminderPlanItem | null } {
  const latest = [...effectiveCals].sort((a, b) => b.date.localeCompare(a.date))[0] ?? null;
  const dueInDays = daysUntilDue(latest ? latest.date : null, instrument.installDate);
  const overdue = dueInDays < 0;
  const unqualified = latest?.responseVerdict === '不合格';

  if (instrument.state === '已停用') return { patch: null, reminder: null };

  let target: InstrumentState = '在用';
  let reason = '最近一次标定合格且在标定周期内';
  if (unqualified) {
    target = '待标定';
    reason = '最近一次标定结论不合格';
  } else if (overdue) {
    target = '待标定';
    reason = `超过标定周期 ${CALIBRATION_CYCLE_DAYS} 天未标定`;
  }

  const patch: InstrumentStatePatch | null =
    target === instrument.state
      ? null
      : {
          instrumentId: instrument.id,
          serialNo: instrument.serialNo,
          stationCode,
          from: instrument.state,
          to: target,
          reason,
        };

  const needReminder = unqualified || overdue;
  const reminder: ReminderPlanItem | null =
    needReminder && !hasOpenReminder
      ? {
          id: deterministicReminderId(instrument.id),
          instrumentId: instrument.id,
          serialNo: instrument.serialNo,
          stationCode,
          reason: unqualified ? '最近一次标定不合格，请安排更换' : '超期未标定，请安排标定或更换',
          date: today,
        }
      : null;

  return { patch, reminder };
}

/** 重建阶段：写入前从最终有效标定记录生成仪器状态补丁与更换提醒计划 */
async function rebuildStage(batchId: string): Promise<void> {
  const items = await db.importItems.where('batchId').equals(batchId).toArray();
  const accepted = items.filter(
    (item) => item.status === '待写入' && (item.resolution === '新增' || item.resolution === '采用现场值')
  );
  const [instruments, calibrations, replaces, stations] = await Promise.all([
    db.instruments.toArray(),
    db.calibrations.toArray(),
    db.replaces.toArray(),
    db.stations.toArray(),
  ]);
  const stationById = new Map(stations.map((row) => [row.id, row]));
  const instrumentById = new Map(instruments.map((row) => [row.id, row]));

  // 最终有效标定记录：台账现状 + 本批次待写入项。
  // 按记录 id 覆盖：冲突「采用现场值」时现场值替换台账侧同一条，而不是与之并存。
  const effectiveByInstrument = new Map<string, Map<string, Pick<Calibration, 'date' | 'responseVerdict'>>>();
  const putEffective = (instrumentId: string, calId: string, value: Pick<Calibration, 'date' | 'responseVerdict'>): void => {
    const map = effectiveByInstrument.get(instrumentId) ?? new Map();
    map.set(calId, value);
    effectiveByInstrument.set(instrumentId, map);
  };
  calibrations.forEach((row) => {
    putEffective(row.instrumentId, row.id, { date: row.date, responseVerdict: row.responseVerdict });
  });
  accepted.forEach((item) => {
    const calId =
      item.resolution === '采用现场值' && item.conflictWith
        ? item.conflictWith.calibrationId
        : deterministicCalibrationId(item.dedupeKey);
    putEffective(item.instrumentId, calId, { date: item.date, responseVerdict: item.responseVerdict });
  });

  const openReminderInstrumentIds = new Set(
    replaces.filter((row) => row.state !== '已复核').map((row) => row.instrumentId)
  );
  const today = new Date().toISOString().slice(0, 10);

  const outcome: RebuildOutcome = { statePatches: [], reminders: [], rebuiltInstrumentCount: 0 };
  const affectedIds = new Set(accepted.map((item) => item.instrumentId));
  affectedIds.forEach((instrumentId) => {
    const persisted = instrumentById.get(instrumentId);
    const sourceItem = accepted.find((item) => item.instrumentId === instrumentId);
    // 新登记仪器在写入阶段才落库，重建时按草稿合成视图
    const instrument = persisted ??
      (sourceItem?.instrumentDraft
        ? {
            id: instrumentId,
            serialNo: sourceItem.serialNo,
            installDate: sourceItem.instrumentDraft.installDate,
            state: '在用' as InstrumentState,
          }
        : null);
    if (!instrument) return;
    const stationCode =
      (persisted ? stationById.get(persisted.stationId)?.code : undefined) ??
      sourceItem?.stationCode ??
      '';
    const { patch, reminder } = planInstrument(
      instrument,
      stationCode,
      [...(effectiveByInstrument.get(instrumentId)?.values() ?? [])],
      openReminderInstrumentIds.has(instrumentId),
      today
    );
    if (patch) outcome.statePatches.push(patch);
    if (reminder) outcome.reminders.push(reminder);
  });
  outcome.rebuiltInstrumentCount = affectedIds.size;

  await db.importBatches.update(batchId, {
    stage: '写入',
    statePatches: outcome.statePatches,
    reminders: outcome.reminders,
    rebuiltInstrumentCount: outcome.rebuiltInstrumentCount,
    updatedAt: Date.now(),
  } as never);
}

/* ------------------------------ 写入 ------------------------------ */

/** 单条入库项写入：仪器（如需）+ 标定记录 + 检查点，同事务提交 */
async function applyItem(batchId: string, item: ImportItem): Promise<void> {
  const now = Date.now();
  await db.transaction('rw', [db.instruments, db.calibrations, db.importItems, db.importBatches], async () => {
    if (item.instrumentPlan === '新登记' && item.instrumentDraft) {
      const existing = await db.instruments.get(item.instrumentId);
      if (!existing) {
        const row: Instrument = {
          id: item.instrumentId,
          stationId: item.instrumentDraft.stationId,
          type: item.instrumentDraft.type,
          model: item.instrumentDraft.model,
          serialNo: item.serialNo,
          installDate: item.instrumentDraft.installDate,
          state: '在用',
          remark: `离线包合并自动登记（${item.source}）`,
          createdAt: now,
          updatedAt: now,
        };
        await db.instruments.put(row);
      }
    }

    if (item.resolution === '采用现场值' && item.conflictWith) {
      // 冲突确认：把现场值回写到台账侧原记录（保留原 id 与创建时间）
      const existing = await db.calibrations.get(item.conflictWith.calibrationId);
      if (existing) {
        await db.calibrations.put({
          ...existing,
          sensitivity: item.sensitivity,
          selfNoise: item.selfNoise,
          responseVerdict: item.responseVerdict,
          operator: item.operator,
          agency: item.agency,
          remark: item.remark,
          updatedAt: now,
        });
      } else {
        await putDeterministicCalibration(item, now);
      }
    } else {
      await putDeterministicCalibration(item, now);
    }

    await db.importItems.update(item.id, { status: '已写入', updatedAt: now } as never);
    const batch = await db.importBatches.get(batchId);
    await db.importBatches.update(batchId, {
      cursor: Math.max(batch?.cursor ?? 0, item.seq + 1),
      insertedCount: (batch?.insertedCount ?? 0) + 1,
      updatedAt: now,
    } as never);
  });
}

/** 以确定性 id 写入标定记录：重试只覆盖同一行，不产生重复 */
async function putDeterministicCalibration(item: ImportItem, now: number): Promise<void> {
  const id = deterministicCalibrationId(item.dedupeKey);
  const existing = await db.calibrations.get(id);
  const row: Calibration = {
    id,
    instrumentId: item.instrumentId,
    date: item.date,
    sensitivity: item.sensitivity,
    selfNoise: item.selfNoise,
    responseVerdict: item.responseVerdict,
    operator: item.operator,
    agency: item.agency,
    remark: item.remark,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await db.calibrations.put(row);
}

/** 写入阶段：逐入库项落检查点，随后回放状态补丁与更换提醒计划 */
async function applyStage(batchId: string, hooks: ImportRunHooks): Promise<void> {
  const pending = (await db.importItems.where('batchId').equals(batchId).toArray())
    .filter((item) => item.status === '待写入')
    .sort((a, b) => a.seq - b.seq);

  for (const item of pending) {
    await hooks.beforeApplyItem?.(item);
    await applyItem(batchId, item);
  }

  const batch = await db.importBatches.get(batchId);
  if (!batch) throw new Error('入库批次不存在');
  const now = Date.now();

  await db.transaction('rw', [db.instruments, db.replaces, db.importBatches], async () => {
    // 状态补丁：仅当仪器当前状态仍与重建时一致才应用，不覆盖人工后续改动
    for (const patch of batch.statePatches) {
      const instrument = await db.instruments.get(patch.instrumentId);
      if (instrument && instrument.state === patch.from && instrument.state !== patch.to) {
        await db.instruments.update(patch.instrumentId, { state: patch.to, updatedAt: now } as never);
      }
    }
    // 更换提醒：确定性 id + 写入前再查未闭环提醒，重复执行不产生重复提醒
    let created = 0;
    for (const reminder of batch.reminders) {
      const existing = await db.replaces.get(reminder.id);
      const open = await db.replaces
        .where('instrumentId')
        .equals(reminder.instrumentId)
        .filter((row) => row.state !== '已复核')
        .first();
      if (!existing && !open) {
        const row: Replace = {
          id: reminder.id,
          instrumentId: reminder.instrumentId,
          reason: reminder.reason,
          newSerialNo: '',
          date: reminder.date,
          state: '待更换',
          operator: '系统自动',
          remark: '离线包合并后由最终有效标定记录重建',
          createdAt: now,
          updatedAt: now,
        };
        await db.replaces.put(row);
        created += 1;
      }
    }
    await db.importBatches.update(batchId, { createdReminderCount: created, updatedAt: now } as never);
  });
}

/* ------------------------------ 完成 ------------------------------ */

/** 完成阶段：按入库项实况汇总计数，有未确认冲突则挂起为「待确认」 */
async function finalizeBatch(batchId: string): Promise<ImportBatch> {
  const items = await db.importItems.where('batchId').equals(batchId).toArray();
  const countOf = (status: ImportItem['status']): number =>
    items.filter((item) => item.status === status).length;
  const conflictCount = countOf('待确认');
  await db.importBatches.update(batchId, {
    stage: '完成',
    status: conflictCount > 0 ? '待确认' : '已完成',
    insertedCount: countOf('已写入'),
    skippedCount: countOf('已跳过'),
    conflictCount,
    failedCount: countOf('失败'),
    updatedAt: Date.now(),
  } as never);
  const batch = await db.importBatches.get(batchId);
  if (!batch) throw new Error('入库批次不存在');
  return batch;
}

/* ------------------------------ 调度 ------------------------------ */

const runningBatchIds = new Set<string>();

async function patchBatchStatus(batchId: string, patch: Partial<ImportBatch>): Promise<ImportBatch> {
  await db.importBatches.update(batchId, { ...patch, updatedAt: Date.now() } as never);
  const batch = await db.importBatches.get(batchId);
  if (!batch) throw new Error('入库批次不存在');
  return batch;
}

/**
 * 执行（或恢复）入库批次：只运行当前检查点及之后的阶段。
 * 失败时批次置为「已失败」并保留检查点，再次调用即可续跑；已成功项不重复。
 */
export async function runImportBatch(batchId: string, hooks: ImportRunHooks = {}): Promise<ImportBatch> {
  const current = await db.importBatches.get(batchId);
  if (!current) throw new Error('入库批次不存在');
  if (!isBatchResumable(current)) return current;
  if (runningBatchIds.has(batchId)) return current;

  runningBatchIds.add(batchId);
  try {
    let batch = await patchBatchStatus(batchId, { status: '入库中', error: '' });
    try {
      if (stageOrder(batch.stage) <= stageOrder('核对')) await reconcileStage(batchId);
      if (stageOrder(batch.stage) <= stageOrder('重建')) await rebuildStage(batchId);
      if (stageOrder(batch.stage) <= stageOrder('写入')) await applyStage(batchId, hooks);
      batch = await finalizeBatch(batchId);
      return batch;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return await patchBatchStatus(batchId, { status: '已失败', error: message });
    }
  } finally {
    runningBatchIds.delete(batchId);
  }
}

/**
 * 确认冲突入库项：
 * - 采用现场值：把离线包数值回写到台账侧原标定记录；
 * - 保留台账值：入库项跳过，台账不动。
 * 确认后自动重跑重建与写入，刷新仪器状态与更换提醒。
 */
export async function resolveImportConflict(
  itemId: string,
  choice: '采用现场值' | '保留台账值'
): Promise<ImportBatch> {
  const item = await db.importItems.get(itemId);
  if (!item) throw new Error('入库项不存在');
  if (item.status !== '待确认') {
    const batch = await db.importBatches.get(item.batchId);
    if (!batch) throw new Error('入库批次不存在');
    return batch;
  }
  const now = Date.now();
  await db.importItems.update(itemId, {
    resolution: choice === '采用现场值' ? '采用现场值' : '保留台账值',
    status: choice === '采用现场值' ? '待写入' : '已跳过',
    updatedAt: now,
  } as never);
  // 回到重建阶段：把新确认的数值纳入最终有效标定记录，重算状态与提醒后再写入
  await db.importBatches.update(item.batchId, { stage: '重建', status: '入库中', updatedAt: now } as never);
  return runImportBatch(item.batchId);
}

/** 清除批次及其入库项暂存行（不影响已入库的台账数据） */
export async function discardImportBatch(batchId: string): Promise<void> {
  await db.transaction('rw', [db.importBatches, db.importItems], async () => {
    await db.importItems.where('batchId').equals(batchId).delete();
    await db.importBatches.delete(batchId);
  });
}
